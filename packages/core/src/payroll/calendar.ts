// Pay calendar for ps_us_semimonthly (SPEC 5.1): periods 1st to 15th and 16th to month end; payday is the last day
// of the period moved back to the previous business day on a weekend; approval deadline 17:00 PT two business days
// before payday; bank settlement at payday 06:00 PT. Business days are Monday to Friday (holidays not modeled).
export const PT = "America/Los_Angeles";

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
function parts(date: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`calendar: bad date ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
const toUtcMs = (date: string) => { const [y, m, d] = parts(date); return Date.UTC(y, m - 1, d); };
const fromUtcMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (date: string, n: number) => fromUtcMs(toUtcMs(date) + n * 86_400_000);
export const weekday = (date: string) => new Date(toUtcMs(date)).getUTCDay();   // 0 Sunday .. 6 Saturday
export const isBusinessDay = (date: string) => { const w = weekday(date); return w !== 0 && w !== 6; };
export const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function previousBusinessDayOnOrBefore(date: string): string {
  let d = date;
  while (!isBusinessDay(d)) d = addDays(d, -1);
  return d;
}
export function businessDaysBefore(date: string, n: number): string {
  let d = date;
  let left = n;
  while (left > 0) { d = addDays(d, -1); if (isBusinessDay(d)) left--; }
  return d;
}
/** Monday to Friday days in [from, to], inclusive. */
export function workingDays(from: string, to: string): number {
  if (from > to) return 0;
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (isBusinessDay(d)) n++;
  return n;
}

/** The semi-monthly period that ends on `periodEnd` (the 15th or the month end). */
export function semimonthlyPeriod(periodEnd: string): { periodStart: string; periodEnd: string } {
  const [y, m, d] = parts(periodEnd);
  if (d === 15) return { periodStart: ymd(y, m, 1), periodEnd };
  if (d === lastDayOfMonth(y, m)) return { periodStart: ymd(y, m, 16), periodEnd };
  throw new Error(`calendar: ${periodEnd} is not a semi-monthly period end (the 15th or the last day of the month)`);
}
/** Every semi-monthly period of `year` whose end is on or before `through`. */
export function semimonthlyPeriodsThrough(year: number, through: string): { periodStart: string; periodEnd: string }[] {
  const out: { periodStart: string; periodEnd: string }[] = [];
  for (let m = 1; m <= 12; m++) {
    for (const end of [ymd(year, m, 15), ymd(year, m, lastDayOfMonth(year, m))]) if (end <= through) out.push(semimonthlyPeriod(end));
  }
  return out;
}
export const nextSemimonthlyPeriodEnd = (periodEnd: string): string => {
  const [y, m, d] = parts(periodEnd);
  if (d === 15) return ymd(y, m, lastDayOfMonth(y, m));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return ymd(ny, nm, 15);
};

/** Converts a wall time in America/Los_Angeles to an ISO UTC instant (handles PDT and PST). */
export function ptToUtc(date: string, hour: number, minute = 0): string {
  const [y, m, d] = parts(date);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: PT, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  for (const off of [7, 8]) {
    const ms = Date.UTC(y, m - 1, d, hour + off, minute);
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    if (Number(p.hour) % 24 === hour && Number(p.day) === d && Number(p.minute) === minute) return new Date(ms).toISOString();
  }
  throw new Error(`calendar: cannot place ${date} ${hour}:${minute} in ${PT}`);
}
/** The PT calendar date of an ISO instant. */
export function ptDate(iso: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: PT, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date(iso));
}

export interface RunDates { periodStart: string; periodEnd: string; payday: string; approvalDeadline: string; settleAt: string }
export function semimonthlyRunDates(periodEnd: string): RunDates {
  const p = semimonthlyPeriod(periodEnd);
  const payday = previousBusinessDayOnOrBefore(p.periodEnd);
  return { ...p, payday, approvalDeadline: ptToUtc(businessDaysBefore(payday, 2), 17), settleAt: ptToUtc(payday, 6) };
}
/** Named run ids follow the payday: pay_2026_10_30. */
export const runIdForPayday = (payday: string) => `pay_${payday.replace(/-/g, "_")}`;
