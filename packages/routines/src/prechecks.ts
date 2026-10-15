// Deterministic prechecks (harness 8, SPEC 9.7): code first. Each returns skip (recorded skipped, zero tokens) or run
// with findings and the exact proposal arguments (derivedArgs, keyed by registry name), so the model chooses,
// explains and proposes. They read only through the ReadOnlyExecutor. Field names of T1 and T2 read results are read
// tolerantly (several spellings) until the integrator pins them.
import type { Precheck, PrecheckResult, ReadOnlyExecutor, ToolOutcome } from "@weft/contracts";
import { TZ } from "./prebuilt";

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

export const agencyNotice: Precheck = async (ctx, exec) => {
  const payload = obj(ctx.payload);
  const noticeId = str(payload.notice_id);
  if (!noticeId) return { action: "skip", reason: "The event carries no notice id." };
  const notice = await read(exec, ctx.companyId, "notices.get", { notice_id: noticeId });
  if (!notice) return { action: "skip", reason: `Notice ${noticeId} could not be read.` };
  const ex = obj(pick(notice, "extracted", "extracted_json"));
  const kind = str(pick(ex, "kind", "type"));
  const rate = str(pick(ex, "new_rate", "rate_new", "rate"));
  const effective = str(pick(ex, "effective_date", "effective_on", "effective"));
  const account = str(pick(ex, "tax_account_id", "account_id", "account"));
  if (!rate || !effective || (kind !== null && !/rate/.test(kind))) return { action: "skip", reason: `Notice ${noticeId} is not a rate change.` };
  const impact = await read(exec, ctx.companyId, "tax.rate_change_impact", { notice_id: noticeId, tax_account_id: account, new_rate: rate, effective_date: effective });
  const update: Obj = { source_notice_id: noticeId, rate, effective_date: effective };
  if (account) update.tax_account_id = account;
  const code = str(pick(ex, "tax_code", "code"));
  if (code) update.tax_code = code;
  return {
    action: "run", severity: "interrupt", subjectRefs: [noticeId, ...(account ? [account] : [])],
    findings: { notice: { id: noticeId, agency: pick(ex, "agency"), kind, old_rate: pick(ex, "old_rate", "rate_old"), new_rate: rate, effective_date: effective, respond_by: pick(ex, "respond_by", "response_due") }, impact },
    derivedArgs: { notice_id: noticeId, "tax.update_rate": update, "notices.draft_response": { notice_id: noticeId }, "notices.send_response": { notice_id: noticeId } },
  };
};

function templateExplanation(row: Obj): string {
  const rule = str(pick(row, "rule", "code")) ?? "FLAG";
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
  const due = manual
    ? drafts.filter((r) => !payload.run_id || r.id === payload.run_id)
    : drafts.filter((r) => { const d = str(pick(r, "approval_deadline", "approval_deadline_at")); return d !== null && ptDate(d) === today; });
  const run = due[0];
  const runId = run ? str(run.id) : null;
  if (!run || !runId) return { action: "skip", reason: manual ? "No draft pay run to review." : `No draft has its approval deadline on ${today} PT.` };
  const detail = await read(exec, ctx.companyId, "payroll.get_run", { run_id: runId, flagged_only: true });
  const flagged = arr(pick(detail ?? {}, "flagged", "flagged_rows", "flags"));
  const items = flagged.map((row) => ({ paycheck_id: str(pick(row, "paycheck_id", "id")), explanation: templateExplanation(row) })).filter((i) => i.paycheck_id);
  return {
    action: "run", severity: "interrupt", subjectRefs: [runId],
    findings: { run_id: runId, flagged_count: flagged.length, approval_deadline: pick(run, "approval_deadline"), totals: pick(detail ?? {}, "totals") },
    derivedArgs: { run_id: runId, "payroll.get_run": { run_id: runId, flagged_only: true }, "payroll.submit_run": { run_id: runId, exclude_blocked: true }, "payroll.explain_flags": { run_id: runId, items } },
  };
};

export const newHire: Precheck = async (ctx, exec) => {
  const payload = obj(ctx.payload);
  const workerId = str(payload.worker_id);
  if (!workerId) return { action: "skip", reason: "The event carries no worker id." };
  const person = (await read(exec, ctx.companyId, "people.get", { worker_id: workerId })) ?? {};
  const state = str(pick(person, "work_state", "state")) ?? "CO";
  const regs = await read(exec, ctx.companyId, "tax.list_registrations", { state });
  const active = arr(pick(regs ?? {}, "registrations", "items")).filter((r) => r.status === "active").map((r) => str(r.agency));
  const agencies = state === "CO" ? ["co_dor", "co_cdle"] : [];
  const missing = agencies.filter((a) => !active.includes(a));
  const name = str(pick(person, "display", "name", "preferred_name")) ?? "our new teammate";
  return {
    action: "run", severity: "interrupt", subjectRefs: [workerId],
    findings: { worker_id: workerId, state, missing_registrations: missing },
    derivedArgs: {
      worker_id: workerId,
      "it.create_account": ["chat", "google_ws", "github"].map((system) => ({ worker_id: workerId, system })),
      "comms.send_message": { channel: "#new-hires", text: `Please welcome ${name} to the team.` },
      "tax.register_state_account": missing.map((agency) => ({ state, agency })),
      "it.order_device": { worker_id: workerId, sku: "laptop_standard" },
    },
  };
};

export const peopleDigest: Precheck = async (ctx, exec) => {
  const people = await read(exec, ctx.companyId, "people.search", { status: "active", limit: 100 });
  const headcount = Number(pick(people ?? {}, "total", "count") ?? arr(pick(people ?? {}, "items", "workers", "results")).length);
  const slot = str(obj(ctx.payload).slot) ?? ctx.triggerRef;
  const text = `Weekly people digest: ${headcount} active people. Open items are in the Weft inbox.`;
  return { action: "run", severity: "digest", subjectRefs: [], findings: { headcount, slot }, derivedArgs: { slot, "comms.send_message": { channel: "#people-ops", text } } };
};

export const openApprovals: Precheck = async (ctx, exec) => {
  const list = await read(exec, ctx.companyId, "actions.list", { kind: "proposals", status: "pending" });
  const count = Number(pick(list ?? {}, "total", "count") ?? arr(pick(list ?? {}, "items", "data")).length);
  const channel = str(obj(ctx.payload).channel) ?? "#people-ops";
  return { action: "run", severity: "digest", subjectRefs: [], findings: { open_approvals: count }, derivedArgs: { "comms.send_message": { channel, text: `Open approvals: ${count}. Review them in the Weft inbox.` } } };
};

export const PRECHECKS: Record<string, Precheck> = {
  agency_notice: agencyNotice, pre_payroll: prePayroll, new_hire: newHire, people_digest: peopleDigest, open_approvals: openApprovals,
};

export async function runPrecheck(name: string | null, ctx: Parameters<Precheck>[0], exec: ReadOnlyExecutor): Promise<PrecheckResult> {
  if (!name) return { action: "run", severity: "digest", subjectRefs: [], findings: null, derivedArgs: null };
  const p = PRECHECKS[name];
  if (!p) return { action: "skip", reason: `Unknown precheck ${name}.` };
  return p(ctx, exec);
}
