// Wave 4 routines, prechecks and checklist predicates (docs/wave4.md). Owner: w4-parity-people. Planned: rt_life_event_window, rt_benefits_window_reminders, rt_first_day_message, rt_open_enrollment lifecycle.
// prebuilt.ts, prechecks.ts and checks.ts spread these in; add entries here only. New routines ship disabled unless their
// golden path needs them enabled, keep their tools at 8 or fewer, and use new ids (rt_ prefix).
//
// - rt_benefits_window_reminders: weekday 09:00 PT. Every open life-event window whose next reminder date has come gets one
//   reminder email (benefits.send_window_reminders, R1, recomputed in the command); a window stops reminding when the
//   employee elects or picks no change. Opening and closing windows on their dates is the scheduler's system sweep
//   (benefits.close_windows), so this routine never closes anything. Disabled.
// - rt_life_event_window: when a life-event window closes (enrollment_window.closed), propose filing the employee's
//   queued elections with the carrier and the 401(k) provider (benefits.submit_elections, R3, always a proposal). The
//   scheduler records each carrier receipt once the filing is sent. A manual run files every queued filing. Disabled.
import type { Precheck, ReadOnlyExecutor, RoutineDef } from "@weft/contracts";
import type { Predicate } from "../checks";

const TZ = "America/Los_Angeles";
const OWNER = "usr_dana";

export const RT_BENEFITS_WINDOW_REMINDERS: RoutineDef = {
  id: "rt_benefits_window_reminders", name: "Benefits window reminders",
  description: "Weekday mornings, remind each employee with an open life-event benefits window, 14, 7 and 2 days before it closes, until they make their changes or choose no change.",
  ownerPrincipalId: OWNER, enabled: false, autonomy: "approve", trigger: { type: "cron", cron: "0 9 * * 1-5", tz: TZ }, filter: null,
  instructions: "Call benefits.send_window_reminders with the derived arguments; it writes each email itself and skips anyone who already chose. Then write a one-line final message.",
  tools: ["benefits.list_windows", "benefits.send_window_reminders"],
  precheck: "benefits_window_reminders",
  checklist: [{ id: "reminded", label: "remind every due window", check: "window_reminders_sent:{due_count}" }],
  budget: { steps: 6, usd: 0.05, minutes: 10 }, surface: { worthSurfacing: false, channel: null }, source: "prebuilt", taintedBy: null,
};

export const RT_LIFE_EVENT_WINDOW: RoutineDef = {
  id: "rt_life_event_window", name: "Life-event elections filing",
  description: "When an employee's life-event benefits window closes with changes, propose filing them with the carrier and the 401(k) provider; the carrier's receipt is recorded on each filing.",
  ownerPrincipalId: OWNER, enabled: false, autonomy: "approve", trigger: { type: "event", event: "enrollment_window.closed" }, filter: null,
  instructions: "Call benefits.submit_elections with the derived arguments; it files every queued election for the window and needs approval. Then write a one-line final message.",
  tools: ["benefits.list_carrier_submissions", "benefits.submit_elections"],
  precheck: "life_event_filing",
  checklist: [{ id: "filed", label: "propose filing the queued elections", check: "proposal_exists:benefits.submit_elections:{first_submission}" }],
  budget: { steps: 6, usd: 0.05, minutes: 10 }, surface: { worthSurfacing: true, channel: null }, source: "prebuilt", taintedBy: null,
};

type Obj = Record<string, unknown>;
const ptDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

async function read(exec: ReadOnlyExecutor, companyId: string, command: string, args: Obj): Promise<Obj | null> {
  const o = await exec.exec(companyId, command, args);
  return o.ok && o.status === "done" && o.data && typeof o.data === "object" ? (o.data as Obj) : null;
}

interface Win { id: string; workerId: string | null; closesOn: string; nextReminderOn: string | null }
/** Windows whose next reminder date has come (the command recomputes the same list before it sends). */
export const benefitsWindowReminders: Precheck = async (ctx, exec) => {
  const asOf = ptDate(ctx.now);
  const d = await read(exec, ctx.companyId, "benefits.list_windows", { kind: "life_event", status: "open" });
  if (!d) return { action: "skip", reason: "The enrollment windows could not be read." };
  const due = ((Array.isArray(d.windows) ? d.windows : []) as Win[]).filter((w) => w.nextReminderOn !== null && w.nextReminderOn <= asOf && asOf <= w.closesOn);
  if (due.length === 0) return { action: "skip", reason: `No life-event window reminder is due on ${asOf}.` };
  return {
    action: "run", severity: "digest", subjectRefs: due.map((w) => w.id),
    // Ids and dates only: the employee's note never reaches the routine.
    findings: { as_of: asOf, due: due.map((w) => ({ window_id: w.id, worker_id: w.workerId, closes_on: w.closesOn, reminder_on: w.nextReminderOn })) },
    derivedArgs: { as_of: asOf, due_count: due.length, "benefits.send_window_reminders": { window_ids: due.map((w) => w.id), as_of: asOf } },
  };
};

interface Sub { id: string; window_id: string | null; carrier: string }
/** Queued filings for the window that just closed (or every queued filing on a manual run). */
export const lifeEventFiling: Precheck = async (ctx, exec) => {
  const p = (ctx.payload && typeof ctx.payload === "object" ? ctx.payload : {}) as { window_id?: unknown };
  const windowId = typeof p.window_id === "string" && p.window_id.startsWith("ewn_") ? p.window_id : null;
  const d = await read(exec, ctx.companyId, "benefits.list_carrier_submissions", { status: "queued", ...(windowId ? { window_id: windowId } : {}) });
  if (!d) return { action: "skip", reason: "The carrier filings could not be read." };
  const subs = (Array.isArray(d.submissions) ? d.submissions : []) as Sub[];
  if (subs.length === 0) return { action: "skip", reason: windowId ? `Window ${windowId} closed with nothing to file.` : "No queued election filing." };
  const ids = subs.map((x) => x.id).slice(0, 20);
  return {
    action: "run", severity: "digest", subjectRefs: ids,
    findings: { window_id: windowId, filings: subs.slice(0, 20).map((x) => ({ submission_id: x.id, window_id: x.window_id, carrier: x.carrier })) },
    derivedArgs: { first_submission: ids[0]!, count: ids.length, "benefits.submit_elections": windowId ? { window_id: windowId, submission_ids: ids } : { submission_ids: ids } },
  };
};

const callsTo = (facts: Parameters<Predicate>[1], command: string) => facts.calls.filter((c) => c.command.replace("__", ".") === command);

export const routines: RoutineDef[] = [RT_BENEFITS_WINDOW_REMINDERS, RT_LIFE_EVENT_WINDOW];
export const prechecks: Record<string, Precheck> = { benefits_window_reminders: benefitsWindowReminders, life_event_filing: lifeEventFiling };
export const predicates: Record<string, Predicate> = {
  /** The reminders call ran and covered the due windows (a count of 0 passes without a call). */
  window_reminders_sent: ([count = "0"], f) => {
    const want = Number(count) || 0;
    if (want === 0) return true;
    return callsTo(f, "benefits.send_window_reminders").some((c) => c.status === "done" && ((c.data ?? {}) as { count?: number }).count !== undefined);
  },
};
