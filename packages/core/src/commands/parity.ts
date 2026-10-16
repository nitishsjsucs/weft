// Wave 3 parity commands in any namespace (notices.escalate, routines.set_autonomy, people.list_milestones,
// onboarding.ready_check, contractors.list_tax_forms; docs/wave3.md). Owner: w3-parity-routines. Append here only;
// commands/index.ts concatenates it, so the other namespace files stay untouched in wave 3.
//
// Landed: onboarding.ready_check (R0), onboarding.flag_not_ready (R1, an Inbox suggestion per blocked hire),
// reports.exec_figures (R0), comms.send_exec_report (R3 like comms.send_message; the text is built and grounded in
// code), routines.set_autonomy (R1, only ever executed as an approved proposal), people.list_milestones (R0),
// contractors.list_tax_forms (R0) and contractors.request_tax_forms (R3 email, autoAllow untainted), and the
// thirty-day check-in: onboarding.list_checkins (R0), onboarding.send_checkins (R3 email, autoAllow untainted) and
// onboarding.submit_checkin (human only, the hire's answers).
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { ChatChannel, MilestoneKind, Refused, RoutineAutonomy, W3_SETTINGS } from "@weft/contracts";
import { check } from "@weft/grounding";
import { checkins, contractorTaxForms, routines, settings, workers } from "@weft/db";
import type { WeftCommand } from "../shared/deps";
import { DomainRefusal, ptDateOf, readCommand, responseFormatField, riskOf, writeCommand } from "../demo/define";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import { displayName } from "../people/names";
import { blockedText, readyCheck } from "../parity/ready-check";
import { execFigures, execReportText } from "../parity/exec-report";
import { upsertSuggestion } from "../parity/suggestions";
import { listMilestones } from "../parity/milestones";
import { listTaxForms, requestEmail, requestedForm } from "../parity/contractor-forms";
import { CheckinAnswers, checkinPlan, inviteEmail, managerSummary } from "../parity/checkins";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Month = z.string().regex(/^\d{4}-\d{2}$/);

// ---------------------------------------------------------------- New Hire Ready Check

const ReadyInput = z.object({ business_days: z.number().int().min(1).max(10).optional(), as_of: Day.optional(), worker_id: z.string().optional(), ...responseFormatField });
type ReadyInput = z.infer<typeof ReadyInput>;
const readyCheckCommand = readCommand({
  name: "onboarding.ready_check", domain: "people",
  summary: "Day-one readiness for hires starting within the next business days.",
  description: "For each employee starting within business_days (default 3) of as_of (default today), check accounts, laptop, direct deposit, W-4, state form, I-9, benefits and state registration, and name the owner of each blocking item (the hire, IT, payroll). Example: {\"business_days\":null,\"as_of\":null,\"worker_id\":null}",
  input: ReadyInput,
  async run(i: ReadyInput, ctx, deps) {
    const r = await readyCheck(deps.tx, ctx.companyId, i.as_of ?? ptDateOf(ctx.now), { businessDays: i.business_days, workerId: i.worker_id });
    const blocked = r.hires.filter((h) => !h.ready).length;
    return { data: r, summary: `${r.hires.length} hires start by ${r.window_end}: ${r.hires.length - blocked} ready, ${blocked} blocked` };
  },
});

const FlagInput = z.object({ worker_ids: z.array(z.string().startsWith("wrk_")).max(20).optional(), as_of: Day.optional() });
type FlagInput = z.infer<typeof FlagInput>;
const flagNotReady = writeCommand<FlagInput>({
  name: "onboarding.flag_not_ready", summary: "Add Inbox suggestions to unblock hires' first days",
  description: "For each listed hire (default: every hire in the ready-check window) whose check is blocked, add or refresh one Inbox suggestion naming each blocking item and its owner. Items are recomputed here; ready hires are skipped. Example: {\"worker_ids\":[\"wrk_0049\"],\"as_of\":null}",
  input: FlagInput, domain: "people", needs: "edit", effect: "draft", risk: riskOf("R1"), approval: "never", reversible: false,
  tiers: { main: "executable", task: "unavailable" }, mcp: "hidden", preview: null,
  async run(i, ctx, deps) {
    const asOf = i.as_of ?? ptDateOf(ctx.now);
    const out: { worker_id: string; ready: boolean; suggestion_id: string | null; blocked: string[] }[] = [];
    const ids = i.worker_ids ?? (await readyCheck(deps.tx, ctx.companyId, asOf)).hires.map((h) => h.worker_id);
    for (const wid of [...new Set(ids)].sort()) {
      const h = (await readyCheck(deps.tx, ctx.companyId, asOf, { workerId: wid })).hires[0];
      if (!h) throw new DomainRefusal("DOMAIN_NOT_FOUND", `No employee ${wid} in this company`, "Use worker ids from onboarding.ready_check", null);
      if (h.ready) { out.push({ worker_id: wid, ready: true, suggestion_id: null, blocked: [] }); continue; }
      const s = await upsertSuggestion(deps.tx, deps, ctx.now, {
        companyId: ctx.companyId, command: "onboarding.flag_not_ready", subjectRef: h.worker_id,
        headline: `Unblock day one for ${h.name} (${h.worker_id}), starting ${h.start_date}`,
        content: [{ label: "Blocking items", text: blockedText(h) }, ...h.blocked.map((b) => ({ label: b.owner, text: b.label }))],
        evidence: [{ label: "worker", ref: h.worker_id }], domain: "people", onBehalfOf: ctx.onBehalfOf, runId: ctx.run?.id ?? null,
        routineRunId: ctx.routineRunId, taintedBy: ctx.tainted ? "run" : null,
      });
      out.push({ worker_id: wid, ready: false, suggestion_id: s.id, blocked: h.blocked.map((b) => b.item) });
    }
    const n = out.filter((o) => o.suggestion_id).length;
    return { data: { flagged: out }, summary: n ? `Added ${n} Inbox suggestions for blocked hires` : "Every hire is ready; no suggestion needed" };
  },
});

// ---------------------------------------------------------------- exec reports

const ReportKind = z.enum(["monthly", "weekly"]);
const FiguresInput = z.object({ kind: ReportKind.optional(), month: Month.optional(), as_of: Day.optional(), ...responseFormatField });
type FiguresInput = z.infer<typeof FiguresInput>;
const execFiguresCommand = readCommand({
  name: "reports.exec_figures", domain: "payroll",
  summary: "Headcount, hires, departures, turnover and payroll cost for an exec report.",
  description: "Computed figures for the monthly exec report (kind monthly; month defaults to the one that just ended in the first week) or the Monday briefing (kind weekly adds the next payday, hires starting in two weeks and registrations not active). Example: {\"kind\":\"monthly\",\"month\":null,\"as_of\":null}",
  input: FiguresInput,
  async run(i: FiguresInput, ctx, deps) {
    const f = await execFigures(deps.tx, ctx.companyId, { kind: i.kind ?? "monthly", asOf: i.as_of ?? ptDateOf(ctx.now), month: i.month });
    return { data: f, summary: `Exec figures for ${f.month_label}: ${f.headcount} employees, payroll cost ${f.cost.total_cost_display}` };
  },
});

export const EXEC_REPORT_CHANNEL: ChatChannel = "#leadership";
export const EXEC_REPORT_EMAIL = "leadership@larkspur.example";
const SendReportInput = z.object({ kind: ReportKind.optional(), month: Month.optional(), as_of: Day.optional() });
type SendReportInput = z.infer<typeof SendReportInput>;
async function reportOf(i: SendReportInput, ctx: { companyId: string; now: string }, deps: Parameters<WeftCommand["run"]>[2]) {
  const f = await execFigures(deps.tx, ctx.companyId, { kind: i.kind ?? "monthly", asOf: i.as_of ?? ptDateOf(ctx.now), month: i.month });
  const text = execReportText(f);
  const g = check(text, [f]);
  if (!g.ok) throw new Refused("UNGROUNDED", `Ungrounded numbers in the report: ${g.offending.join(", ")}`, { hint: "The report text is built from reports.exec_figures only", example: null });
  return { f, text };
}
const sendExecReport = writeCommand<SendReportInput>({
  name: "comms.send_exec_report", summary: "Post the exec report to #leadership and email it to the leadership list",
  description: "Build the monthly exec report or the Monday briefing from computed figures (the text is written in code, so every number is grounded), post it to #leadership and email it to the leadership list. R3 like comms.send_message. Example: {\"kind\":\"monthly\",\"month\":\"2026-10\",\"as_of\":null}",
  input: SendReportInput, domain: "comms", needs: "edit", effect: "external", risk: riskOf("R3"), approval: "always", autoAllow: "untainted",
  afterPending: "propose", reversible: false, tiers: { main: "executable", task: "delegated" },
  async preview(i, ctx, deps) {
    const { f, text } = await reportOf(i, ctx, deps);
    return { title: `Post the ${f.kind === "monthly" ? `${f.month_label} exec report` : "Monday exec briefing"} to ${EXEC_REPORT_CHANNEL}`, diff: [], content: [{ label: "Content to be sent", text }], moneyCents: null,
      subjectRef: `chat:${EXEC_REPORT_CHANNEL}`, subjectHash: sha256Hex(canonicalJson({ kind: f.kind, month: f.month, text: sha256Hex(text) })), evidence: [] };
  },
  async run(i, ctx, deps) {
    const { f, text } = await reportOf(i, ctx, deps);
    const { id } = await deps.sims.chat.post({ channel: EXEC_REPORT_CHANNEL, author: "Weft agent", text });
    const subject = f.kind === "monthly" ? `Exec report for ${f.month_label}` : `Monday exec briefing (${f.as_of})`;
    const mail = await deps.sims.email.send({ to: EXEC_REPORT_EMAIL, from: "agent@larkspur.example", subject, body: text, kind: "generic", relatedRef: f.month });
    return { data: { message_id: id, email_id: mail.id, channel: EXEC_REPORT_CHANNEL, month: f.month, kind: f.kind }, summary: `Posted the ${subject.toLowerCase()} to ${EXEC_REPORT_CHANNEL} and emailed ${EXEC_REPORT_EMAIL}` };
  },
});

// ---------------------------------------------------------------- autonomy

export const AUTONOMY_SETTING = W3_SETTINGS.allowAutoAutonomy;
export async function allowAutoAutonomy(tx: Parameters<WeftCommand["run"]>[2]["tx"]): Promise<boolean> {
  const [r] = await tx.select().from(settings).where(eq(settings.key, AUTONOMY_SETTING)).limit(1);
  if (!r) return false;
  try { return JSON.parse(r.valueJson) === true; } catch { return false; }
}

const AutonomyInput = z.object({ routine_id: z.string().startsWith("rt_"), autonomy: RoutineAutonomy });
type AutonomyInput = z.infer<typeof AutonomyInput>;
const setAutonomy = writeCommand<AutonomyInput>({
  name: "routines.set_autonomy", summary: "Change a routine's autonomy (recommend, approve or auto)",
  description: "Change how much a routine may do on its own: recommend (writes become Inbox suggestions), approve (writes wait for approval) or auto (allowed R2 commands under their limit run; R4 never). Always a proposal a person approves; auto needs agent.allow_auto_autonomy.",
  input: AutonomyInput, domain: "company", needs: "approve", effect: "write", risk: riskOf("R1"), approval: "never", reversible: false,
  tiers: { main: "unavailable", task: "unavailable" }, mcp: "propose",
  async preview(i, _ctx, deps) {
    const [r] = await deps.tx.select({ id: routines.id, name: routines.name, autonomy: routines.autonomy }).from(routines).where(eq(routines.id, i.routine_id));
    if (!r) throw new Refused("UNKNOWN_REFERENCE", `No routine ${i.routine_id}.`);
    if (i.autonomy === "auto" && !(await allowAutoAutonomy(deps.tx))) {
      throw new DomainRefusal("DOMAIN_AUTO_AUTONOMY_OFF", "Auto autonomy is off for this company", `Turn on ${AUTONOMY_SETTING} in Settings first`, null);
    }
    return { title: `Set autonomy of ${r.name} (${r.id}) to ${i.autonomy}`, diff: [{ label: "autonomy", before: r.autonomy, after: i.autonomy }], content: [], moneyCents: null,
      subjectRef: r.id, subjectHash: sha256Hex(canonicalJson({ routine: r.id, from: r.autonomy, to: i.autonomy })), evidence: [{ label: "routine", ref: r.id }] };
  },
  async run(i, ctx, deps) {
    // The route files this as a proposal; only the approved proposal executes it (an API key cannot run it directly).
    if (!ctx.approvedProposalId) throw new Refused("NOT_PERMITTED", "Changing a routine's autonomy is a proposal; approve it in the Inbox.");
    const [r] = await deps.tx.select({ id: routines.id, autonomy: routines.autonomy }).from(routines).where(eq(routines.id, i.routine_id));
    if (!r) throw new Refused("UNKNOWN_REFERENCE", `No routine ${i.routine_id}.`);
    if (i.autonomy === "auto" && !(await allowAutoAutonomy(deps.tx))) {
      throw new DomainRefusal("DOMAIN_AUTO_AUTONOMY_OFF", "Auto autonomy is off for this company", `Turn on ${AUTONOMY_SETTING} in Settings first`, null);
    }
    await deps.tx.update(routines).set({ autonomy: i.autonomy }).where(eq(routines.id, i.routine_id));
    return { data: { routine_id: r.id, autonomy: i.autonomy, previous: r.autonomy }, summary: `Set ${r.id} autonomy from ${r.autonomy} to ${i.autonomy}` };
  },
});

// ---------------------------------------------------------------- milestones

const MilestonesInput = z.object({ as_of: Day.optional(), days: z.number().int().min(0).max(14).optional(), kinds: z.array(MilestoneKind).optional(), ...responseFormatField });
type MilestonesInput = z.infer<typeof MilestonesInput>;
const listMilestonesCommand = readCommand({
  name: "people.list_milestones", domain: "people",
  summary: "Work anniversaries and opted-in birthdays on a day or in the next few days.",
  description: "List work anniversaries (whole years since the start date) and birthdays of people who shared one (month and day only, never a year) on as_of (default today) or within days after it. Example: {\"as_of\":null,\"days\":null,\"kinds\":null}",
  input: MilestonesInput,
  async run(i: MilestonesInput, ctx, deps) {
    const r = await listMilestones(deps.tx, ctx.companyId, i.as_of ?? ptDateOf(ctx.now), { days: i.days ?? 0, kinds: i.kinds });
    return { data: r, summary: `${r.milestones.length} milestones from ${r.as_of} to ${r.until}` };
  },
});

// ---------------------------------------------------------------- contractor tax forms

const TaxFormsInput = z.object({ as_of: Day.optional(), within_days: z.number().int().min(0).max(180).optional(), ...responseFormatField });
type TaxFormsInput = z.infer<typeof TaxFormsInput>;
const listTaxFormsCommand = readCommand({
  name: "contractors.list_tax_forms", domain: "payroll",
  summary: "Each contractor's W-9 or W-8 on file, its expiry, and who needs a new one.",
  description: "For every active contractor: the form needed (W-9 in the US, W-8BEN or W-8BEN-E abroad), the form on file, when it was signed and when it lapses (W-8: December 31 of the third year after signing), and whether it is missing, expired or expiring within within_days (default 60). Example: {\"as_of\":null,\"within_days\":null}",
  input: TaxFormsInput,
  async run(i: TaxFormsInput, ctx, deps) {
    const r = await listTaxForms(deps.tx, ctx.companyId, i.as_of ?? ptDateOf(ctx.now), { withinDays: i.within_days });
    return { data: r, summary: `${r.contractors.length} contractors; ${r.needs_request.length} need a new tax form` };
  },
});

const RequestFormsInput = z.object({ worker_ids: z.array(z.string().startsWith("wrk_")).min(1).max(20), as_of: Day.optional() });
type RequestFormsInput = z.infer<typeof RequestFormsInput>;
async function formRequests(i: RequestFormsInput, ctx: { companyId: string; now: string }, deps: Parameters<WeftCommand["run"]>[2]) {
  const ids = [...new Set(i.worker_ids)].sort();
  const r = await listTaxForms(deps.tx, ctx.companyId, i.as_of ?? ptDateOf(ctx.now), { workerIds: ids });
  const unknown = ids.filter((id) => !r.contractors.some((c) => c.worker_id === id));
  if (unknown.length) throw new DomainRefusal("DOMAIN_NOT_FOUND", `Not an active contractor: ${unknown.join(", ")}`, "Use worker ids from contractors.list_tax_forms", null);
  return r.contractors.filter((c) => r.needs_request.includes(c.worker_id));
}
const requestTaxForms = writeCommand<RequestFormsInput>({
  name: "contractors.request_tax_forms", summary: "Email contractors whose W-9 or W-8 is missing or lapsing",
  description: "Email each listed contractor whose tax form is missing, expired or expiring soon, asking for a new one in the contractor portal, and mark the form on file as renewal requested. Contractors whose form is current are skipped. R3 like comms.send_message. Example: {\"worker_ids\":[\"wrk_0051\"],\"as_of\":null}",
  input: RequestFormsInput, domain: "payroll", needs: "edit", effect: "external", risk: riskOf("R3"), approval: "always", autoAllow: "untainted",
  afterPending: "propose", reversible: false, tiers: { main: "executable", task: "delegated" },
  async preview(i, ctx, deps) {
    const due = await formRequests(i, ctx, deps);
    return { title: due.length ? `Ask ${due.length} contractors for a new tax form` : "No contractor needs a new tax form", diff: [],
      content: due.map((c) => ({ label: `${c.name} (${c.worker_id})`, text: `${requestedForm(c)}: ${c.state}${c.expires_on ? `, lapses ${c.expires_on}` : ""}` })), moneyCents: null,
      subjectRef: due.map((c) => c.worker_id).join(",") || "contractors", subjectHash: sha256Hex(canonicalJson(due.map((c) => [c.worker_id, c.form_id, c.state]))), evidence: due.map((c) => ({ label: "worker", ref: c.worker_id })) };
  },
  async run(i, ctx, deps) {
    const due = await formRequests(i, ctx, deps);
    const people = due.length ? await deps.tx.select({ id: workers.id, personal: workers.personalEmail, work: workers.workEmail }).from(workers).where(inArray(workers.id, due.map((c) => c.worker_id))) : [];
    const sent: { worker_id: string; email_id: string; form: string; state: string }[] = [];
    for (const c of due) {
      const p = people.find((x) => x.id === c.worker_id)!;
      const { subject, body } = requestEmail(c);
      const mail = await deps.sims.email.send({ to: p.personal ?? p.work, from: "people@larkspur.example", subject, body, kind: "generic", relatedRef: c.worker_id });
      if (c.form_id && c.state !== "requested") await deps.tx.update(contractorTaxForms).set({ status: "renewal_requested" }).where(eq(contractorTaxForms.id, c.form_id));
      sent.push({ worker_id: c.worker_id, email_id: mail.id, form: requestedForm(c), state: c.state });
    }
    const skipped = [...new Set(i.worker_ids)].filter((id) => !due.some((c) => c.worker_id === id)).sort();
    return { data: { requested: sent, skipped }, summary: sent.length ? `Asked ${sent.length} contractors for a new tax form` : "Every listed contractor has a current tax form" };
  },
});

// ---------------------------------------------------------------- thirty-day check-in

const CheckinsInput = z.object({ as_of: Day.optional(), ...responseFormatField });
type CheckinsInput = z.infer<typeof CheckinsInput>;
const listCheckins = readCommand({
  name: "onboarding.list_checkins", domain: "people",
  summary: "First-month check-ins to send, to nudge, open and submitted.",
  description: "Employees whose day 30 (start date plus 30 days) has come within the last week and who have no check-in yet (to_send), check-ins sent three or more days ago and not nudged (to_nudge), open and submitted ones. Statuses only, never the answers. Example: {\"as_of\":null}",
  input: CheckinsInput,
  async run(i: CheckinsInput, ctx, deps) {
    const p = await checkinPlan(deps.tx, ctx.companyId, i.as_of ?? ptDateOf(ctx.now));
    return { data: p, summary: `${p.to_send.length} check-ins to send, ${p.to_nudge.length} to nudge, ${p.open.length} open` };
  },
});

const SendCheckinsInput = z.object({ send: z.array(z.string().startsWith("wrk_")).max(20), nudge: z.array(z.string().startsWith("chk_")).max(20), as_of: Day.optional() });
type SendCheckinsInput = z.infer<typeof SendCheckinsInput>;
async function checkinWork(i: SendCheckinsInput, ctx: { companyId: string; now: string }, deps: Parameters<WeftCommand["run"]>[2]) {
  const p = await checkinPlan(deps.tx, ctx.companyId, i.as_of ?? ptDateOf(ctx.now));
  return { send: p.to_send.filter((r) => i.send.includes(r.worker_id)), nudge: p.to_nudge.filter((r) => r.checkin_id && i.nudge.includes(r.checkin_id)) };
}
const sendCheckins = writeCommand<SendCheckinsInput>({
  name: "onboarding.send_checkins", summary: "Email first-month check-ins and one nudge three days later",
  description: "Email each listed employee whose first-month check-in is due (send, worker ids) and nudge each listed check-in still open three days on (nudge, check-in ids), once. The list is rechecked here; anyone not due is skipped. R3 like comms.send_message. Example: {\"send\":[\"wrk_0049\"],\"nudge\":[],\"as_of\":null}",
  input: SendCheckinsInput, domain: "people", needs: "edit", effect: "external", risk: riskOf("R3"), approval: "always", autoAllow: "untainted",
  afterPending: "propose", reversible: false, tiers: { main: "executable", task: "delegated" },
  async preview(i, ctx, deps) {
    const w = await checkinWork(i, ctx, deps);
    return { title: `Send ${w.send.length} first-month check-ins and ${w.nudge.length} nudges`, diff: [],
      content: [...w.send.map((r) => ({ label: "Check-in", text: `${r.name} (${r.worker_id}), day 30 was ${r.due_on}` })), ...w.nudge.map((r) => ({ label: "Nudge", text: `${r.name} (${r.worker_id}), sent ${r.sent_at}` }))], moneyCents: null,
      subjectRef: [...w.send.map((r) => r.worker_id), ...w.nudge.map((r) => r.checkin_id!)].join(",") || "checkins",
      subjectHash: sha256Hex(canonicalJson({ send: w.send.map((r) => [r.worker_id, r.due_on]), nudge: w.nudge.map((r) => r.checkin_id) })), evidence: w.send.map((r) => ({ label: "worker", ref: r.worker_id })) };
  },
  async run(i, ctx, deps) {
    const w = await checkinWork(i, ctx, deps);
    const ids = [...w.send, ...w.nudge].map((r) => r.worker_id);
    const people = ids.length ? await deps.tx.select({ id: workers.id, email: workers.workEmail }).from(workers).where(inArray(workers.id, ids)) : [];
    const to = (wid: string) => people.find((p) => p.id === wid)!.email;
    const sent: { worker_id: string; checkin_id: string; email_id: string }[] = [];
    for (const r of w.send) {
      const id = await deps.newId("chk_");
      await deps.tx.insert(checkins).values({ id, workerId: r.worker_id, dueOn: r.due_on, status: "sent", answersJson: null, sentAt: ctx.now, nudgedAt: null, submittedAt: null, createdAt: ctx.now });
      const m = inviteEmail(r.name, false);
      const mail = await deps.sims.email.send({ to: to(r.worker_id), from: "people@larkspur.example", subject: m.subject, body: m.body, kind: "portal_invite", relatedRef: id });
      sent.push({ worker_id: r.worker_id, checkin_id: id, email_id: mail.id });
    }
    const nudged: { worker_id: string; checkin_id: string; email_id: string }[] = [];
    for (const r of w.nudge) {
      await deps.tx.update(checkins).set({ status: "nudged", nudgedAt: ctx.now }).where(eq(checkins.id, r.checkin_id!));
      const m = inviteEmail(r.name, true);
      const mail = await deps.sims.email.send({ to: to(r.worker_id), from: "people@larkspur.example", subject: m.subject, body: m.body, kind: "nudge", relatedRef: r.checkin_id });
      nudged.push({ worker_id: r.worker_id, checkin_id: r.checkin_id!, email_id: mail.id });
    }
    return { data: { sent, nudged }, summary: `Sent ${sent.length} first-month check-ins and ${nudged.length} nudges` };
  },
});

const SubmitCheckinInput = z.object({ checkin_id: z.string().startsWith("chk_"), answers: CheckinAnswers });
type SubmitCheckinInput = z.infer<typeof SubmitCheckinInput>;
const submitCheckin = writeCommand<SubmitCheckinInput>({
  name: "onboarding.submit_checkin", summary: "Submit a first-month check-in (the hire, human only)",
  description: "Human only: stores the hire's four answers on an open check-in and emails the manager a summary with the two multiple-choice answers; the written answers stay in Weft and never reach an agent.",
  input: SubmitCheckinInput, domain: "people", needs: "view", effect: "write", risk: riskOf("R1"), approval: "never", access: "human_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const [c] = await deps.tx.select().from(checkins).where(eq(checkins.id, i.checkin_id));
    if (!c) throw new Refused("UNKNOWN_REFERENCE", `No check-in ${i.checkin_id}.`);
    if (c.status !== "sent" && c.status !== "nudged") throw new DomainRefusal("DOMAIN_CHECKIN_CLOSED", `Check-in ${c.id} is ${c.status}`, "Only an open check-in takes answers", null);
    const [w] = await deps.tx.select().from(workers).where(and(eq(workers.id, c.workerId), eq(workers.companyId, ctx.companyId)));
    if (!w) throw new Refused("UNKNOWN_REFERENCE", `No check-in ${i.checkin_id}.`);
    const [mgr] = w.managerId ? await deps.tx.select({ email: workers.workEmail }).from(workers).where(eq(workers.id, w.managerId)) : [];
    await deps.tx.update(checkins).set({ status: "submitted", answersJson: JSON.stringify(i.answers), submittedAt: ctx.now }).where(eq(checkins.id, c.id));
    const m = managerSummary(displayName(w.firstName, w.lastName), i.answers);
    const mail = await deps.sims.email.send({ to: mgr?.email ?? "people@larkspur.example", from: "agent@larkspur.example", subject: m.subject, body: m.body, kind: "generic", relatedRef: c.id });
    return { data: { checkin_id: c.id, worker_id: w.id, status: "submitted", summary_email_id: mail.id }, summary: `Recorded the first-month check-in ${c.id} and emailed the summary`,
      events: [{ type: "checkin.submitted", subjectRef: c.id, payload: { checkin_id: c.id, worker_id: w.id } }] };
  },
});

export const parityCommands: WeftCommand[] = [readyCheckCommand, flagNotReady, execFiguresCommand, sendExecReport, setAutonomy, listMilestonesCommand, listTaxFormsCommand, requestTaxForms, listCheckins, sendCheckins, submitCheckin];
