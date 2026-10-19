// rt_agency_notice handles every notice kind (wave 4 round 1, FG1; docs/evals/error-analysis.md FM1). The precheck
// reads the notice once: a rate change keeps the GP1 path (update the rate, draft and propose the reply), and every
// other kind goes through planNotice() (packages/contracts/src/ext/w4-parity-compliance.ts), the planner that
// rt_compliance_notices carried while it shipped disabled. Escalation is one command, notices.escalate with a
// derived {notice_id, reason_code}. Each plan gets its own checklist items (gated with "@plan=" in checks.ts) and
// its own tool subset, both frozen at run start, so the model sees only what this notice needs. Every consequential
// write stays a proposal: tax.update_rate, tax.file_return, tax.set_deposit_schedule and notices.send_response
// always wait for a person; notices.escalate, notices.draft_response and tax.prepare_filing are R1 and send nothing
// to the agency.
import type { ChecklistItem, Precheck, PrecheckResult, ReadOnlyExecutor, ToolOutcome } from "@weft/contracts";
import type { NoticePlan } from "../../contracts/src/ext/w4-parity-compliance";
import type { Predicate, RunCall, RunFacts } from "./checks";
import { noticePlanFrom } from "./wave4/compliance";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const pick = (o: Obj, ...keys: string[]): unknown => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);

async function read(exec: ReadOnlyExecutor, companyId: string, command: string, args: Obj): Promise<Obj | null> {
  const o: ToolOutcome = await exec.exec(companyId, command, { response_format: "concise", ...args });
  return o.ok && o.status === "done" ? obj(o.data) : null;
}

/**
 * The plans rt_agency_notice runs. `acknowledge` is not one: an informational notice, or a rate notice whose every
 * stated rate is already in effect, is skipped with its reason.
 */
export type AgencyNoticePlan = Exclude<NoticePlan, "acknowledge">;

/**
 * The routine's tools (at most 8, harness 5.3 wave 4 amendment). tax.get_rates and tax.rate_change_impact left the
 * list: the precheck reads the impact and puts it in the findings, so the model never needs them.
 */
export const AGENCY_NOTICE_TOOLS = [
  "notices.get", "notices.draft_response", "notices.send_response", "notices.escalate",
  "tax.update_rate", "tax.prepare_filing", "tax.file_return", "tax.set_deposit_schedule",
] as const;

/** The tools each plan is offered (a subset of AGENCY_NOTICE_TOOLS). Every non-rate plan may also escalate. */
export const AGENCY_NOTICE_PLAN_TOOLS: Record<AgencyNoticePlan, readonly string[]> = {
  update_rate: ["notices.get", "tax.update_rate", "notices.draft_response", "notices.send_response"],
  attach_filing: ["notices.get", "notices.draft_response", "notices.send_response", "notices.escalate"],
  file_return: ["notices.get", "tax.prepare_filing", "tax.file_return", "notices.draft_response", "notices.send_response", "notices.escalate"],
  update_deposit_schedule: ["notices.get", "tax.set_deposit_schedule"],
  pay_penalty_or_abate: ["notices.get", "notices.draft_response", "notices.escalate", "notices.send_response"],
  escalate: ["notices.get", "notices.escalate"],
};

/** Per-plan checklist items. The rate items keep their GP1 ids and labels. */
export const AGENCY_NOTICE_CHECKLIST: ChecklistItem[] = [
  { id: "draft", label: "draft reply", check: "@plan=update_rate draft_exists:{notice_id}" },
  { id: "rate", label: "propose tax.update_rate", check: "@plan=update_rate proposal_exists:tax.update_rate:{notice_id}" },
  { id: "send", label: "propose notices.send_response", check: "@plan=update_rate proposal_exists:notices.send_response:{notice_id}" },
  { id: "reply_filed", label: "draft the reply citing the filing on record and propose sending it, or escalate the notice", check: "@plan=attach_filing agency_notice_handled:{notice_id}:attach_filing" },
  { id: "file_return", label: "prepare the return, propose filing it, draft and propose the reply, or escalate the notice", check: "@plan=file_return agency_notice_handled:{notice_id}:file_return" },
  { id: "deposit_schedule", label: "propose tax.set_deposit_schedule with the derived arguments", check: "@plan=update_deposit_schedule agency_notice_handled:{notice_id}:update_deposit_schedule" },
  { id: "abatement", label: "draft the abatement request, escalate the payment decision and propose the reply", check: "@plan=pay_penalty_or_abate agency_notice_handled:{notice_id}:pay_penalty_or_abate" },
  { id: "escalate", label: "escalate the notice with notices.escalate", check: "@plan=escalate agency_notice_handled:{notice_id}:escalate" },
];

/** notices.escalate reason codes (packages/core/src/parity/escalation.ts EscalationReason). */
export type EscalationReasonCode = "agency_call_needed" | "penalty_dispute" | "unrecognized_notice" | "missing_filing" | "amount_mismatch";

/** The reason code an escalation carries, from the plan, the planner's reason and the notice kind. */
export function escalationReason(plan: NoticePlan, reason: string | null, kind: string): EscalationReasonCode {
  if (plan === "pay_penalty_or_abate") return "penalty_dispute";
  if (reason === "unknown_notice_kind" || reason === "low_confidence_extract") return "unrecognized_notice";
  if (kind === "missing_filing") return "missing_filing";
  return "agency_call_needed";
}

const AGENCY_JURISDICTION: Record<string, string> = { irs: "US", ca_edd: "CA", ny_dtf: "NY", ny_dol: "NY", tx_twc: "TX", co_dor: "CO", co_cdle: "CO" };

/** "0.015" (a decimal rate string) as "1.5%", exactly, without floats. */
export function percentOf(rate: string): string {
  const [i = "0", f = ""] = rate.split(".");
  const f2 = f.padEnd(2, "0");
  const whole = `${i}${f2.slice(0, 2)}`.replace(/^0+(?=\d)/, "");
  const rest = f2.slice(2).replace(/0+$/, "");
  return `${whole}${rest ? `.${rest}` : ""}%`;
}

/** A rate_delta of zero from tax.rate_change_impact ("0", "0.000" or "-0"). */
const zeroDelta = (v: unknown) => typeof v === "string" && /^-?0+(\.0+)?$/.test(v);

/**
 * The GP1 path: a rate change with an account, a code, a rate and an effective date. Each stated rate is checked
 * against the rate in effect on the effective date (tax.rate_change_impact, a read): the first one that differs is
 * the change to propose (SUI first). When every stated rate is already in effect the notice only confirms them, so the
 * plan is acknowledge-only (review fix group notices-and-proposals): the run is skipped with the acknowledgment
 * recorded as its reason, and nothing is proposed, since a "3.4% to 3.4%" rate change or a reply has nothing to do.
 */
async function ratePath(ctx: Parameters<Precheck>[0], exec: ReadOnlyExecutor, noticeId: string, notice: Obj): Promise<PrecheckResult | null> {
  const ex = obj(pick(notice, "extracted"));
  const rates = arr(pick(ex, "rates"));
  const ordered = [...rates.filter((r) => r.code === "sui"), ...rates.filter((r) => r.code !== "sui")];
  const effective = str(pick(ex, "effectiveFrom", "effective_from"));
  const account = str(pick(notice, "tax_account_id")) ?? str(pick(ex, "taxAccountId"));
  if (!ordered.length || !effective || !account) return null;
  const agency = str(pick(ex, "agency")) ?? str(pick(notice, "agency"));
  const jurisdiction = AGENCY_JURISDICTION[agency ?? ""] ?? null;
  const confirmed: { code: string; rate: string }[] = [];
  let chosen: { change: Obj; rate: string; code: string; impact: Obj | null } | null = null;
  for (const change of ordered) {
    const rate = str(pick(change, "newRate", "new_rate"));
    const code = str(pick(change, "code"));
    if (!rate || !code) return null;
    const impact = jurisdiction ? await read(exec, ctx.companyId, "tax.rate_change_impact", { jurisdiction, code, new_rate: rate, effective_from: effective }) : null;
    if (impact && zeroDelta(impact.rate_delta)) { confirmed.push({ code, rate: str(impact.old_rate) ?? rate }); continue; }
    chosen = { change, rate, code, impact };
    break;
  }
  if (!chosen) {
    const list = confirmed.map((c) => `${jurisdiction} ${c.code.toUpperCase()} ${percentOf(c.rate)}`).join(" and ");
    const form = str(pick(notice, "form_code")) ?? "rate";
    return { action: "skip", reason: `Acknowledge only: notice ${noticeId} (${form}) confirms the rate already in effect, ${list} effective ${effective}. Nothing to change or reply to, so no rate change or reply is proposed. A person can record it as read with notices.acknowledge.` };
  }
  const { change, rate, code, impact } = chosen;
  return {
    action: "run", severity: "interrupt", subjectRefs: [noticeId, account],
    findings: { notice: { id: noticeId, agency: pick(ex, "agency"), kind: "rate_change", form: str(pick(notice, "form_code")), code, old_rate: pick(change, "oldRate"), new_rate: rate, effective_from: effective, respond_by: pick(ex, "respondBy") }, impact, plan: "update_rate" },
    derivedArgs: {
      notice_id: noticeId, plan: "update_rate", kind: "rate_change",
      "tax.rate_change_impact": jurisdiction ? { jurisdiction, code, new_rate: rate, effective_from: effective } : null,
      "tax.update_rate": { tax_account_id: account, code, rate, effective_from: effective, source_notice_id: noticeId },
      "notices.draft_response": { notice_id: noticeId },
      "notices.send_response": { notice_id: noticeId },
    },
  };
}

/** Proposal statuses that mean a notice's work is waiting on a person or under way. */
const OPEN_PROPOSAL = new Set(["pending", "approved"]);

/**
 * Idempotency per notice (fix group duplicate-proposal): a second run on a notice whose proposals are still open, or on
 * a later copy of a letter that is already being handled, proposes nothing new. notices.get lists the proposals filed
 * about the notice and the earlier copy of the same letter (duplicate_of). Returns the skip reason, or null to run.
 */
export function alreadyHandled(noticeId: string, notice: Obj): string | null {
  const open = arr(pick(notice, "proposals")).filter((p) => OPEN_PROPOSAL.has(str(p.status) ?? ""));
  if (open.length) {
    const list = open.map((p) => `${str(p.command) ?? "a change"} ${str(p.id)} (${str(p.status)})`).join(", ");
    return `Notice ${noticeId} is already being handled: ${list}. Nothing new to propose until a person decides.`;
  }
  const copy = obj(pick(notice, "duplicate_of"));
  const copyId = str(copy.id);
  if (!copyId) return null;
  const copyStatus = str(copy.status) ?? "new";
  const copyOpen = Number(copy.open_proposals ?? 0);
  if (copyStatus === "new" && !(copyOpen > 0)) return null;   // the earlier copy was never handled: handle this one
  const state = copyOpen > 0 ? `${copyStatus} with ${copyOpen} open proposal${copyOpen === 1 ? "" : "s"}` : copyStatus.replaceAll("_", " ");
  return `Notice ${noticeId} repeats ${copyId} (same agency, form, account, parsed fields and text), which is already ${state}. Nothing new to do; a person can mark ${noticeId} read in Compliance.`;
}

/** notices.get (t2-world): data.notice.{kind, status, tax_account_id, form_code, extracted: {...}}. */
export const agencyNotice: Precheck = async (ctx, exec) => {
  const noticeId = str(obj(ctx.payload).notice_id);
  if (!noticeId) return { action: "skip", reason: "The event carries no notice id." };
  const data = await read(exec, ctx.companyId, "notices.get", { notice_id: noticeId });
  if (!data) return { action: "skip", reason: `Notice ${noticeId} could not be read.` };
  const notice = obj(pick(data, "notice") ?? data);
  const status = str(notice.status) ?? "new";
  if (status === "resolved" || status === "escalated") return { action: "skip", reason: `Notice ${noticeId} is already ${status}.` };
  const handled = alreadyHandled(noticeId, notice);
  if (handled) return { action: "skip", reason: handled };
  const kind = str(pick(notice, "kind")) ?? str(pick(obj(notice.extracted), "kind")) ?? "unknown";
  if (kind === "rate_change") {
    const r = await ratePath(ctx, exec, noticeId, notice);
    if (r) return r;
    // A rate change without the fields to apply it is a judgment call for the specialist, not a silent skip.
  }
  const p = await noticePlanFrom("simulated", ctx, exec, noticeId, notice, kind === "rate_change" ? { escalation: "notices", forceEscalate: "low_confidence_extract" } : { escalation: "notices" });
  if (p.action !== "run") return p;
  const derived = obj(p.derivedArgs);
  const plan = String(derived.plan) as NoticePlan;
  if (plan === "acknowledge") return { action: "skip", reason: `Notice ${noticeId} (${kind.replaceAll("_", " ")}) is informational: nothing to reply to or change. A person can mark it read in Compliance.` };
  if (plan === "escalate" || plan === "pay_penalty_or_abate") {
    const reason = str(obj(p.findings).reason);
    derived["notices.escalate"] = { notice_id: noticeId, reason_code: escalationReason(plan, reason, kind) };
  }
  // The missing-filing plans may escalate instead of replying (a remembered procedure can say so), so the derived
  // escalation arguments are there too; the checklist accepts either path.
  if (plan === "attach_filing" || plan === "file_return") {
    derived["notices.escalate"] = { notice_id: noticeId, reason_code: escalationReason(plan, null, kind) };
  }
  return { ...p, derivedArgs: derived };
};

/** The checklist items and tools a run of this routine gets for its plan (frozen at run start). */
export function agencyNoticePlanTools(plan: unknown): readonly string[] | null {
  return typeof plan === "string" && plan in AGENCY_NOTICE_PLAN_TOOLS ? AGENCY_NOTICE_PLAN_TOOLS[plan as AgencyNoticePlan] : null;
}

// ---------------------------------------------------------------- checklist predicates

const wire = (s: string) => s.replace("__", ".");
const callsTo = (f: RunFacts, command: string) => f.calls.filter((c) => wire(c.command) === command);
const mentions = (c: RunCall, needle: string) => needle === "" || JSON.stringify(c.args ?? null).includes(needle);
const live = (f: RunFacts, c: RunCall) => {
  if (c.status !== "pending_approval" || !c.proposalId) return c.status === "done";
  const s = f.proposalStatus(c.proposalId) ?? "pending";
  return !["denied", "expired", "failed", "superseded", "dismissed"].includes(s);
};
const done = (f: RunFacts, command: string, needle: string) => callsTo(f, command).some((c) => c.status === "done" && mentions(c, needle));
const proposed = (f: RunFacts, command: string, needle: string) => callsTo(f, command).some((c) => c.status === "pending_approval" && live(f, c) && mentions(c, needle));
const escalated = (f: RunFacts, n: string) => done(f, "notices.escalate", n);

/** What each plan must leave behind (harness 4.3). A missing-filing plan is also handled by an escalation (MM-03). */
export const AGENCY_NOTICE_PLAN_CHECKS: Record<AgencyNoticePlan, (f: RunFacts, noticeId: string) => boolean> = {
  update_rate: (f, n) => done(f, "notices.draft_response", n) && proposed(f, "tax.update_rate", n) && proposed(f, "notices.send_response", n),
  attach_filing: (f, n) => (done(f, "notices.draft_response", n) && proposed(f, "notices.send_response", n)) || escalated(f, n),
  file_return: (f, n) => (callsTo(f, "tax.file_return").some((c) => c.status === "pending_approval" && live(f, c)) && done(f, "notices.draft_response", n) && proposed(f, "notices.send_response", n)) || escalated(f, n),
  update_deposit_schedule: (f, n) => proposed(f, "tax.set_deposit_schedule", n),
  pay_penalty_or_abate: (f, n) => done(f, "notices.draft_response", n) && escalated(f, n) && proposed(f, "notices.send_response", n),
  escalate: (f, n) => escalated(f, n),
};

export const predicates: Record<string, Predicate> = {
  agency_notice_handled: ([noticeId = "", plan = ""], f) => {
    const check = AGENCY_NOTICE_PLAN_CHECKS[plan as AgencyNoticePlan];
    return check ? check(f, noticeId) : false;
  },
};
