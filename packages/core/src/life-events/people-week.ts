// The people week (wave 4 ranks 8 and 13, research/wave3/agent-parity.md R6 and R1). Owner: w4-parity-people.
// Who is out this week, read from the approved time-off requests behind the ledger's holds (days that are weekends or
// company holidays count 0), and the hires whose first day is today. Both carry names and dates only: never the kind
// of leave, the employee's reason, or anything the hire typed, so the digest line and the first-day emails can go out
// without a model writing them.
import { and, eq, inArray } from "drizzle-orm";
import { events, timeOffRequests, workers, type DbTx } from "@weft/db";
import { displayName } from "../people/names";
import { addDays } from "./rules";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const weekday = (d: string) => WEEKDAY[new Date(`${d}T12:00:00.000Z`).getUTCDay()]!;

/** Monday to Sunday of the week holding `asOf`. */
export function weekOf(asOf: string): { start: string; end: string } {
  const dow = new Date(`${asOf}T12:00:00.000Z`).getUTCDay();
  const start = addDays(asOf, dow === 0 ? -6 : 1 - dow);
  return { start, end: addDays(start, 6) };
}

export interface OutPerson { worker_id: string; name: string; department_id: string | null; request_ids: string[]; days: { date: string; minutes: number }[]; when: string }
export interface OutThisWeek { week_start: string; week_end: string; count: number; out: OutPerson[]; line: string }

/** Runs of consecutive working days as "Mon to Wed", a part day as "part of Fri". */
export function describeDays(days: { date: string; minutes: number }[]): string {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : 1));
  const parts: string[] = [];
  let run: { date: string; minutes: number }[] = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length === 1) parts.push(run[0]!.minutes < 480 ? `part of ${weekday(run[0]!.date)}` : weekday(run[0]!.date));
    else parts.push(`${weekday(run[0]!.date)} to ${weekday(run[run.length - 1]!.date)}`);
    run = [];
  };
  for (const d of sorted) {
    const prev = run[run.length - 1];
    if (prev && addDays(prev.date, 1) === d.date && d.minutes >= 480 && prev.minutes >= 480) run.push(d);
    else { flush(); run = [d]; }
  }
  flush();
  return parts.join(", ");
}

/** Approved (or already taken) leave overlapping Monday to Sunday of asOf's week, one row per person. */
export async function outThisWeek(tx: DbTx, companyId: string, asOf: string, opts: { departmentId?: string } = {}): Promise<OutThisWeek> {
  const { start, end } = weekOf(asOf);
  const reqs = (await tx.select().from(timeOffRequests).where(and(eq(timeOffRequests.companyId, companyId), inArray(timeOffRequests.status, ["approved", "taken"]))))
    .filter((r) => r.startAt.slice(0, 10) <= end && r.endAt.slice(0, 10) >= start);
  const ids = [...new Set(reqs.map((r) => r.workerId))];
  const people = ids.length ? await tx.select().from(workers).where(inArray(workers.id, ids)) : [];
  const out: OutPerson[] = [];
  for (const w of people) {
    if (opts.departmentId && w.departmentId !== opts.departmentId) continue;
    const mine = reqs.filter((r) => r.workerId === w.id).sort((a, b) => (a.id < b.id ? -1 : 1));
    const days = new Map<string, number>();
    for (const r of mine) {
      for (const d of JSON.parse(r.daysJson) as { date: string; minutes: number }[]) if (d.date >= start && d.date <= end && d.minutes > 0) days.set(d.date, (days.get(d.date) ?? 0) + d.minutes);
    }
    if (days.size === 0) continue;   // a request whose days this week are all weekends or holidays
    const list = [...days.entries()].map(([date, minutes]) => ({ date, minutes })).sort((a, b) => (a.date < b.date ? -1 : 1));
    out.push({ worker_id: w.id, name: displayName(w.firstName, w.lastName), department_id: w.departmentId, request_ids: mine.map((r) => r.id), days: list, when: describeDays(list) });
  }
  out.sort((a, b) => (a.days[0]!.date === b.days[0]!.date ? (a.name < b.name ? -1 : 1) : a.days[0]!.date < b.days[0]!.date ? -1 : 1));
  const line = out.length === 0 ? "Out this week: nobody." : `Out this week: ${out.map((p) => `${p.name} (${p.when})`).join("; ")}.`;
  return { week_start: start, week_end: end, count: out.length, out, line };
}

// ---------------------------------------------------------------- first day

export interface FirstDayHire { worker_id: string; name: string; start_date: string; manager_id: string | null; manager: string | null; team: { worker_id: string; name: string }[] }
export interface FirstDayPlan { as_of: string; due: FirstDayHire[]; sent: string[] }
export const FIRST_DAY_TEAM_CAP = 8;

/**
 * Employees whose start date is asOf and who are onboarding or active. A hire who already got the message (a
 * worker.first_day event for them) is in `sent`, never in `due`, so the message goes out once per hire.
 */
export async function firstDayPlan(tx: DbTx, companyId: string, asOf: string): Promise<FirstDayPlan> {
  const all = await tx.select().from(workers).where(eq(workers.companyId, companyId));
  const hires = all.filter((w) => w.type === "employee" && w.startDate === asOf && w.endDate === null && (w.status === "onboarding" || w.status === "active")).sort((a, b) => (a.id < b.id ? -1 : 1));
  if (hires.length === 0) return { as_of: asOf, due: [], sent: [] };
  const done = new Set((await tx.select({ ref: events.subjectRef }).from(events).where(and(eq(events.type, "worker.first_day"), inArray(events.subjectRef, hires.map((h) => h.id))))).map((e) => e.ref));
  const byId = new Map(all.map((w) => [w.id, w]));
  const due: FirstDayHire[] = [];
  for (const h of hires) {
    if (done.has(h.id)) continue;
    const mgr = h.managerId ? byId.get(h.managerId) : undefined;
    const team = all.filter((w) => w.id !== h.id && h.managerId !== null && w.managerId === h.managerId && w.status === "active" && w.endDate === null && w.type === "employee")
      .sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, FIRST_DAY_TEAM_CAP).map((w) => ({ worker_id: w.id, name: displayName(w.firstName, w.lastName) }));
    due.push({ worker_id: h.id, name: displayName(h.firstName, h.lastName), start_date: h.startDate, manager_id: mgr?.id ?? null, manager: mgr ? displayName(mgr.firstName, mgr.lastName) : null, team });
  }
  return { as_of: asOf, due, sent: hires.filter((h) => done.has(h.id)).map((h) => h.id) };
}

export const firstDayEmails = (h: FirstDayHire) => ({
  hire: {
    subject: `Welcome to Larkspur Robotics, ${h.name}`,
    body: `Hi ${h.name},\n\nWelcome! Today, ${h.start_date}, is your first day at Larkspur Robotics (a fictional demo company).${h.manager ? ` ${h.manager} is your manager and will find you this morning.` : ""} Your onboarding checklist, pay details and benefits are in the Weft portal.\n\nWe are glad you are here,\nLarkspur Robotics people team (sent by the Weft agent)`,
  },
  team: {
    subject: `${h.name} starts today`,
    body: `Hi,\n\n${h.name} joins the team today, ${h.start_date}${h.manager ? `, reporting to ${h.manager}` : ""}. Please say hello and help them settle in.\n\nLarkspur Robotics people team (sent by the Weft agent)`,
  },
});
