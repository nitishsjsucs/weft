// Time off in payroll (wave 3, docs/wave3.md). Owner: w3-timeoff. payroll/w3-hooks.ts calls these from compute.ts; the
// scaffold returns the earnings unchanged. Salaried gross is split into salary, pto, sick and paid_holiday lines at
// annual / 2,080 per hour (never increased); hourly workers get leave lines on top of worked hours.
// Leave lines are regular wages for tax (the engine does not branch on the line type), so a salaried paycheck's
// gross, taxes and net do not move; only the lines show where the period's hours went.
import { and, eq, inArray } from "drizzle-orm";
import { holidayCalendars, holidays, timeOffPolicies, timeOffRequests, timeOffTypes, type DbTx } from "@weft/db";
import { dec, roundCents } from "@weft/payroll-tax";
import type { EarningJson, PayRateRow, PeriodSpec, WorkerRow } from "../payroll/compute";
import { isBusinessDay } from "../payroll/calendar";
import { minutesToHoursX100 } from "./engine";

export type LeaveLineKind = "pto" | "sick" | "paid_holiday";
export interface ApprovedLeave { workerId: string; kind: LeaveLineKind; days: { date: string; minutes: number }[] }
export type TimeOffPayrollInputs = { approved: ApprovedLeave[]; holidays?: { date: string; minutes: number }[] };

const LINE_OF: Record<string, LeaveLineKind | null> = { vacation: "pto", sick: "sick", prenatal: "sick", holiday: "paid_holiday", unpaid_sick: null, unpaid: null };
const HOURS_PER_YEAR = 2_080;

export async function loadTimeOffPayrollInputs(tx: DbTx, companyId: string, workerIds: string[]): Promise<TimeOffPayrollInputs> {
  if (!workerIds.length) return { approved: [], holidays: [] };
  const rows = await tx.select({ r: timeOffRequests, kind: timeOffTypes.kind, paid: timeOffTypes.paid }).from(timeOffRequests)
    .innerJoin(timeOffPolicies, eq(timeOffPolicies.id, timeOffRequests.policyId)).innerJoin(timeOffTypes, eq(timeOffTypes.id, timeOffPolicies.typeId))
    .where(and(eq(timeOffRequests.companyId, companyId), inArray(timeOffRequests.status, ["approved", "taken"]), inArray(timeOffRequests.workerId, workerIds)));
  const approved: ApprovedLeave[] = [];
  for (const { r, kind, paid } of rows.sort((a, b) => (a.r.id < b.r.id ? -1 : 1))) {
    const line = paid ? LINE_OF[kind] ?? null : null;
    if (!line) continue;
    approved.push({ workerId: r.workerId, kind: line, days: (JSON.parse(r.daysJson) as { date: string; minutes: number }[]).filter((d) => d.minutes > 0) });
  }
  const hol = await tx.select({ date: holidays.date, minutes: holidays.minutes }).from(holidays).innerJoin(holidayCalendars, eq(holidayCalendars.id, holidays.calendarId)).where(eq(holidayCalendars.companyId, companyId));
  return { approved, holidays: hol.sort((a, b) => (a.date < b.date ? -1 : 1)) };
}

/** Leave minutes per line kind for the worker inside the period: approved paid leave days plus company holidays
 * on weekdays the worker is employed. */
export function leaveMinutes(w: Pick<WorkerRow, "id" | "startDate" | "endDate" | "type">, p: Pick<PeriodSpec, "periodStart" | "periodEnd">, inputs: TimeOffPayrollInputs): Record<LeaveLineKind, number> {
  const out: Record<LeaveLineKind, number> = { pto: 0, sick: 0, paid_holiday: 0 };
  const inPeriod = (d: string) => d >= p.periodStart && d <= p.periodEnd && d >= w.startDate && (w.endDate === null || d <= w.endDate);
  for (const a of inputs.approved) if (a.workerId === w.id) for (const d of a.days) if (inPeriod(d.date)) out[a.kind] += d.minutes;
  if (w.type === "employee") for (const h of inputs.holidays ?? []) if (inPeriod(h.date) && isBusinessDay(h.date)) out.paid_holiday += h.minutes;
  return out;
}

const ORDER: LeaveLineKind[] = ["pto", "sick", "paid_holiday"];

export function timeOffEarnings(w: WorkerRow, rate: PayRateRow | null, earnings: EarningJson[], p: PeriodSpec, inputs: TimeOffPayrollInputs): EarningJson[] {
  if (!rate || !inputs || (!inputs.approved?.length && !inputs.holidays?.length)) return earnings;
  const minutes = leaveMinutes(w, p, inputs);
  const kinds = ORDER.filter((k) => minutes[k] > 0);
  if (!kinds.length) return earnings;
  if (rate.kind === "hourly") {
    // Hourly: each paid leave hour is a line at the hourly rate on top of the worked hours (overtime counts worked hours only).
    return [...earnings, ...kinds.map((k) => ({ type: k, amountCents: roundCents(dec(rate.amountCents).times(minutes[k]).dividedBy(60)), hoursX100: minutesToHoursX100(minutes[k]) }))];
  }
  const salary = earnings.find((e) => e.type === "salary");
  if (!salary) return earnings;
  const perHour = dec(rate.amountCents).dividedBy(HOURS_PER_YEAR);
  const lines = kinds.map((k) => ({ type: k, amountCents: roundCents(perHour.times(minutes[k]).dividedBy(60)), hoursX100: minutesToHoursX100(minutes[k]) }));
  const leave = lines.reduce((s, l) => s + l.amountCents, 0);
  if (leave > salary.amountCents) return earnings;   // never split more than the period's salary (gross is never increased)
  return earnings.flatMap((e) => (e === salary ? [{ ...salary, amountCents: salary.amountCents - leave }, ...lines] : [e]));
}
