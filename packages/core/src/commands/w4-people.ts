// Wave 4 commands (docs/wave4.md, W4_PLANNED_COMMANDS in packages/contracts/src/wave4.ts). Owner: w4-parity-people.
// Planned: benefits life events, windows and carrier submissions, people.out_this_week, comms.send_first_day_message. Append here only; commands/index.ts concatenates it, so the other namespace files stay untouched.
// Honest risk and approval from the planned table, zod inputs with no z.record (strict schemas), preview for anything
// that proposes, access "human_only" for a person's own submissions. Update the registry snapshot test in the same commit.
//
// Landed: life-event windows (benefits.report_life_event, human only; benefits.list_life_events and
// benefits.list_windows, R0; benefits.send_window_reminders, R1; benefits.close_windows, the system date sweep) and the
// 30-day check-in form (onboarding.submit_checkin_form, human only; the planned table has no row for it, see
// docs/tracks/w4-parity-people.md). benefits.report_life_event is R2 with approval "always" rather than the planned
// "never": a human caller executes either way (policy.ts), and the t2 registry rule asks every R2 command for approval.
// The employee's own submissions need people:view like time_off.submit, so any employee with a worker record can file.
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { LifeEventKind, Refused } from "@weft/contracts";
import { benefitPlans, carrierSubmissions, checkins, enrollmentWindows, lifeEvents, workers } from "@weft/db";
import { closeOutStragglers, ensureEnrollmentRows, liveOpenEnrollment, OPEN_ENROLLMENT_MAX_DAYS, planYearOf } from "../life-events/open-enrollment";
import { firstDayEmails, firstDayPlan, outThisWeek } from "../life-events/people-week";
import { addDays, daysBetween } from "../life-events/rules";
import type { WeftCommand } from "../shared/deps";
import { DomainRefusal, ptDateOf, readCommand, responseFormatField, riskOf, writeCommand } from "../demo/define";
import { displayName } from "../people/names";
import { lifeEventRule, windowFor } from "../life-events/rules";
import { listLifeEvents, listWindows, reminderEmail, remindersDue, submissionsFor, sweepPlan, workerOfPrincipal } from "../life-events/windows";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import { CheckinAnswers, managerSummaryW4 } from "../life-events/checkin-form";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const FROM = "benefits@larkspur.example";

// ---------------------------------------------------------------- life events and windows

const ReportInput = z.object({ kind: LifeEventKind, event_date: Day, note: z.string().max(400).optional() });
type ReportInput = z.infer<typeof ReportInput>;
const reportLifeEvent = writeCommand<ReportInput>({
  name: "benefits.report_life_event", summary: "Report a qualifying life event (the employee, human only)",
  description: "Human only, the employee's own record: records a marriage, divorce, birth, adoption, move, loss of other coverage or a dependent's death and opens a special enrollment window from the event date for the rule's days, with its source. An event whose window already closed is recorded as rejected.",
  input: ReportInput, domain: "people", needs: "view", effect: "write", risk: riskOf("R2"), approval: "always", access: "human_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const workerId = await workerOfPrincipal(tx, ctx.companyId, ctx.principal.id);
    const [w] = workerId ? await tx.select().from(workers).where(and(eq(workers.id, workerId), eq(workers.companyId, ctx.companyId))).limit(1) : [];
    if (!w) throw new DomainRefusal("DOMAIN_NO_WORKER", "Your sign-in has no worker record yet", "Sign the offer letter first", null);
    if (w.type !== "employee" || !(w.status === "active" || w.status === "onboarding")) throw new DomainRefusal("DOMAIN_NOT_ELIGIBLE", `${displayName(w.firstName, w.lastName)} is not an active employee`, null, null);
    const today = ptDateOf(ctx.now);
    if (i.event_date > today) throw new DomainRefusal("DOMAIN_FUTURE_EVENT", `The event date ${i.event_date} is after today (${today})`, "Report the event on or after the day it happens", null);
    const dup = await tx.select({ id: lifeEvents.id, status: lifeEvents.status }).from(lifeEvents).where(and(eq(lifeEvents.workerId, w.id), eq(lifeEvents.kind, i.kind), eq(lifeEvents.eventDate, i.event_date)));
    if (dup.some((d) => d.status !== "rejected")) throw new DomainRefusal("DOMAIN_DUPLICATE_LIFE_EVENT", `This ${i.kind} on ${i.event_date} is already reported as ${dup[0]!.id}`, null, null);
    const rule = lifeEventRule(i.kind);
    const win = windowFor(i.kind, i.event_date);
    const id = await deps.newId("lev_");
    const base = { id, workerId: w.id, kind: i.kind, eventDate: i.event_date, note: i.note ?? "", reportedBy: ctx.principal.id, reportedAt: ctx.now };
    const source = { basis: rule.basis, citation: rule.citation, source: rule.source, days: rule.days };
    if (win.closesOn < today) {
      await tx.insert(lifeEvents).values({ ...base, status: "rejected", windowId: null });
      return { data: { life_event_id: id, status: "rejected", window_id: null, would_have_closed_on: win.closesOn, ...source },
        summary: `Recorded the ${rule.label.toLowerCase()} on ${i.event_date}; its ${rule.days}-day window closed on ${win.closesOn}, so no window opened. The people team can review it.`,
        events: [{ type: "life_event.reported", subjectRef: id, payload: { life_event_id: id, worker_id: w.id } }] };
    }
    const wid = await deps.newId("ewn_");
    await tx.insert(enrollmentWindows).values({ id: wid, companyId: ctx.companyId, workerId: w.id, kind: "life_event", lifeEventId: id, opensOn: win.opensOn, closesOn: win.closesOn, status: "open", remindersSent: 0, createdAt: ctx.now });
    await tx.insert(lifeEvents).values({ ...base, status: "window_open", windowId: wid });
    return {
      data: { life_event_id: id, status: "window_open", window_id: wid, opens_on: win.opensOn, closes_on: win.closesOn, ...source },
      summary: `Recorded the ${rule.label.toLowerCase()} on ${i.event_date} and opened a benefits window until ${win.closesOn} (${rule.citation})`,
      events: [
        { type: "life_event.reported", subjectRef: id, payload: { life_event_id: id, worker_id: w.id } },
        { type: "enrollment_window.opened", subjectRef: wid, payload: { window_id: wid } },
      ],
    };
  },
});

const ListEventsInput = z.object({ worker_id: z.string().startsWith("wrk_").optional(), status: z.enum(["reported", "window_open", "elected", "closed_no_change", "expired", "rejected"]).optional(), ...responseFormatField });
type ListEventsInput = z.infer<typeof ListEventsInput>;
const listLifeEventsCommand = readCommand({
  name: "benefits.list_life_events", domain: "benefits",
  summary: "Reported life events with their window dates and the rule behind each window.",
  description: "Life events employees reported (marriage, birth, move and the rest), optionally for one worker or status: kind, event date, status, the window's open and close dates, and the rule's citation and source URL. The employee's own note is never included. Example: {\"worker_id\":null,\"status\":\"window_open\"}",
  input: ListEventsInput,
  async run(i: ListEventsInput, ctx, deps) {
    const rows = await listLifeEvents(deps.tx, ctx.companyId, { workerId: i.worker_id, status: i.status });
    return { data: { count: rows.length, life_events: rows }, summary: `${rows.length} life events${i.status ? ` ${i.status}` : ""}` };
  },
});

const ListWindowsInput = z.object({ worker_id: z.string().startsWith("wrk_").optional(), kind: z.enum(["new_hire", "life_event", "open_enrollment"]).optional(), status: z.enum(["scheduled", "open", "closed", "cancelled"]).optional(), ...responseFormatField });
type ListWindowsInput = z.infer<typeof ListWindowsInput>;
const listWindowsCommand = readCommand({
  name: "benefits.list_windows", domain: "benefits",
  summary: "Enrollment windows: who, which kind, open and close dates, reminders sent and the next reminder date.",
  description: "Enrollment windows (new_hire, life_event, open_enrollment) with status, open and close dates, reminders sent, the next reminder date and the rule's source for life-event windows. Example: {\"worker_id\":null,\"kind\":\"life_event\",\"status\":\"open\"}",
  input: ListWindowsInput,
  async run(i: ListWindowsInput, ctx, deps) {
    const rows = await listWindows(deps.tx, ctx.companyId, { workerId: i.worker_id, kind: i.kind, status: i.status });
    return { data: { count: rows.length, windows: rows }, summary: `${rows.length} enrollment windows` };
  },
});

const RemindInput = z.object({ window_ids: z.array(z.string().startsWith("ewn_")).max(50).optional(), as_of: Day.optional() });
type RemindInput = z.infer<typeof RemindInput>;
const sendWindowReminders = writeCommand<RemindInput>({
  name: "benefits.send_window_reminders", summary: "Email reminders for open life-event windows that are due",
  description: "Email each employee whose life-event window is open, who has not elected, and whose next reminder date (14, 7 and 2 days before the close) has come; one email per window per run. Due windows are recomputed here; window_ids narrows them. Example: {\"window_ids\":null,\"as_of\":null}",
  input: RemindInput, domain: "comms", needs: "edit", effect: "external", risk: riskOf("R1"), approval: "never", reversible: false, preview: null,
  tiers: { main: "executable", task: "delegated" }, afterPending: "propose",
  async run(i, ctx, deps) {
    const due = (await remindersDue(deps.tx, ctx.companyId, i.as_of ?? ptDateOf(ctx.now))).filter((r) => !i.window_ids || i.window_ids.includes(r.window_id));
    const sent: { window_id: string; worker_id: string; email_id: string; closes_on: string }[] = [];
    for (const r of due) {
      const [w] = await deps.tx.select({ email: workers.workEmail }).from(workers).where(eq(workers.id, r.worker_id));
      const [ev] = await deps.tx.select({ eventDate: lifeEvents.eventDate }).from(lifeEvents).where(eq(lifeEvents.id, r.life_event_id));
      if (!w || !ev) continue;
      const m = reminderEmail(r.name, r.kind, ev.eventDate, r.closes_on);
      const mail = await deps.sims.email.send({ to: w.email, from: FROM, subject: m.subject, body: m.body, kind: "nudge", relatedRef: r.window_id });
      await deps.tx.update(enrollmentWindows).set({ remindersSent: r.sets_sent_to }).where(eq(enrollmentWindows.id, r.window_id));
      sent.push({ window_id: r.window_id, worker_id: r.worker_id, email_id: mail.id, closes_on: r.closes_on });
    }
    return { data: { sent, count: sent.length }, summary: `Sent ${sent.length} benefits window reminders` };
  },
});

const SweepInput = z.object({ as_of: Day.optional() });
type SweepInput = z.infer<typeof SweepInput>;
const closeWindows = writeCommand<SweepInput>({
  name: "benefits.close_windows", summary: "System date sweep: open scheduled windows and close windows past their date",
  description: "System command (svc_scheduler): opens scheduled windows whose open date has come and closes windows past their close date. A life event whose window closes with no election becomes expired.",
  input: SweepInput, domain: "benefits", needs: "edit", effect: "write", risk: riskOf("R1"), approval: "never", access: "system_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const p = await sweepPlan(tx, ctx.companyId, i.as_of ?? ptDateOf(ctx.now));
    const events: { type: string; subjectRef: string; payload: unknown }[] = [];
    for (const o of p.to_open) {
      await tx.update(enrollmentWindows).set({ status: "open" }).where(eq(enrollmentWindows.id, o.window_id));
      if (o.kind === "open_enrollment") {
        const [row] = await tx.select({ closesOn: enrollmentWindows.closesOn }).from(enrollmentWindows).where(eq(enrollmentWindows.id, o.window_id));
        if (row) await ensureEnrollmentRows(tx, ctx.companyId, planYearOf(row.closesOn), deps.newId);
      }
      events.push({ type: "enrollment_window.opened", subjectRef: o.window_id, payload: { window_id: o.window_id } });
    }
    const expired: string[] = [];
    const closedOut: { window_id: string; plan_year: number; people: { worker_id: string; name: string; was: string }[] }[] = [];
    for (const c of p.to_close) {
      await tx.update(enrollmentWindows).set({ status: "closed" }).where(eq(enrollmentWindows.id, c.window_id));
      // Open enrollment closes on its date: whoever still had not chosen is closed out as waived (the active default).
      if (c.kind === "open_enrollment") closedOut.push({ window_id: c.window_id, plan_year: planYearOf(c.closes_on), people: await closeOutStragglers(tx, ctx.companyId, planYearOf(c.closes_on)) });
      if (c.life_event_id) {
        const [ev] = await tx.select({ status: lifeEvents.status }).from(lifeEvents).where(eq(lifeEvents.id, c.life_event_id));
        if (ev?.status === "window_open") { await tx.update(lifeEvents).set({ status: "expired" }).where(eq(lifeEvents.id, c.life_event_id)); expired.push(c.life_event_id); }
      }
      events.push({ type: "enrollment_window.closed", subjectRef: c.window_id, payload: { window_id: c.window_id } });
    }
    const waived = closedOut.reduce((n, x) => n + x.people.length, 0);
    return { data: { opened: p.to_open.map((o) => o.window_id), closed: p.to_close.map((c) => c.window_id), expired_life_events: expired, open_enrollment_closed_out: closedOut },
      summary: `Opened ${p.to_open.length} and closed ${p.to_close.length} enrollment windows${closedOut.length ? `; ${waived} ${waived === 1 ? "person" : "people"} had not chosen and are recorded as waived` : ""}`, events };
  },
});

const ElectInput = z.object({
  window_id: z.string().startsWith("ewn_"),
  elections: z.array(z.object({ plan_id: z.string().startsWith("bpl_"), tier: z.enum(["ee", "ee_spouse", "ee_children", "family"]).optional(), deferral_bps: z.number().int().min(0).max(10_000).optional() })).max(6),
  no_change: z.boolean().optional(),
});
type ElectInput = z.infer<typeof ElectInput>;
const electInWindow = writeCommand<ElectInput>({
  name: "benefits.elect_in_window", summary: "Make your benefit changes in an open window (the employee, human only)",
  description: "Human only, the employee's own open life-event window: records the plan changes (one plan per type, a coverage tier for medical, dental and vision, a deferral for the 401(k)) or no change, and closes the window, which stops its reminders. Changes are queued for each carrier; filing them is benefits.submit_elections.",
  input: ElectInput, domain: "people", needs: "view", effect: "write", risk: riskOf("R2"), approval: "always", access: "human_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const own = await workerOfPrincipal(tx, ctx.companyId, ctx.principal.id);
    const [w] = await tx.select().from(enrollmentWindows).where(and(eq(enrollmentWindows.id, i.window_id), eq(enrollmentWindows.companyId, ctx.companyId)));
    if (!w || !own || w.workerId !== own || w.kind !== "life_event" || !w.lifeEventId) throw new Refused("UNKNOWN_REFERENCE", `No window ${i.window_id}.`);
    const today = ptDateOf(ctx.now);
    if (w.status !== "open" || today > w.closesOn) throw new DomainRefusal("DOMAIN_WINDOW_CLOSED", `Window ${w.id} closed on ${w.closesOn}`, "Changes outside a window wait for open enrollment", null);
    if (!i.no_change && i.elections.length === 0) throw new DomainRefusal("DOMAIN_NO_CHANGES", "Pick at least one plan change, or choose no change", null, { window_id: w.id, elections: [], no_change: true });
    const plans = await tx.select().from(benefitPlans).where(eq(benefitPlans.companyId, ctx.companyId));
    const seen = new Set<string>();
    const lines: { plan_id: string; plan: string; type: string; carrier: string; tier: string | null; employee_cents: number | null; deferral_bps: number | null }[] = [];
    for (const e of i.no_change ? [] : i.elections) {
      const plan = plans.find((x) => x.id === e.plan_id);
      if (!plan) throw new DomainRefusal("DOMAIN_NOT_FOUND", `No benefit plan ${e.plan_id}`, "Use a plan id from the plan list", null);
      if (seen.has(plan.type)) throw new DomainRefusal("DOMAIN_DUPLICATE_PLAN_TYPE", `More than one ${plan.type} plan elected`, "Pick one plan per type", null);
      seen.add(plan.type);
      if (plan.type === "hsa") throw new DomainRefusal("DOMAIN_HSA_WITH_HR", "HSA contribution changes are set up with HR", null, null);
      if (plan.type === "401k") {
        const m = JSON.parse(plan.matchJson ?? "{}") as { min_deferral_bps?: number; max_deferral_bps?: number };
        const bps = e.deferral_bps ?? -1;
        if (bps < (m.min_deferral_bps ?? 0) || bps > (m.max_deferral_bps ?? 10_000)) throw new DomainRefusal("DOMAIN_BAD_DEFERRAL", `Deferral ${bps} bps is outside ${m.min_deferral_bps ?? 0} to ${m.max_deferral_bps ?? 10_000}`, null, null);
        lines.push({ plan_id: plan.id, plan: plan.name, type: plan.type, carrier: plan.carrier, tier: null, employee_cents: null, deferral_bps: bps });
      } else {
        const prices = JSON.parse(plan.pricesJson) as Record<string, number>;
        if (!e.tier || typeof prices[e.tier] !== "number") throw new DomainRefusal("DOMAIN_BAD_TIER", `${plan.name} needs a coverage tier`, "Use ee, ee_spouse, ee_children or family", null);
        lines.push({ plan_id: plan.id, plan: plan.name, type: plan.type, carrier: plan.carrier, tier: e.tier, employee_cents: prices[e.tier]!, deferral_bps: null });
      }
    }
    const queued: { submission_id: string; carrier: string; plans: string[] }[] = [];
    for (const carrier of [...new Set(lines.map((l) => l.carrier))].sort()) {
      const id = await deps.newId("csb_");
      const mine = lines.filter((l) => l.carrier === carrier);
      await tx.insert(carrierSubmissions).values({ id, workerId: own, windowId: w.id, carrier, electionsJson: JSON.stringify({ effective_on: w.opensOn, lines: mine }), status: "queued", sentAt: null, confirmedAt: null, receiptRef: null, proposalId: null, createdAt: ctx.now });
      queued.push({ submission_id: id, carrier, plans: mine.map((l) => l.plan) });
    }
    await tx.update(enrollmentWindows).set({ status: "closed" }).where(eq(enrollmentWindows.id, w.id));
    await tx.update(lifeEvents).set({ status: i.no_change ? "closed_no_change" : "elected" }).where(eq(lifeEvents.id, w.lifeEventId));
    return {
      data: { window_id: w.id, life_event_id: w.lifeEventId, status: i.no_change ? "closed_no_change" : "elected", queued },
      summary: i.no_change ? `Recorded no change for window ${w.id} and closed it` : `Recorded ${lines.length} benefit changes for window ${w.id}; ${queued.length} carrier filings are queued`,
      events: [{ type: "enrollment_window.closed", subjectRef: w.id, payload: { window_id: w.id } }],
    };
  },
});

// ---------------------------------------------------------------- carrier filings

type SubRow = typeof carrierSubmissions.$inferSelect;
interface FilingLine { plan_id: string; plan: string; type: string; carrier: string; tier: string | null; employee_cents: number | null; deferral_bps: number | null }
const linesOf = (r: SubRow) => (JSON.parse(r.electionsJson) as { effective_on: string; lines: FilingLine[] });
async function subView(deps: Parameters<WeftCommand["run"]>[2], rows: SubRow[]) {
  const ids = [...new Set(rows.map((r) => r.workerId))];
  const ppl = ids.length ? await deps.tx.select({ id: workers.id, first: workers.firstName, last: workers.lastName }).from(workers).where(inArray(workers.id, ids)) : [];
  const nm = new Map(ppl.map((p) => [p.id, displayName(p.first, p.last)]));
  return rows.map((r) => {
    const e = linesOf(r);
    return { id: r.id, worker_id: r.workerId, name: nm.get(r.workerId) ?? r.workerId, window_id: r.windowId, carrier: r.carrier, status: r.status, effective_on: e.effective_on,
      lines: e.lines.map((l) => ({ plan: l.plan, type: l.type, tier: l.tier, deferral_bps: l.deferral_bps })), sent_at: r.sentAt, confirmed_at: r.confirmedAt, receipt_ref: r.receiptRef, proposal_id: r.proposalId };
  });
}

const ListSubsInput = z.object({ worker_id: z.string().startsWith("wrk_").optional(), window_id: z.string().startsWith("ewn_").optional(), status: z.enum(["queued", "sent", "confirmed", "rejected"]).optional(), ...responseFormatField });
type ListSubsInput = z.infer<typeof ListSubsInput>;
const listCarrierSubmissions = readCommand({
  name: "benefits.list_carrier_submissions", domain: "benefits",
  summary: "Benefit election filings with carriers and the 401(k) provider, with status and receipt.",
  description: "Election filings per carrier (queued, sent, confirmed, rejected) for a worker, a window or a status: the plans and tiers or deferral, when it was sent and confirmed, and the carrier's receipt reference. Example: {\"worker_id\":null,\"window_id\":null,\"status\":\"queued\"}",
  input: ListSubsInput,
  async run(i: ListSubsInput, ctx, deps) {
    const people = await deps.tx.select({ id: workers.id }).from(workers).where(eq(workers.companyId, ctx.companyId));
    const ids = i.worker_id ? [i.worker_id] : people.map((p) => p.id);
    const rows = await submissionsFor(deps.tx, { workerIds: ids, status: i.status, windowId: i.window_id });
    return { data: { count: rows.length, submissions: await subView(deps, rows) }, summary: `${rows.length} carrier filings${i.status ? ` ${i.status}` : ""}` };
  },
});

const SubmitInput = z.object({ window_id: z.string().startsWith("ewn_").optional(), submission_ids: z.array(z.string().startsWith("csb_")).max(20).optional() });
type SubmitInput = z.infer<typeof SubmitInput>;
async function queuedFor(i: SubmitInput, ctx: { companyId: string }, deps: Parameters<WeftCommand["run"]>[2]): Promise<SubRow[]> {
  if (!i.window_id && !i.submission_ids?.length) throw new DomainRefusal("DOMAIN_NO_FILINGS_NAMED", "Name a window or the filings to send", "Use benefits.list_carrier_submissions with status queued", { window_id: "ewn_0001", submission_ids: null });
  const people = await deps.tx.select({ id: workers.id }).from(workers).where(eq(workers.companyId, ctx.companyId));
  const rows = (await submissionsFor(deps.tx, { workerIds: people.map((p) => p.id), status: "queued", windowId: i.window_id })).filter((r) => !i.submission_ids || i.submission_ids.includes(r.id));
  if (rows.length === 0) throw new DomainRefusal("DOMAIN_NOTHING_QUEUED", "No queued filings match", "Only queued filings can be sent; list them with benefits.list_carrier_submissions", null);
  return rows;
}
const submitElections = writeCommand<SubmitInput>({
  name: "benefits.submit_elections", summary: "File queued benefit elections with the carrier and the 401(k) provider",
  description: "Sends each queued election filing for a window (or the named filings) to its carrier or the 401(k) provider; the receipt comes back on the next scheduler tick and is recorded on the filing. External and not reversible, so it is always a proposal. Example: {\"window_id\":\"ewn_0001\",\"submission_ids\":null}",
  input: SubmitInput, domain: "comms", needs: "edit", effect: "external", risk: riskOf("R3"), approval: "always", afterPending: "propose", reversible: false,
  tiers: { main: "executable", task: "delegated" },
  async preview(i, ctx, deps) {
    const rows = await queuedFor(i, ctx, deps);
    const v = await subView(deps, rows);
    const carriers = [...new Set(v.map((r) => r.carrier))];
    return {
      title: `File ${v.length} benefit election ${v.length === 1 ? "filing" : "filings"} with ${carriers.join(" and ")}`, diff: [],
      content: v.map((r) => ({ label: `${r.carrier}, ${r.name}`, text: `${r.lines.map((l) => `${l.plan}${l.tier ? ` (${l.tier})` : ""}${l.deferral_bps !== null ? ` (${l.deferral_bps / 100}% of pay)` : ""}`).join(", ")}, effective ${r.effective_on}` })),
      moneyCents: null, subjectRef: rows.map((r) => r.id).join(","),
      subjectHash: sha256Hex(canonicalJson(rows.map((r) => [r.id, r.electionsJson]))), evidence: rows.map((r) => ({ label: "filing", ref: r.id })),
    };
  },
  async run(i, ctx, deps) {
    const rows = await queuedFor(i, ctx, deps);
    for (const r of rows) await deps.tx.update(carrierSubmissions).set({ status: "sent", sentAt: ctx.now, proposalId: ctx.approvedProposalId }).where(eq(carrierSubmissions.id, r.id));
    return { data: { sent: rows.map((r) => ({ submission_id: r.id, carrier: r.carrier })) }, summary: `Sent ${rows.length} benefit election filings to ${[...new Set(rows.map((r) => r.carrier))].join(" and ")}` };
  },
});

const ReceiptInput = z.object({
  receipts: z.array(z.object({ submission_id: z.string().startsWith("csb_"), status: z.enum(["confirmed", "rejected"]), receipt_ref: z.string().max(40).optional(), reason: z.string().max(200).optional() })).max(50).optional(),
});
type ReceiptInput = z.infer<typeof ReceiptInput>;
const recordCarrierReceipt = writeCommand<ReceiptInput>({
  name: "benefits.record_carrier_receipt", summary: "System: record carrier receipts for sent election filings",
  description: "System command (svc_scheduler): records the carrier's or 401(k) provider's answer on each sent filing, confirmed with a receipt reference or rejected with a reason, and emits carrier.submission_confirmed for each confirmation. Filings that are not sent are skipped.",
  input: ReceiptInput, domain: "benefits", needs: "edit", effect: "write", risk: riskOf("R1"), approval: "never", access: "system_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const out: { submission_id: string; status: string; receipt_ref: string | null }[] = [];
    const events: { type: string; subjectRef: string; payload: unknown }[] = [];
    for (const r of i.receipts ?? []) {
      const [row] = await deps.tx.select().from(carrierSubmissions).where(eq(carrierSubmissions.id, r.submission_id));
      if (!row || row.status !== "sent") continue;
      const [w] = await deps.tx.select({ c: workers.companyId }).from(workers).where(eq(workers.id, row.workerId));
      if (w?.c !== ctx.companyId) continue;
      if (r.status === "confirmed" && r.receipt_ref) {
        await deps.tx.update(carrierSubmissions).set({ status: "confirmed", confirmedAt: ctx.now, receiptRef: r.receipt_ref }).where(eq(carrierSubmissions.id, row.id));
        events.push({ type: "carrier.submission_confirmed", subjectRef: row.id, payload: { submission_id: row.id } });
        out.push({ submission_id: row.id, status: "confirmed", receipt_ref: r.receipt_ref });
      } else {
        await deps.tx.update(carrierSubmissions).set({ status: "rejected", confirmedAt: null, receiptRef: null }).where(eq(carrierSubmissions.id, row.id));
        out.push({ submission_id: row.id, status: "rejected", receipt_ref: null });
      }
    }
    return { data: { recorded: out }, summary: `Recorded ${out.length} carrier answers`, events };
  },
});

// ---------------------------------------------------------------- open enrollment with real dates

const OpenWindowInput = z.object({ kind: z.literal("open_enrollment"), opens_on: Day, closes_on: Day });
type OpenWindowInput = z.infer<typeof OpenWindowInput>;
const openWindow = writeCommand<OpenWindowInput>({
  name: "benefits.open_window", summary: "Schedule the company's open enrollment with real open and close dates",
  description: "Schedules open enrollment for the plan year after closes_on: one company window, at most 60 days, one live at a time. The scheduler opens it on its date and closes it after the close date; whoever had not chosen is then recorded as waived. Example: {\"kind\":\"open_enrollment\",\"opens_on\":\"2026-11-02\",\"closes_on\":\"2026-11-20\"}",
  input: OpenWindowInput, domain: "benefits", needs: "edit", effect: "write", risk: riskOf("R1"), approval: "never", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const today = ptDateOf(ctx.now);
    if (i.closes_on < i.opens_on) throw new DomainRefusal("DOMAIN_BAD_DATES", `The close date ${i.closes_on} is before the open date ${i.opens_on}`, "Close on or after the open date", null);
    if (i.closes_on < today) throw new DomainRefusal("DOMAIN_BAD_DATES", `The close date ${i.closes_on} has passed (today is ${today})`, "Pick a close date from today on", null);
    const span = daysBetween(i.opens_on, i.closes_on) + 1;
    if (span > OPEN_ENROLLMENT_MAX_DAYS) throw new DomainRefusal("DOMAIN_WINDOW_TOO_LONG", `Open enrollment of ${span} days is longer than ${OPEN_ENROLLMENT_MAX_DAYS}`, `Close by ${addDays(i.opens_on, OPEN_ENROLLMENT_MAX_DAYS - 1)}`, null);
    const live = await liveOpenEnrollment(tx, ctx.companyId);
    if (live) throw new DomainRefusal("DOMAIN_OPEN_ENROLLMENT_LIVE", `Open enrollment ${live.id} is already ${live.status} (${live.opensOn} to ${live.closesOn})`, null, null);
    const planYear = planYearOf(i.closes_on);
    const opensNow = i.opens_on <= today;
    const id = await deps.newId("ewn_");
    await tx.insert(enrollmentWindows).values({ id, companyId: ctx.companyId, workerId: null, kind: "open_enrollment", lifeEventId: null, opensOn: i.opens_on, closesOn: i.closes_on, status: opensNow ? "open" : "scheduled", remindersSent: 0, createdAt: ctx.now });
    const added = opensNow ? await ensureEnrollmentRows(tx, ctx.companyId, planYear, deps.newId) : 0;
    return {
      data: { window_id: id, plan_year: planYear, opens_on: i.opens_on, closes_on: i.closes_on, status: opensNow ? "open" : "scheduled", enrollment_rows_added: added },
      summary: `${opensNow ? "Opened" : "Scheduled"} open enrollment for ${planYear}, ${i.opens_on} to ${i.closes_on}`,
      events: opensNow ? [{ type: "enrollment_window.opened", subjectRef: id, payload: { window_id: id } }] : [],
    };
  },
});

// ---------------------------------------------------------------- the people week: out this week and first days

const OutInput = z.object({ as_of: Day.optional(), department_id: z.string().startsWith("dpt_").optional(), ...responseFormatField });
type OutInput = z.infer<typeof OutInput>;
const outThisWeekCommand = readCommand({
  name: "people.out_this_week", domain: "people",
  summary: "Who is out this week (Monday to Sunday), from approved time off, as one digest line.",
  description: "People with approved or taken time off on a working day of the week holding as_of (default today), Monday to Sunday, with the days they are out and a ready digest line. Names and days only: never the kind of leave or the employee's reason. Example: {\"as_of\":null,\"department_id\":null}",
  input: OutInput,
  async run(i: OutInput, ctx, deps) {
    const r = await outThisWeek(deps.tx, ctx.companyId, i.as_of ?? ptDateOf(ctx.now), { departmentId: i.department_id });
    return { data: r, summary: r.line };
  },
});

const FirstDaysInput = z.object({ as_of: Day.optional(), ...responseFormatField });
type FirstDaysInput = z.infer<typeof FirstDaysInput>;
const listFirstDays = readCommand({
  name: "onboarding.list_first_days", domain: "people",
  summary: "Hires whose first day is today, and whether their first-day message already went out.",
  description: "Employees whose start date is as_of (default today): due (no first-day message yet) with their manager and up to eight teammates, and sent (worker ids already welcomed). Example: {\"as_of\":null}",
  input: FirstDaysInput,
  async run(i: FirstDaysInput, ctx, deps) {
    const p = await firstDayPlan(deps.tx, ctx.companyId, i.as_of ?? ptDateOf(ctx.now));
    return { data: p, summary: `${p.due.length} first-day messages due, ${p.sent.length} already sent` };
  },
});

const FirstDayInput = z.object({ worker_ids: z.array(z.string().startsWith("wrk_")).min(1).max(20), as_of: Day.optional() });
type FirstDayInput = z.infer<typeof FirstDayInput>;
async function firstDayWork(i: FirstDayInput, ctx: { companyId: string; now: string }, deps: Parameters<WeftCommand["run"]>[2]) {
  const p = await firstDayPlan(deps.tx, ctx.companyId, i.as_of ?? ptDateOf(ctx.now));
  return p.due.filter((h) => i.worker_ids.includes(h.worker_id));
}
const sendFirstDayMessage = writeCommand<FirstDayInput>({
  name: "comms.send_first_day_message", summary: "Email the welcome to each hire whose first day is today, and tell their team",
  description: "On a hire's start date, emails the hire a welcome (their manager's name, the portal) and emails the manager and up to eight teammates that the hire starts today. Names and dates only, written by Weft, not the model. Once per hire: anyone already welcomed or not starting today is skipped. R3 like the check-in emails. Example: {\"worker_ids\":[\"wrk_0049\"],\"as_of\":null}",
  input: FirstDayInput, domain: "comms", needs: "edit", effect: "external", risk: riskOf("R3"), approval: "always", autoAllow: "untainted",
  afterPending: "propose", reversible: false, tiers: { main: "executable", task: "delegated" },
  async preview(i, ctx, deps) {
    const due = await firstDayWork(i, ctx, deps);
    return { title: `Send ${due.length} first-day ${due.length === 1 ? "welcome" : "welcomes"}`, diff: [],
      content: due.map((h) => ({ label: h.name, text: `Welcome to ${h.name}; a note to ${[h.manager, ...h.team.map((t) => t.name)].filter(Boolean).length} teammates` })), moneyCents: null,
      subjectRef: due.map((h) => h.worker_id).join(",") || "first_day", subjectHash: sha256Hex(canonicalJson(due.map((h) => [h.worker_id, h.start_date]))), evidence: due.map((h) => ({ label: "worker", ref: h.worker_id })) };
  },
  async run(i, ctx, deps) {
    const due = await firstDayWork(i, ctx, deps);
    const ids = [...new Set(due.flatMap((h) => [h.worker_id, ...(h.manager_id ? [h.manager_id] : []), ...h.team.map((t) => t.worker_id)]))];
    const mail = new Map((ids.length ? await deps.tx.select({ id: workers.id, email: workers.workEmail }).from(workers).where(inArray(workers.id, ids)) : []).map((r) => [r.id, r.email]));
    const sent: { worker_id: string; hire_email_id: string | null; team_email_ids: string[] }[] = [];
    for (const h of due) {
      const m = firstDayEmails(h);
      const to = mail.get(h.worker_id);
      const hireId = to ? (await deps.sims.email.send({ to, from: "people@larkspur.example", subject: m.hire.subject, body: m.hire.body, kind: "generic", relatedRef: h.worker_id })).id : null;
      const team: string[] = [];
      for (const t of [...(h.manager_id ? [h.manager_id] : []), ...h.team.map((x) => x.worker_id)]) {
        const addr = mail.get(t);
        if (addr) team.push((await deps.sims.email.send({ to: addr, from: "people@larkspur.example", subject: m.team.subject, body: m.team.body, kind: "generic", relatedRef: h.worker_id })).id);
      }
      sent.push({ worker_id: h.worker_id, hire_email_id: hireId, team_email_ids: team });
    }
    return { data: { sent, count: sent.length }, summary: `Sent ${sent.length} first-day ${sent.length === 1 ? "welcome" : "welcomes"}`,
      events: sent.map((s) => ({ type: "worker.first_day", subjectRef: s.worker_id, payload: { worker_id: s.worker_id } })) };
  },
});

// ---------------------------------------------------------------- the 30-day check-in form

const SubmitFormInput = z.object({ checkin_id: z.string().startsWith("chk_"), answers: CheckinAnswers });
type SubmitFormInput = z.infer<typeof SubmitFormInput>;
const submitCheckinForm = writeCommand<SubmitFormInput>({
  name: "onboarding.submit_checkin_form", summary: "Answer your first-month check-in (the hire, human only)",
  description: "Human only, the hire's own open check-in: stores the five CHECKIN_QUESTIONS answers and emails the manager the scale and the two yes or no answers. The written answers stay in Weft for the hire and their manager and never reach an agent.",
  input: SubmitFormInput, domain: "people", needs: "view", effect: "write", risk: riskOf("R1"), approval: "never", access: "human_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const own = await workerOfPrincipal(tx, ctx.companyId, ctx.principal.id);
    const [c] = await tx.select().from(checkins).where(eq(checkins.id, i.checkin_id));
    // Someone else's check-in reads as missing, so ids cannot be probed.
    if (!c || !own || c.workerId !== own) throw new Refused("UNKNOWN_REFERENCE", `No check-in ${i.checkin_id}.`);
    if (c.status !== "sent" && c.status !== "nudged") throw new DomainRefusal("DOMAIN_CHECKIN_CLOSED", `Check-in ${c.id} is ${c.status}`, "Only an open check-in takes answers", null);
    const [w] = await tx.select().from(workers).where(and(eq(workers.id, c.workerId), eq(workers.companyId, ctx.companyId)));
    if (!w) throw new Refused("UNKNOWN_REFERENCE", `No check-in ${i.checkin_id}.`);
    const [mgr] = w.managerId ? await tx.select({ email: workers.workEmail }).from(workers).where(eq(workers.id, w.managerId)) : [];
    await tx.update(checkins).set({ status: "submitted", answersJson: JSON.stringify({ form: "w4", ...i.answers }), submittedAt: ctx.now }).where(eq(checkins.id, c.id));
    const m = managerSummaryW4(displayName(w.firstName, w.lastName), i.answers);
    const mail = await deps.sims.email.send({ to: mgr?.email ?? "people@larkspur.example", from: "agent@larkspur.example", subject: m.subject, body: m.body, kind: "generic", relatedRef: c.id });
    return { data: { checkin_id: c.id, worker_id: w.id, status: "submitted", summary_email_id: mail.id }, summary: `Recorded the first-month check-in ${c.id} and emailed the manager a summary`,
      events: [{ type: "checkin.submitted", subjectRef: c.id, payload: { checkin_id: c.id, worker_id: w.id } }] };
  },
});

export const w4PeopleCommands: WeftCommand[] = [
  reportLifeEvent, listLifeEventsCommand, listWindowsCommand, sendWindowReminders, closeWindows, electInWindow,
  listCarrierSubmissions, submitElections, recordCarrierReceipt, submitCheckinForm,
  openWindow, outThisWeekCommand, listFirstDays, sendFirstDayMessage,
];

