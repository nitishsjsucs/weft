// Business-day arithmetic on the sim clock. Weekends are judged in America/Los_Angeles (the company's home zone).
const DAY_MS = 86_400_000;
const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" });
const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });

export function isWeekendPt(ms: number): boolean {
  const d = weekdayFmt.format(new Date(ms));
  return d === "Sat" || d === "Sun";
}

const wallFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** The PT wall time of an instant as [hour, minute, second]. */
function ptWall(ms: number): [number, number, number] {
  const parts = Object.fromEntries(wallFmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return [Number(parts.hour), Number(parts.minute), Number(parts.second)];
}

/** The UTC instant of a PT wall time on a PT calendar date (PDT is UTC-7, PST is UTC-8). */
function ptWallToMs(date: string, [h, m, sec]: [number, number, number], ms: number): number {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  for (const offset of [7, 8]) {
    const t = Date.UTC(y, mo - 1, d, h + offset, m, sec, ms);
    const [wh, wm] = ptWall(t);
    if (ptDate(new Date(t).toISOString()) === date && wh === h && wm === m) return t;
  }
  return Date.UTC(y, mo - 1, d, h + 8, m, sec, ms);   // a wall time skipped by the spring change: use PST
}

/**
 * Adds n business days, keeping the PT time of day: Mon 09:00 PT plus 2 gives Wed 09:00 PT; Fri plus 1 gives Mon.
 * Steps PT calendar dates, so crossing a DST change keeps the wall time (Fri Oct 30 09:00 PDT plus 1 is Mon
 * Nov 2 09:00 PST).
 */
export function addBusinessDays(iso: string, n: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`addBusinessDays: bad ISO time ${iso}`);
  const wall = ptWall(t);
  let date = ptDate(iso);
  let left = n;
  while (left > 0) {
    date = addDays(date, 1);
    if (!isWeekendPt(Date.parse(`${date}T20:00:00.000Z`))) left -= 1;
  }
  return new Date(ptWallToMs(date, wall, t % 1000)).toISOString();
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
