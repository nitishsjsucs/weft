// Wave 4 routines, prechecks and checklist predicates (docs/wave4.md). Owner: w4-parity-people. Planned: rt_life_event_window, rt_benefits_window_reminders, rt_first_day_message, rt_open_enrollment lifecycle.
// prebuilt.ts, prechecks.ts and checks.ts spread these in; add entries here only. New routines ship disabled unless their
// golden path needs them enabled, keep their tools at 8 or fewer, and use new ids (rt_ prefix).
//
// - rt_life_event_window: weekday 09:00 PT. Every open life-event window whose next reminder date has come gets one
//   reminder email (benefits.send_window_reminders, R1, recomputed in the command); a window stops reminding when the
//   employee elects or picks no change. Opening and closing windows on their dates is the scheduler's system sweep
//   (benefits.close_windows), so this routine never closes anything. Disabled.
import type { Precheck, ReadOnlyExecutor, RoutineDef } from "@weft/contracts";
import type { Predicate } from "../checks";

const TZ = "America/Los_Angeles";
const OWNER = "usr_dana";

export const RT_LIFE_EVENT_WINDOW: RoutineDef = {
  id: "rt_life_event_window", name: "Life-event benefits windows",
  description: "Weekday mornings, remind each employee with an open life-event benefits window, 14, 7 and 2 days before it closes, until they make their changes or choose no change.",
  ownerPrincipalId: OWNER, enabled: false, autonomy: "approve", trigger: { type: "cron", cron: "0 9 * * 1-5", tz: TZ }, filter: null,
  instructions: "Call benefits.send_window_reminders with the derived arguments; it writes each email itself and skips anyone who already chose. Then write a one-line final message.",
  tools: ["benefits.list_windows", "benefits.send_window_reminders"],
  precheck: "life_event_window",
  checklist: [{ id: "reminded", label: "remind every due window", check: "window_reminders_sent:{due_count}" }],
  budget: { steps: 6, usd: 0.05, minutes: 10 }, surface: { worthSurfacing: false, channel: null }, source: "prebuilt", taintedBy: null,
};

type Obj = Record<string, unknown>;
const ptDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

async function read(exec: ReadOnlyExecutor, companyId: string, command: string, args: Obj): Promise<Obj | null> {
  const o = await exec.exec(companyId, command, args);
  return o.ok && o.status === "done" && o.data && typeof o.data === "object" ? (o.data as Obj) : null;
}

interface Win { id: string; workerId: string | null; closesOn: string; nextReminderOn: string | null }
/** Windows whose next reminder date has come (the command recomputes the same list before it sends). */
export const lifeEventWindow: Precheck = async (ctx, exec) => {
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

const callsTo = (facts: Parameters<Predicate>[1], command: string) => facts.calls.filter((c) => c.command.replace("__", ".") === command);

export const routines: RoutineDef[] = [RT_LIFE_EVENT_WINDOW];
export const prechecks: Record<string, Precheck> = { life_event_window: lifeEventWindow };
export const predicates: Record<string, Predicate> = {
  /** The reminders call ran and covered the due windows (a count of 0 passes without a call). */
  window_reminders_sent: ([count = "0"], f) => {
    const want = Number(count) || 0;
    if (want === 0) return true;
    return callsTo(f, "benefits.send_window_reminders").some((c) => c.status === "done" && ((c.data ?? {}) as { count?: number }).count !== undefined);
  },
};
