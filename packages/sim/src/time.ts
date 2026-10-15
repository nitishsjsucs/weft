// Business-day arithmetic on the sim clock. Weekends are judged in America/Los_Angeles (the company's home zone).
const DAY_MS = 86_400_000;
const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" });
const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });

export function isWeekendPt(ms: number): boolean {
  const d = weekdayFmt.format(new Date(ms));
  return d === "Sat" || d === "Sun";
}

/** Adds n business days, keeping the time of day: Mon 09:00 PT plus 2 gives Wed 09:00 PT; Fri plus 1 gives Mon. */
export function addBusinessDays(iso: string, n: number): string {
  let t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`addBusinessDays: bad ISO time ${iso}`);
  let left = n;
  while (left > 0) {
    t += DAY_MS;
    if (!isWeekendPt(t)) left -= 1;
  }
  return new Date(t).toISOString();
}

/** The calendar date in America/Los_Angeles, as YYYY-MM-DD. */
export function ptDate(iso: string): string {
  return dateFmt.format(new Date(Date.parse(iso)));
}

/** Adds calendar days to a YYYY-MM-DD date. */
export function addDays(date: string, n: number): string {
  const t = Date.parse(`${date}T12:00:00.000Z`) + n * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}
