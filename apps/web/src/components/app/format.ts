import { formatCents } from "@weft/contracts";

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
