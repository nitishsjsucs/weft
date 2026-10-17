// Deterministic prechecks (harness 8, SPEC 9.7): code first. Each returns skip (recorded skipped, zero tokens) or run
// with findings and the exact proposal arguments (derivedArgs, keyed by registry name), so the model chooses,
// explains and proposes. They read only through the ReadOnlyExecutor. Field names of T1 and T2 read results are read
// tolerantly (several spellings) until the integrator pins them.
import type { Precheck, PrecheckResult, ReadOnlyExecutor, ToolOutcome } from "@weft/contracts";
import { TZ } from "./prebuilt";
import { prechecks as w2Onboarding } from "./wave2/onboarding";
import { prechecks as w2Benefits } from "./wave2/benefits";
import { prechecks as w2Memory } from "./wave2/memory";
import { prechecks as w3Expenses } from "./wave3/expenses";
import { prechecks as w3TimeOff } from "./wave3/time-off";
import { prechecks as w3Parity } from "./wave3/parity";
import { prechecks as w3IntegrationsHr } from "./wave3/integrations-hr";
import { prechecks as w3Screening } from "./wave3/screening";
import { prechecks as w4Compliance } from "./wave4/compliance";
import { outThisWeekLine, prechecks as w4People } from "./wave4/people";
import { prechecks as w4Agent } from "./wave4/agent";
import { prechecks as w4Admin } from "./wave4/admin";
import { agencyNotice } from "./agency-notice";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const pick = (o: Obj, ...keys: string[]): unknown => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);

async function read(exec: ReadOnlyExecutor, companyId: string, command: string, args: Obj): Promise<Obj | null> {
  const o: ToolOutcome = await exec.exec(companyId, command, { response_format: "concise", ...args });
  return o.ok && o.status === "done" ? obj(o.data) : null;
}

/** The calendar date of an ISO instant in Pacific time ("2026-10-29T00:00:00Z" is "2026-10-28"). */
export function ptDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** rt_agency_notice: every notice kind (wave 4 round 1), in agency-notice.ts. */
export { agencyNotice };

function templateExplanation(row: Obj): string {
  const flags = arr(pick(row, "flags"));
  const rule = str(pick(row, "rule", "code")) ?? (flags.map((f) => str(f.rule)).filter(Boolean).join(", ") || "FLAG");
  const who = str(pick(row, "worker", "worker_display", "name")) ?? "This worker";
  const before = str(pick(row, "before_display"));
  const after = str(pick(row, "after_display"));
  const change = before && after ? ` from ${before} to ${after}` : "";
  return `${who}: ${rule.replace(/_/g, " ").toLowerCase()}${change}. Review the evidence on the paycheck before approving.`;
}

export const prePayroll: Precheck = async (ctx, exec) => {
  const payload = obj(ctx.payload);
  const manual = payload.manual === true;
  const list = await read(exec, ctx.companyId, "payroll.list_runs", { status: "draft" });
  const drafts = arr(pick(list ?? {}, "runs", "items", "data")).filter((r) => (str(r.status) ?? "draft") === "draft");
  const today = ptDate(ctx.now);
  const idOf = (r: Obj) => str(pick(r, "run_id", "id"));
  const due = manual
    ? drafts.filter((r) => !payload.run_id || idOf(r) === payload.run_id)
    : drafts.filter((r) => { const d = str(pick(r, "approval_deadline", "approval_deadline_at")); return d !== null && ptDate(d) === today; });
  const run = due[0];
  const runId = run ? idOf(run) : null;
  if (!run || !runId) return { action: "skip", reason: manual ? "No draft pay run to review." : `No draft has its approval deadline on ${today} PT.` };
  const detail = await read(exec, ctx.companyId, "payroll.get_run", { run_id: runId, flagged_only: true });
  const flagged = arr(pick(detail ?? {}, "flagged", "flagged_rows", "flags"));
  // payroll.explain_flags (t1-payroll) saves its own template when an item has no explanation.
  const items = flagged.map((row) => ({ paycheck_id: str(pick(row, "paycheck_id", "id")) })).filter((i) => i.paycheck_id);
  const rules = flagged.map((row) => ({ paycheck_id: pick(row, "paycheck_id"), worker: pick(row, "worker"), rules: arr(pick(row, "flags")).map((f) => f.rule), summary: templateExplanation(row) }));
  return {
    action: "run", severity: "interrupt", subjectRefs: [runId],
    findings: { run_id: runId, flagged_count: flagged.length, approval_deadline: pick(run, "approval_deadline"), flagged: rules },
    derivedArgs: { run_id: runId, "payroll.get_run": { run_id: runId, flagged_only: true }, "payroll.submit_run": { run_id: runId, exclude_blocked: true }, "payroll.explain_flags": { run_id: runId, items } },
  };
};

/** people.get (t2-world): data.worker.{name, work_state}; tax.list_registrations: data.accounts[].{id, jurisdiction, status}. */
export const newHire: Precheck = async (ctx, exec) => {
  const payload = obj(ctx.payload);
  const workerId = str(payload.worker_id);
  if (!workerId) return { action: "skip", reason: "The event carries no worker id." };
  const pdata = (await read(exec, ctx.companyId, "people.get", { worker_id: workerId })) ?? {};
  const person = obj(pick(pdata, "worker") ?? pdata);
  const state = str(pick(person, "work_state", "state"));
  const regs = state ? await read(exec, ctx.companyId, "tax.list_registrations", { jurisdiction: state }) : null;
  const toRegister = arr(pick(regs ?? {}, "accounts", "registrations")).filter((a) => a.jurisdiction === state && (a.status === "not_registered" || a.status === "needs_info"));
  const name = str(pick(person, "name", "display")) ?? "our new teammate";
  return {
    action: "run", severity: "interrupt", subjectRefs: [workerId],
    findings: { worker_id: workerId, state, to_register: toRegister.map((a) => ({ id: a.id, agency: a.agency, status: a.status })) },
    derivedArgs: {
      worker_id: workerId,
      register_count: toRegister.length,
      "it.create_account": ["chat", "google_ws", "github"].map((system) => ({ worker_id: workerId, system })),
      "comms.send_message": { channel: "#new-hires", text: `Please welcome ${name} to the team.` },
      "tax.register_state_account": toRegister.map((a) => ({ tax_account_id: a.id })),
      "it.order_device": { worker_id: workerId },
    },
  };
};

/** The worker statuses that count as current employees (comms grounding's employees_count uses the same set). */
export const DIGEST_STATUSES = ["active", "onboarding", "offboarding"] as const;

export const peopleDigest: Precheck = async (ctx, exec) => {
  // comms.send_message grounds its numbers against company facts: employees by work state and the employee count in
  // active, onboarding and offboarding status (contractors carry no work state). Wave 4 round 1 (FM10, RT-04): the
  // digest counts with that same status filter, one people.search per status, so a new hire who is still onboarding
  // is counted and the total matches the fact the post is checked against.
  const byStateMap = new Map<string, number>();
  let read0: Obj | null = null;
  let counted = 0;
  for (const status of DIGEST_STATUSES) {
    const people = await read(exec, ctx.companyId, "people.search", { status, limit: 1 });
    if (!people) continue;
    counted++;
    if (status === "active") read0 = people;
    for (const [state, n] of Object.entries(obj(pick(people, "by_state")))) {
      const v = Number(n);
      if (Number.isFinite(v) && v > 0) byStateMap.set(state, (byStateMap.get(state) ?? 0) + v);
    }
  }
  const byState = [...byStateMap.entries()].sort(([a], [b]) => a.localeCompare(b));
  const total = Number(pick(read0 ?? {}, "total", "count") ?? arr(pick(read0 ?? {}, "items", "workers", "results")).length);
  const headcount = byState.length ? byState.reduce((sum, [, n]) => sum + n, 0) : total;
  const slot = str(obj(ctx.payload).slot) ?? ctx.triggerRef;
  const states = byState.map(([state, n]) => `${state} ${n}`).join(", ");
  const text = byState.length
    ? `Weekly people digest: ${headcount} employees by work state (${states}). Open items are in the Weft inbox.`
    : `Weekly people digest: ${headcount} active people. Open items are in the Weft inbox.`;
  // wave 4 (w4-parity-people, R6): the out-this-week line from the time-off ledger; null on a failed read, so the digest still posts.
  const out = await outThisWeekLine(ctx, exec);
  return { action: "run", severity: "digest", subjectRefs: [], findings: { headcount, by_state: Object.fromEntries(byState), statuses: [...DIGEST_STATUSES], status_reads: counted, slot }, derivedArgs: { slot, "comms.send_message": { channel: "#people-ops", text: `${text}${out ? ` ${out}` : ""}` } } };
};

export const openApprovals: Precheck = async (ctx, exec) => {
  const list = await read(exec, ctx.companyId, "actions.list", { kind: "proposals", status: "pending" });
  const count = Number(pick(list ?? {}, "total", "count") ?? arr(pick(list ?? {}, "items", "data")).length);
  const channel = str(obj(ctx.payload).channel) ?? "#people-ops";
  return { action: "run", severity: "digest", subjectRefs: [], findings: { open_approvals: count }, derivedArgs: { "comms.send_message": { channel, text: `Open approvals: ${count}. Review them in the Weft inbox.` } } };
};

export const PRECHECKS: Record<string, Precheck> = {
  agency_notice: agencyNotice, pre_payroll: prePayroll, new_hire: newHire, people_digest: peopleDigest, open_approvals: openApprovals,
  ...w2Onboarding, ...w2Benefits, ...w2Memory,   // wave 2
  ...w3Expenses, ...w3TimeOff, ...w3Parity, ...w3IntegrationsHr, ...w3Screening,   // wave 3
  ...w4Compliance, ...w4People, ...w4Agent, ...w4Admin,   // wave 4
};

export async function runPrecheck(name: string | null, ctx: Parameters<Precheck>[0], exec: ReadOnlyExecutor): Promise<PrecheckResult> {
  if (!name) return { action: "run", severity: "digest", subjectRefs: [], findings: null, derivedArgs: null };
  const p = PRECHECKS[name];
  if (!p) return { action: "skip", reason: `Unknown precheck ${name}.` };
  return p(ctx, exec);
}
