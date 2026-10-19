import { formatCents, type TaxAccount } from "@weft/contracts";

const TZ = "America/Los_Angeles";

export function fmtDate(isoOrDate: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(isoOrDate) ? new Date(`${isoOrDate}T12:00:00Z`) : new Date(isoOrDate);
  return new Intl.DateTimeFormat("en-US", { timeZone: /^\d{4}-\d{2}-\d{2}$/.test(isoOrDate) ? "UTC" : TZ, ...opts }).format(d);
}
export function fmtDateTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) + " PT";
}
export function fmtClock(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}
/** A full ISO instant inside free text (date, time and a Z or offset); plain dates and ids never match. */
const ISO_INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g;
/**
 * Server text (audit summaries, tool outcomes, refusals, headlines) can carry raw ISO instants such as
 * "settles 2026-10-30T13:00:00.000Z"; people see them as fmtDateTime does. The stored text stays as written.
 */
export function humanTimes(text: string): string {
  return text.replace(ISO_INSTANT, (m) => (Number.isNaN(Date.parse(m)) ? m : fmtDateTime(m)));
}
/**
 * A plain calendar date inside free text ("start date 2026-10-19", "to 2026-10-26: 10 months"); instants (a T or a
 * colon and digits after the date), ids and longer numbers never match.
 */
const PLAIN_DATE = /(?<![\w-])(\d{4})-(\d{2})-(\d{2})(?![\w-]|:\d|T\d)/g;
/**
 * Plain YYYY-MM-DD dates in server text read as "Oct 19" (with the year when it is not `year`). Calendar dates are
 * days, not instants, so no time zone shift applies. The stored text stays as written.
 */
export function humanDates(text: string, year?: number): string {
  // Without a year from the caller, dates in the text's latest year read without one ("Oct 16 to Oct 31, payday Oct 30").
  const ref = year ?? Math.max(0, ...[...text.matchAll(PLAIN_DATE)].map((m) => Number(m[1])));
  return text.replace(PLAIN_DATE, (m, y: string, mo: string, d: string) => {
    const t = Date.UTC(Number(y), Number(mo) - 1, Number(d), 12);
    if (Number.isNaN(t) || new Date(t).getUTCDate() !== Number(d)) return m;
    return fmtDate(m, Number(y) === ref ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  });
}
export function fmtShortClock(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}
/** "in 2d 4h" or "3h ago" relative to the sim clock. */
export function relative(targetIso: string, nowIso: string): string {
  const ms = new Date(targetIso).getTime() - new Date(nowIso).getTime();
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60_000);
  const s = m < 60 ? `${m}m` : m < 1_440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1_440)}d ${Math.floor((m % 1_440) / 60)}h`;
  return ms >= 0 ? `in ${s}` : `${s} ago`;
}
export const cents = (c: number | null | undefined) => (c === null || c === undefined ? "-" : formatCents(c));
export const hours = (x100: number | null) => (x100 === null ? "-" : (x100 / 100).toFixed(2));
export const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(micros < 10_000 ? 4 : 2)}`;
export function initials(name: string): string {
  return name.replace(/\(demo\)/, "").trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
}
/** "Oct 16 to Oct 31" */
export function period(start: string, end: string): string { return `${fmtDate(start)} to ${fmtDate(end)}`; }

/** Period end of the next semi-monthly period: the 15th, or the last day of the month. */
export function nextPeriodEnd(periodEnd: string): string {
  const [y, m, d] = periodEnd.split("-").map(Number) as [number, number, number];
  if (d === 15) return `${y}-${String(m).padStart(2, "0")}-${new Date(Date.UTC(y, m, 0)).getUTCDate()}`;
  const ny = m === 12 ? y + 1 : y; const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-15`;
}

/** Next prebuilt routine slot (09:00 PT on a weekday) after `now`; the same rule the clock's "next" step uses. */
export function nextCronSlot(now: string): string | null {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  let t = Math.floor(Date.parse(now) / 900_000) * 900_000 + 900_000;   // strictly after now, on the quarter hour
  if (Number.isNaN(t)) return null;
  for (let i = 0; i < 8 * 24 * 4; i++, t += 15 * 60_000) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    if (p.weekday !== "Sat" && p.weekday !== "Sun" && p.hour === "09" && p.minute === "00") return new Date(t).toISOString();
  }
  return null;
}

/** Display names for the simulated agencies; every agency in Weft is a simulator. */
export const AGENCY: Record<TaxAccount["agency"], string> = { irs: "IRS (sim)", ca_edd: "CA EDD (sim)", ny_dtf: "NY DTF (sim)", ny_dol: "NY DOL (sim)", tx_twc: "TX TWC (sim)", co_dor: "CO DOR (sim)", co_cdle: "CO CDLE (sim)" };

/** "Not reversible: <reason>", without doubling the phrase when the API's reason already says so. */
export function notReversibleText(reason: string | null): string {
  const r = (reason ?? "no reverse command").trim();
  return /not reversible|cannot be (undone|reversed)/i.test(r) ? r : `Not reversible: ${r}`;
}

/** How a payroll run reads in lists: final pay and off-cycle runs never look like the regular semi-monthly run. */
export function runKind(subtype: string | null | undefined): { label: string; badge: string | null } {
  if (subtype === "dismissal") return { label: "Final pay (dismissal run)", badge: "Final pay" };
  if (subtype === "off_cycle") return { label: "Off-cycle run", badge: "Off-cycle" };
  return { label: "Semi-monthly", badge: null };
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
