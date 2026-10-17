// Wave 4 routines, prechecks and checklist predicates (docs/wave4.md). Owner: w4-parity-compliance. Planned: rt_compliance_calendar (deadline reminders), rt_quarterly_filings, rt_training_due; rt_agency_notice gains the other notice kinds through its own precheck file.
// prebuilt.ts, prechecks.ts and checks.ts spread these in; add entries here only. New routines ship disabled unless their
// golden path needs them enabled, keep their tools at 8 or fewer, and use new ids (rt_ prefix).
//
// - rt_compliance_reminders: weekdays 08:00 PT. When calendar rows are due within 14 days or overdue, post them to
//   #payroll with compliance.post_reminders (the text is written in code from the calendar). Disabled.
// - rt_compliance_notices: on notice.received, every kind except rate changes (rt_agency_notice keeps those). The
//   precheck reads only structured fields (concise notices.get, tax.list_filings) and planNotice() picks the handling
//   from NOTICE_HANDLING: reply citing the filing on file, prepare and propose the missing return, propose the deposit
//   schedule change, request penalty abatement and hand the payment decision to a specialist, acknowledge an
//   informational notice, or hand anything unknown or uncertain to a tax specialist. Disabled (it would act on the
//   GP16 missing-filing notice); the integrator chooses whether to enable it or fold it into rt_agency_notice.
import type { Precheck, ReadOnlyExecutor, RoutineDef, ToolOutcome } from "@weft/contracts";
import { NOTICE_FORM_CODES, planNotice, RT_COMPLIANCE_NOTICES, type NoticePlan } from "../../../contracts/src/ext/w4-parity-compliance";
import type { Predicate, RunCall, RunFacts } from "../checks";

const TZ = "America/Los_Angeles";
const OWNER = "usr_dana";
const budget = { steps: 6, usd: 0.05, minutes: 10 };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

async function read(exec: ReadOnlyExecutor, companyId: string, command: string, args: Obj): Promise<Obj | null> {
  const o: ToolOutcome = await exec.exec(companyId, command, { response_format: "concise", ...args });
  return o.ok && o.status === "done" ? obj(o.data) : null;
}

export const RT_COMPLIANCE_REMINDERS: RoutineDef = {
  id: "rt_compliance_reminders", name: "Compliance reminders",
  description: "Weekday mornings, post the filings, deposits, notice replies, training and contractor forms due within 14 days or overdue to #payroll.",
  ownerPrincipalId: OWNER, enabled: false, autonomy: "approve", trigger: { type: "cron", cron: "0 8 * * 1-5", tz: TZ }, filter: null,
  instructions: "Call compliance.post_reminders with the derived arguments; it writes the text from the calendar. Do not restate dates yourself. Then write a one-line final message.",
  tools: ["compliance.calendar", "compliance.post_reminders"],
  precheck: "compliance_reminders",
  checklist: [{ id: "posted", label: "post the due-soon rows to #payroll", check: "reminders_posted:{channel}" }],
  budget, surface: { worthSurfacing: false, channel: "#payroll" }, source: "prebuilt", taintedBy: null,
};

export const RT_COMPLIANCE_NOTICES_DEF: RoutineDef = {
  id: RT_COMPLIANCE_NOTICES, name: "Agency notice follow-up",
  description: "When an agency notice other than a rate change arrives, handle it by its kind: reply with the filing on record, prepare and propose a missing return, propose a deposit schedule change, request penalty abatement, acknowledge it, or hand it to a tax specialist.",
  ownerPrincipalId: OWNER, enabled: false, autonomy: "approve", trigger: { type: "event", event: "notice.received" }, filter: null,
  instructions: "Follow the derived plan with the derived arguments, executable calls first: prepare or draft, then propose. For plan escalate, call handoffs.open with the derived arguments. Then write a short final message.",
  tools: ["notices.get", "tax.prepare_filing", "tax.file_return", "tax.set_deposit_schedule", "notices.acknowledge", "notices.draft_response", "notices.send_response", "handoffs.open"],
  precheck: "compliance_notices",
  checklist: [{ id: "handled", label: "handle the notice by its kind", check: "notice_handled:{notice_id}:{plan}" }],
  budget, surface: { worthSurfacing: true, channel: "#payroll" }, source: "prebuilt", taintedBy: null,
};

export const routines: RoutineDef[] = [RT_COMPLIANCE_REMINDERS, RT_COMPLIANCE_NOTICES_DEF];

// ---------------------------------------------------------------- prechecks

const complianceReminders: Precheck = async (ctx, exec) => {
  const cal = await read(exec, ctx.companyId, "compliance.calendar", {});
  const due = arr(cal?.items).filter((r) => r.status === "due_soon" || r.status === "overdue");
  if (!due.length) return { action: "skip", reason: "Nothing on the compliance calendar is due within 14 days." };
  const channel = str(obj(ctx.payload).channel) ?? "#payroll";
  return {
    action: "run", severity: "digest", subjectRefs: due.map((r) => String(r.id)).slice(0, 20),
    findings: { due_soon: due.filter((r) => r.status === "due_soon").length, overdue: due.filter((r) => r.status === "overdue").length, items: due.slice(0, 12).map((r) => ({ id: r.id, title: r.title, due_on: r.due_on, status: r.status })) },
    derivedArgs: { channel, "compliance.post_reminders": { channel } },
  };
};

const formLabel = (form: string) => ({ "941": "Form 941", "940": "Form 940", ny_nys45: "NYS-45", ca_de9: "DE 9", ca_de9c: "DE 9C", tx_c3: "C-3", co_uitr1: "UITR-1" } as Record<string, string>)[form] ?? form;

/** The handling plan and the exact arguments for it, from structured fields only. */
export const complianceNotices: Precheck = async (ctx, exec) => {
  const noticeId = str(obj(ctx.payload).notice_id);
  if (!noticeId) return { action: "skip", reason: "The event carries no notice id." };
  const data = await read(exec, ctx.companyId, "notices.get", { notice_id: noticeId });
  if (!data) return { action: "skip", reason: `Notice ${noticeId} could not be read.` };
  const n = obj(data.notice);
  const status = str(n.status) ?? "new";
  if (status === "resolved" || status === "escalated") return { action: "skip", reason: `Notice ${noticeId} is already ${status}.` };
  const kind = str(n.kind) ?? "unknown";
  const ex = n.extracted ? obj(n.extracted) : null;
  const form = ex ? NOTICE_FORM_CODES[str(ex.formCode) ?? str(n.form_code) ?? ""] ?? null : null;
  const period = ex ? str(ex.period) : null;
  let filing: { id: string; status: string; confirmation: string | null; filed_at: string | null } | null = null;
  if (form && period) {
    const fl = arr((await read(exec, ctx.companyId, "tax.list_filings", { form, period }))?.filings)[0];
    if (fl) filing = { id: String(fl.id), status: String(fl.status), confirmation: str(fl.confirmation), filed_at: str(fl.filed_at) };
  }
  const account = str(n.tax_account_id);
  const { plan, reason } = planNotice({ kind, extract: ex ? { formCode: str(ex.formCode), period, effectiveFrom: str(ex.effectiveFrom), accountNumber: str(ex.accountNumber), confidence: typeof ex.confidence === "number" ? ex.confidence : null } : null, taxAccountId: account, filing });
  if (plan === "update_rate") return { action: "skip", reason: `Notice ${noticeId} is a rate change; rt_agency_notice handles it.` };
  const label = form ? formLabel(form) : str(n.form_code) ?? "the return";
  const derived: Obj = { notice_id: noticeId, plan, kind, "notices.get": { notice_id: noticeId } };
  if (plan === "attach_filing" && filing) {
    derived["notices.draft_response"] = { notice_id: noticeId, note: `The ${label} return for ${period} was filed on ${(filing.filed_at ?? "").slice(0, 10)} with confirmation ${filing.confirmation ?? "on file"}.` };
    derived["notices.send_response"] = { notice_id: noticeId };
  } else if (plan === "file_return" && filing) {
    derived.filing_id = filing.id;
    derived["tax.prepare_filing"] = { filing_id: filing.id };
    derived["tax.file_return"] = { filing_id: filing.id };
    derived["notices.draft_response"] = { notice_id: noticeId, note: `The ${label} return for ${period} is prepared from our processed payroll and goes to you once it is approved.` };
    derived["notices.send_response"] = { notice_id: noticeId };
  } else if (plan === "update_deposit_schedule" && ex && account) {
    derived["tax.set_deposit_schedule"] = { tax_account_id: account, schedule: str(ex.period), effective_from: str(ex.effectiveFrom), source_notice_id: noticeId };
  } else if (plan === "pay_penalty_or_abate") {
    derived["notices.draft_response"] = { notice_id: noticeId, note: "We request abatement of this penalty under the first-time abatement policy. A person on our team will follow up on any balance." };
    derived["handoffs.open"] = { kind: "tax_specialist", reason: reason ?? "judgment_needed", subject_ref: noticeId, summary: `A ${kind.replaceAll("_", " ")} notice: choose between paying the penalty and pursuing the abatement request.` };
    derived["notices.send_response"] = { notice_id: noticeId };
  } else if (plan === "acknowledge") {
    derived["notices.acknowledge"] = { notice_id: noticeId };
  } else {
    derived.plan = "escalate";
    derived["handoffs.open"] = { kind: "tax_specialist", reason: reason ?? "judgment_needed", subject_ref: noticeId,
      summary: reason === "unknown_notice_kind" ? `A notice of kind ${kind.replaceAll("_", " ")} that Weft does not handle.` : reason === "low_confidence_extract" ? "An uploaded notice whose fields could not be read with confidence." : `A ${kind.replaceAll("_", " ")} notice that needs a person: no matching record to act on.` };
  }
  return {
    action: "run", severity: "interrupt", subjectRefs: [noticeId, ...(account ? [account] : []), ...(filing ? [filing.id] : [])],
    findings: { notice: { id: noticeId, kind, form, period, status, tax_account_id: account }, filing, plan: derived.plan, reason },
    derivedArgs: derived,
  };
};

export const prechecks: Record<string, Precheck> = { compliance_reminders: complianceReminders, compliance_notices: complianceNotices };

// ---------------------------------------------------------------- checklist predicates

const wire = (s: string) => s.replace("__", ".");
const calls = (f: RunFacts, command: string) => f.calls.filter((c) => wire(c.command) === command);
const mentions = (c: RunCall, needle: string) => needle === "" || JSON.stringify(c.args ?? null).includes(needle);
const live = (f: RunFacts, c: RunCall) => {
  if (c.status !== "pending_approval" || !c.proposalId) return c.status === "done";
  const s = f.proposalStatus(c.proposalId) ?? "pending";
  return !["denied", "expired", "failed", "superseded", "dismissed"].includes(s);
};
const done = (f: RunFacts, command: string, needle: string) => calls(f, command).some((c) => c.status === "done" && mentions(c, needle));
const proposed = (f: RunFacts, command: string, needle: string) => calls(f, command).some((c) => c.status === "pending_approval" && live(f, c) && mentions(c, needle));
const doneOrProposed = (f: RunFacts, command: string, needle: string) => calls(f, command).some((c) => live(f, c) && mentions(c, needle));

/** What each plan must leave behind (harness 4.3): code decides when the notice is handled. */
export const NOTICE_PLAN_CHECKS: Record<Exclude<NoticePlan, "update_rate">, (f: RunFacts, noticeId: string) => boolean> = {
  attach_filing: (f, n) => done(f, "notices.draft_response", n) && proposed(f, "notices.send_response", n),
  file_return: (f, n) => calls(f, "tax.file_return").some((c) => c.status === "pending_approval" && live(f, c)) && done(f, "notices.draft_response", n) && proposed(f, "notices.send_response", n),
  update_deposit_schedule: (f, n) => proposed(f, "tax.set_deposit_schedule", n),
  pay_penalty_or_abate: (f, n) => done(f, "notices.draft_response", n) && done(f, "handoffs.open", n) && proposed(f, "notices.send_response", n),
  acknowledge: (f, n) => done(f, "notices.acknowledge", n),
  escalate: (f, n) => done(f, "handoffs.open", n),
};

export const predicates: Record<string, Predicate> = {
  reminders_posted: ([channel = ""], f) => doneOrProposed(f, "compliance.post_reminders", channel),
  notice_handled: ([noticeId = "", plan = ""], f) => {
    const check = NOTICE_PLAN_CHECKS[plan as Exclude<NoticePlan, "update_rate">];
    return check ? check(f, noticeId) : false;
  },
};
