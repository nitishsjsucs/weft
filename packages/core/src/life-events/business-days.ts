// Business days that skip company holidays (wave 4 rank 15, R2). Owner: w4-parity-people.
// The Ready Check counts three business days ahead skipping weekends only (packages/core/src/parity/ready-check.ts,
// wave 3). Contract request: it calls addWorkingDays with the time-off holiday calendar (holidayMap) instead of
// addBusinessDays, so a hire starting the Monday after Thanksgiving is checked on the Tuesday before.
const isWeekend = (d: string) => { const w = new Date(`${d}T12:00:00.000Z`).getUTCDay(); return w === 0 || w === 6; };
const nextDay = (d: string) => new Date(Date.parse(`${d}T12:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);

/** The date n working days after `from`: weekends and the given holiday dates are skipped. */
export function addWorkingDays(from: string, n: number, holidays: ReadonlySet<string> | ReadonlyMap<string, unknown>): string {
  let d = from;
  for (let left = n; left > 0;) { d = nextDay(d); if (!isWeekend(d) && !holidays.has(d)) left--; }
  return d;
}
