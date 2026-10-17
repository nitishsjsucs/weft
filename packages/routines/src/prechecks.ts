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
import { prechecks as w4People } from "./wave4/people";
import { prechecks as w4Agent } from "./wave4/agent";
import { prechecks as w4Admin } from "./wave4/admin";

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

const AGENCY_JURISDICTION: Record<string, string> = { irs: "US", ca_edd: "CA", ny_dtf: "NY", ny_dol: "NY", tx_twc: "TX", co_dor: "CO", co_cdle: "CO" };

/** notices.get (t2-world): data.notice.{kind, tax_account_id, extracted: { agency, kind, taxAccountId, effectiveFrom, respondBy, rates: [{ code, oldRate, newRate }] }}. */
export const agencyNotice: Precheck = async (ctx, exec) => {
  const payload = obj(ctx.payload);
  const noticeId = str(payload.notice_id);
  if (!noticeId) return { action: "skip", reason: "The event carries no notice id." };
  const data = await read(exec, ctx.companyId, "notices.get", { notice_id: noticeId });
  if (!data) return { action: "skip", reason: `Notice ${noticeId} could not be read.` };
  const notice = obj(pick(data, "notice") ?? data);
  const ex = obj(pick(notice, "extracted"));
  const kind = str(pick(notice, "kind")) ?? str(pick(ex, "kind"));
  const rates = arr(pick(ex, "rates"));
  const change = rates.find((r) => r.code === "sui") ?? rates[0];
  const rate = change ? str(pick(change, "newRate", "new_rate")) : null;
  const code = change ? str(pick(change, "code")) : null;
  const effective = str(pick(ex, "effectiveFrom", "effective_from"));
  const account = str(pick(notice, "tax_account_id")) ?? str(pick(ex, "taxAccountId"));
  if (kind !== "rate_change" || !rate || !code || !effective || !account) return { action: "skip", reason: `Notice ${noticeId} is not a rate change with an account, code, rate and effective date.` };
  const jurisdiction = AGENCY_JURISDICTION[str(pick(ex, "agency")) ?? str(pick(notice, "agency")) ?? ""] ?? null;
  const impact = jurisdiction ? await read(exec, ctx.companyId, "tax.rate_change_impact", { jurisdiction, code, new_rate: rate, effective_from: effective }) : null;
  return {
    action: "run", severity: "interrupt", subjectRefs: [noticeId, account],
    findings: { notice: { id: noticeId, agency: pick(ex, "agency"), kind, code, old_rate: change ? pick(change, "oldRate") : null, new_rate: rate, effective_from: effective, respond_by: pick(ex, "respondBy") }, impact },
    derivedArgs: {
      notice_id: noticeId,
      "tax.rate_change_impact": jurisdiction ? { jurisdiction, code, new_rate: rate, effective_from: effective } : null,
      "tax.update_rate": { tax_account_id: account, code, rate, effective_from: effective, source_notice_id: noticeId },
      "notices.draft_response": { notice_id: noticeId },
      "notices.send_response": { notice_id: noticeId },
    },
  };
};

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

export const peopleDigest: Precheck = async (ctx, exec) => {
  const people = await read(exec, ctx.companyId, "people.search", { status: "active", limit: 50 });
  // comms.send_message grounds its numbers against company facts (employees by work state, not every active worker,
  // since contractors carry no work state), so the digest cites the per-state counts and their sum.
  const byState = Object.entries(obj(pick(people ?? {}, "by_state")))
    .map(([state, n]) => [state, Number(n)] as const).filter(([, n]) => Number.isFinite(n) && n > 0).sort(([a], [b]) => a.localeCompare(b));
  const total = Number(pick(people ?? {}, "total", "count") ?? arr(pick(people ?? {}, "items", "workers", "results")).length);
  const headcount = byState.length ? byState.reduce((sum, [, n]) => sum + n, 0) : total;
  const slot = str(obj(ctx.payload).slot) ?? ctx.triggerRef;
  const states = byState.map(([state, n]) => `${state} ${n}`).join(", ");
  const text = byState.length
    ? `Weekly people digest: ${headcount} employees by work state (${states}). Open items are in the Weft inbox.`
    : `Weekly people digest: ${headcount} active people. Open items are in the Weft inbox.`;
  return { action: "run", severity: "digest", subjectRefs: [], findings: { headcount, by_state: Object.fromEntries(byState), slot }, derivedArgs: { slot, "comms.send_message": { channel: "#people-ops", text } } };
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
