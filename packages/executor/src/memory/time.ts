// Human-facing times in memory files. People and the model read the one-pager, dossiers, timeline summaries and
// preferences, so every instant in their text is shown in the company time zone with the app's formatter style
// (apps/web/src/components/app/format.ts fmtDateTime: "Wed, Oct 28, 5:00 PM PT"). Machine fields stay ISO:
// frontmatter, raw timeline lines (parsed back by coarsen.ts), paths and run keys. Fact stamps keep the
// (YYYY-MM-DD, src: ...) shape the write rules check, dated by the company's calendar day.

export const COMPANY_TZ = "America/Los_Angeles";

const DATE_TIME = new Intl.DateTimeFormat("en-US", { timeZone: COMPANY_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const CALENDAR_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: COMPANY_TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** A full ISO instant (date, time and a Z or offset). Plain dates and period keys like 2026-10-09T17 never match. */
export const ISO_INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g;

/**
 * "Wed, Oct 28, 5:00 PM PT" for 2026-10-29T00:00:00.000Z. ICU puts a narrow no-break space before AM and PM;
 * memory files use a plain space so a fixed-string search for "5:00 PM" finds the line.
 */
export function fmtDateTimePT(iso: string): string {
  return `${DATE_TIME.format(new Date(iso)).replace(/[  ]/g, " ")} PT`;
}

/** The company calendar day (YYYY-MM-DD) of an instant; a plain YYYY-MM-DD passes through unchanged. */
export function companyDay(isoOrDay: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoOrDay)) return isoOrDay;
  const d = new Date(isoOrDay);
  return Number.isNaN(d.getTime()) ? isoOrDay.slice(0, 10) : CALENDAR_DAY.format(d);
}

/** Every ISO instant in a line of text, shown in company time. Idempotent: formatted text has no instants left. */
export function humanTimes(text: string): string {
  return text.replace(ISO_INSTANT, (m) => (Number.isNaN(Date.parse(m)) ? m : fmtDateTimePT(m)));
}
