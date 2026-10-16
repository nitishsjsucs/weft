// Wave 3 routines, prechecks and checklist predicates (docs/wave3.md). Owner: w3-parity-routines.
// prebuilt.ts, prechecks.ts and checks.ts spread these in; add entries here only. New routines ship disabled unless their
// golden path needs them enabled, keep their tools at 8 or fewer, and use new ids (rt_ prefix).
//
// - rt_new_hire_ready: weekday 09:00 PT. Hires starting within 3 business days (onboarding.ready_check): one #new-hires
//   post with a ready line or the blocking items naming owners (a first-day welcome on the start date), plus one Inbox
//   suggestion per blocked hire (onboarding.flag_not_ready). Disabled; GP16 triggers it.
// - rt_monthly_exec_report: the 1st at 09:00 PT. comms.send_exec_report posts to #leadership and emails the
//   leadership list; the text and its numbers are built in code from reports.exec_figures. Disabled.
// - rt_exec_briefing: Mondays 08:00 PT, the weekly variant. Disabled.
// - rt_milestones: weekday 09:00 PT, anniversaries and opted-in birthdays (month and day only) to #general. Disabled.
// - rt_contractor_forms: Mondays 09:00 PT. Contractors whose W-9 or W-8 is missing, expired or lapses within 60 days
//   get an email asking for a new one (contractors.request_tax_forms). Disabled.
// - rt_thirty_day_checkin: weekday 09:00 PT. Day 30 after the start date the hire gets a four-question check-in by
//   email, and one nudge three days later if it is still open (onboarding.send_checkins). The manager's summary is sent
//   when the hire submits (onboarding.submit_checkin, human only). Disabled.
import type { Precheck, ReadOnlyExecutor, RoutineDef } from "@weft/contracts";
import type { Predicate } from "../checks";

const TZ = "America/Los_Angeles";
const OWNER = "usr_dana";
const budget = { steps: 6, usd: 0.05, minutes: 10 };

export const RT_NEW_HIRE_READY: RoutineDef = {
  id: "rt_new_hire_ready", name: "New hire ready check",
  description: "Weekday mornings, check every hire starting within three business days: accounts, laptop, pay, forms, benefits and state registration. Post who is ready in #new-hires, name the owner of anything blocking, and welcome hires on their first day.",
  ownerPrincipalId: OWNER, enabled: false, autonomy: "approve", trigger: { type: "cron", cron: "0 9 * * 1-5", tz: TZ }, filter: null,
  instructions: "Post the derived #new-hires text with comms.send_message as is, then call onboarding.flag_not_ready with the derived worker ids so each blocked hire gets an Inbox suggestion. Then write a one-line final message.",
  tools: ["onboarding.ready_check", "onboarding.get_checklist", "it.list_accounts", "it.list_devices", "tax.list_registrations", "onboarding.flag_not_ready", "comms.send_message"],
  precheck: "new_hire_ready",
  checklist: [
    { id: "posted", label: "post the ready check in #new-hires", check: "posted:#new-hires" },
    { id: "flagged", label: "suggest unblocking each blocked hire", check: "flagged_not_ready:{blocked_count}" },
  ],
  budget, surface: { worthSurfacing: true, channel: "#new-hires" }, source: "prebuilt", taintedBy: null,
};

export const RT_MONTHLY_EXEC_REPORT: RoutineDef = {
  id: "rt_monthly_exec_report", name: "Monthly exec report",
  description: "On the 1st of each month, send leadership the month that just ended: headcount by state, hires, departures and turnover, payroll cost against the month before, and open items.",
  ownerPrincipalId: OWNER, enabled: false, autonomy: "approve", trigger: { type: "cron", cron: "0 9 1 * *", tz: TZ }, filter: null,
  instructions: "Call comms.send_exec_report with the derived arguments; it builds the text from computed figures. Do not restate numbers yourself. Then write a one-line final message.",
  tools: ["reports.exec_figures", "comms.send_exec_report"],
  precheck: "monthly_exec_report",
  checklist: [{ id: "sent", label: "send the report to #leadership", check: "exec_report_sent:monthly:{month}" }],
  budget, surface: { worthSurfacing: false, channel: "#leadership" }, source: "prebuilt", taintedBy: null,
};

export const RT_EXEC_BRIEFING: RoutineDef = {
  id: "rt_exec_briefing", name: "Monday exec briefing",
  description: "Monday mornings, brief leadership on the week ahead: the next payday and its approval deadline, hires starting soon, registrations not active, plus last month's people and payroll numbers.",
  ownerPrincipalId: OWNER, enabled: false, autonomy: "approve", trigger: { type: "cron", cron: "0 8 * * 1", tz: TZ }, filter: null,
  instructions: "Call comms.send_exec_report with the derived arguments; it builds the text from computed figures. Do not restate numbers yourself. Then write a one-line final message.",
  tools: ["reports.exec_figures", "comms.send_exec_report"],
  precheck: "exec_briefing",
  checklist: [{ id: "sent", label: "send the briefing to #leadership", check: "exec_report_sent:weekly:{month}" }],
  budget, surface: { worthSurfacing: false, channel: "#leadership" }, source: "prebuilt", taintedBy: null,
};

export const RT_MILESTONES: RoutineDef = {
  id: "rt_milestones", name: "Celebrate milestones",
  description: "Weekday mornings, celebrate work anniversaries, and birthdays of people who chose to share one (month and day only), in #general.",
  ownerPrincipalId: OWNER, enabled: false, autonomy: "approve", trigger: { type: "cron", cron: "0 9 * * 1-5", tz: TZ }, filter: null,
  instructions: "Post the derived #general text with comms.send_message as is. Then write a one-line final message.",
  tools: ["people.list_milestones", "comms.send_message"],
  precheck: "milestones",
  checklist: [{ id: "posted", label: "celebrate in #general", check: "posted:#general" }],
  budget, surface: { worthSurfacing: false, channel: "#general" }, source: "prebuilt", taintedBy: null,
};

export const RT_CONTRACTOR_FORMS: RoutineDef = {
  id: "rt_contractor_forms", name: "Contractor tax forms",
  description: "Monday mornings, check every contractor's W-9 or W-8 on file. Ask anyone whose form is missing, expired or lapses within 60 days to sign a new one.",
  ownerPrincipalId: OWNER, enabled: false, autonomy: "approve", trigger: { type: "cron", cron: "0 9 * * 1", tz: TZ }, filter: null,
  instructions: "Call contractors.request_tax_forms with the derived arguments; it writes each email from the form on file. Then write a one-line final message.",
  tools: ["contractors.list_tax_forms", "contractors.request_tax_forms"],
  precheck: "contractor_forms",
  checklist: [{ id: "requested", label: "ask for each missing or lapsing form", check: "tax_forms_requested:{request_count}" }],
  budget, surface: { worthSurfacing: false, channel: null }, source: "prebuilt", taintedBy: null,
};

export const RT_THIRTY_DAY_CHECKIN: RoutineDef = {
  id: "rt_thirty_day_checkin", name: "First-month check-in",
  description: "Weekday mornings, send each hire who reached day 30 a short four-question check-in, nudge once three days later if it is still open, and email the manager a summary when it comes back.",
  ownerPrincipalId: OWNER, enabled: false, autonomy: "approve", trigger: { type: "cron", cron: "0 9 * * 1-5", tz: TZ }, filter: null,
  instructions: "Call onboarding.send_checkins with the derived arguments; it writes each email itself. Then write a one-line final message.",
  tools: ["onboarding.list_checkins", "onboarding.send_checkins"],
  precheck: "thirty_day_checkin",
  checklist: [{ id: "sent", label: "send due check-ins and nudges", check: "checkins_sent:{send_count}:{nudge_count}" }],
  budget, surface: { worthSurfacing: false, channel: null }, source: "prebuilt", taintedBy: null,
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

async function read(exec: ReadOnlyExecutor, companyId: string, command: string, args: Obj): Promise<Obj | null> {
  const o = await exec.exec(companyId, command, args);
  return o.ok && o.status === "done" ? obj(o.data) : null;
}

/** The calendar date of an ISO instant in Pacific time. */
const ptDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

interface Hire { worker_id: string; name: string; start_date: string; first_day: boolean; ready: boolean; blocked: { item: string; label: string; owner: string }[] }
const blockedText = (h: Hire) => h.blocked.map((b) => `${b.label} (${b.owner})`).join(", ");
/** Mirrors core parity/ready-check.ts readyLine (the brain may not import core); a test pins them equal. */
export function readyLine(h: Hire): string {
  if (h.first_day && h.ready) return `First day today: please welcome ${h.name}! Accounts, laptop, pay and paperwork are all set.`;
  if (h.first_day) return `First day today: please welcome ${h.name}! Still open: ${blockedText(h)}.`;
  if (h.ready) return `Ready for day one: ${h.name} starts ${h.start_date}. Accounts, laptop, pay and paperwork are all set.`;
  return `Not ready yet: ${h.name} starts ${h.start_date}. Blocking: ${blockedText(h)}.`;
}

export const newHireReady: Precheck = async (ctx, exec) => {
  const asOf = ptDate(ctx.now);
  const r = await read(exec, ctx.companyId, "onboarding.ready_check", { as_of: asOf });
  if (!r) return { action: "skip", reason: "The ready check could not be read." };
  const hires = (Array.isArray(r.hires) ? r.hires : []) as Hire[];
  if (!hires.length) return { action: "skip", reason: `No hire starts between ${asOf} and ${String(r.window_end ?? asOf)}.` };
  const blocked = hires.filter((h) => !h.ready);
  const text = hires.map(readyLine).join("\n");
  const slot = String(obj(ctx.payload).slot ?? ctx.triggerRef);
  return {
    action: "run", severity: blocked.length ? "interrupt" : "digest", subjectRefs: hires.map((h) => h.worker_id),
    findings: { as_of: asOf, window_end: r.window_end, hires: hires.map((h) => ({ worker_id: h.worker_id, start_date: h.start_date, ready: h.ready, first_day: h.first_day, blocked: h.blocked.map((b) => `${b.item}:${b.owner}`) })) },
    derivedArgs: {
      slot, as_of: asOf, blocked_count: blocked.length,
      "comms.send_message": { channel: "#new-hires", text },
      "onboarding.flag_not_ready": { worker_ids: blocked.map((h) => h.worker_id), as_of: asOf },
    },
  };
};

const reportPrecheck = (kind: "monthly" | "weekly"): Precheck => async (ctx, exec) => {
  const asOf = ptDate(ctx.now);
  const f = await read(exec, ctx.companyId, "reports.exec_figures", { kind, as_of: asOf });
  if (!f) return { action: "skip", reason: "The exec figures could not be read." };
  const month = String(f.month ?? asOf.slice(0, 7));
  const cost = obj(f.cost);
  return {
    action: "run", severity: "digest", subjectRefs: [],
    // Findings carry the computed figures; the model only passes kind, month and as_of to comms.send_exec_report,
    // which recomputes and grounds the text, so every number in the post comes from these derived figures.
    findings: { kind, month, headcount: f.headcount, by_state: f.by_state, hires_count: f.hires_count, departures_count: f.departures_count, turnover_pct: f.turnover_pct, total_cost_cents: cost.total_cost_cents, runs: cost.runs, cost_change_pct: f.cost_change_pct },
    derivedArgs: { month, as_of: asOf, "comms.send_exec_report": { kind, month, as_of: asOf } },
  };
};

export const milestones: Precheck = async (ctx, exec) => {
  const asOf = ptDate(ctx.now);
  const r = await read(exec, ctx.companyId, "people.list_milestones", { as_of: asOf });
  const list = (Array.isArray(r?.milestones) ? r!.milestones : []) as { kind: string; worker_id: string; name: string; on: string; years: number | null }[];
  const today = list.filter((m) => m.on === asOf);
  if (!today.length) return { action: "skip", reason: `No anniversaries or shared birthdays on ${asOf}.` };
  const parts = today.map((m) => (m.kind === "birthday" ? `Happy birthday, ${m.name}!` : `Happy ${m.years === 1 ? "first" : `${m.years}-year`} work anniversary, ${m.name}!`));
  return {
    action: "run", severity: "digest", subjectRefs: today.map((m) => m.worker_id),
    // Never a birth year: the findings carry month-day dates and the kind only.
    findings: { as_of: asOf, milestones: today.map((m) => ({ kind: m.kind, worker_id: m.worker_id, years: m.years })) },
    derivedArgs: { as_of: asOf, "comms.send_message": { channel: "#general", text: `Milestones today: ${parts.join(" ")}` } },
  };
};

export const contractorForms: Precheck = async (ctx, exec) => {
  const asOf = ptDate(ctx.now);
  const r = await read(exec, ctx.companyId, "contractors.list_tax_forms", { as_of: asOf, within_days: 60 });
  if (!r) return { action: "skip", reason: "The contractor tax forms could not be read." };
  const rows = (Array.isArray(r.contractors) ? r.contractors : []) as { worker_id: string; state: string; form: string | null; expires_on: string | null }[];
  const due = (Array.isArray(r.needs_request) ? r.needs_request : []) as string[];
  if (!due.length) return { action: "skip", reason: `Every contractor's tax form is current through ${asOf} plus 60 days.` };
  return {
    action: "run", severity: "digest", subjectRefs: due,
    findings: { as_of: asOf, forms: rows.filter((x) => due.includes(x.worker_id)).map((x) => ({ worker_id: x.worker_id, state: x.state, form: x.form, expires_on: x.expires_on })) },
    derivedArgs: { as_of: asOf, request_count: due.length, "contractors.request_tax_forms": { worker_ids: due, as_of: asOf } },
  };
};

export const thirtyDayCheckin: Precheck = async (ctx, exec) => {
  const asOf = ptDate(ctx.now);
  const p = await read(exec, ctx.companyId, "onboarding.list_checkins", { as_of: asOf });
  if (!p) return { action: "skip", reason: "The check-ins could not be read." };
  const send = ((Array.isArray(p.to_send) ? p.to_send : []) as { worker_id: string; due_on: string }[]);
  const nudge = ((Array.isArray(p.to_nudge) ? p.to_nudge : []) as { worker_id: string; checkin_id: string }[]);
  if (!send.length && !nudge.length) return { action: "skip", reason: `No first-month check-in to send or nudge on ${asOf}.` };
  return {
    action: "run", severity: "digest", subjectRefs: [...send.map((r) => r.worker_id), ...nudge.map((r) => r.worker_id)],
    // Statuses only: the hire's written answers never reach the routine.
    findings: { as_of: asOf, send: send.map((r) => ({ worker_id: r.worker_id, due_on: r.due_on })), nudge: nudge.map((r) => ({ worker_id: r.worker_id, checkin_id: r.checkin_id })) },
    derivedArgs: { as_of: asOf, send_count: send.length, nudge_count: nudge.length,
      "onboarding.send_checkins": { send: send.map((r) => r.worker_id), nudge: nudge.map((r) => r.checkin_id), as_of: asOf } },
  };
};

const callsTo = (facts: Parameters<Predicate>[1], command: string) => facts.calls.filter((c) => c.command.replace("__", ".") === command);

export const routines: RoutineDef[] = [RT_NEW_HIRE_READY, RT_MONTHLY_EXEC_REPORT, RT_EXEC_BRIEFING, RT_MILESTONES, RT_CONTRACTOR_FORMS, RT_THIRTY_DAY_CHECKIN];
export const prechecks: Record<string, Precheck> = {
  new_hire_ready: newHireReady, monthly_exec_report: reportPrecheck("monthly"), exec_briefing: reportPrecheck("weekly"), milestones, contractor_forms: contractorForms, thirty_day_checkin: thirtyDayCheckin,
};
export const predicates: Record<string, Predicate> = {
  /** Every blocked hire got a suggestion (a count of 0 passes without a call). */
  flagged_not_ready: ([count = "0"], f) => {
    const want = Number(count) || 0;
    if (want === 0) return true;
    return callsTo(f, "onboarding.flag_not_ready").some((c) => c.status === "done" && ((c.data as { flagged?: { suggestion_id: string | null }[] } | null)?.flagged ?? []).filter((x) => x.suggestion_id).length >= want);
  },
  /** Every contractor due a request got one (a count of 0 passes without a call). */
  tax_forms_requested: ([count = "0"], f) => {
    const want = Number(count) || 0;
    if (want === 0) return true;
    return callsTo(f, "contractors.request_tax_forms").some((c) => {
      if (c.status === "done") return ((c.data as { requested?: unknown[] } | null)?.requested ?? []).length >= want;
      return c.status === "pending_approval" && c.proposalId !== null && !["denied", "expired", "failed", "superseded", "dismissed"].includes(f.proposalStatus(c.proposalId) ?? "pending");
    });
  },
  /** The due check-ins and nudges went out (or wait on a live approval). */
  checkins_sent: ([send = "0", nudge = "0"], f) => {
    const s = Number(send) || 0, n = Number(nudge) || 0;
    if (s === 0 && n === 0) return true;
    return callsTo(f, "onboarding.send_checkins").some((c) => {
      if (c.status === "done") { const d = (c.data ?? {}) as { sent?: unknown[]; nudged?: unknown[] }; return (d.sent ?? []).length >= s && (d.nudged ?? []).length >= n; }
      return c.status === "pending_approval" && c.proposalId !== null && !["denied", "expired", "failed", "superseded", "dismissed"].includes(f.proposalStatus(c.proposalId) ?? "pending");
    });
  },
  exec_report_sent: ([kind = "", month = ""], f) => callsTo(f, "comms.send_exec_report").some((c) => {
    const a = (c.args ?? {}) as { kind?: string; month?: string };
    const live = c.status === "done" || (c.status === "pending_approval" && c.proposalId !== null && !["denied", "expired", "failed", "superseded", "dismissed"].includes(f.proposalStatus(c.proposalId) ?? "pending"));
    return live && a.kind === kind && (month === "" || a.month === month);
  }),
};
