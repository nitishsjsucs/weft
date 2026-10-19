// Dates for the grounding check (harness 4.8): the date shapes a person reads, the dates a source holds, and the
// window bounds a relative phrase ("next week", "the next two weeks") names against the run clock. Only bounds are
// derived from a phrase, never the days inside a window: a date the answer claims inside the asked-about window must
// still come from a record, or a made-up start date in "the next two weeks" would pass. A day range after a month name
// ("November 23 to 27, 2026", "Nov 23-27", or the two days joined by an en dash) is two dates, so its second day is
// never read as a bare number (round 1 analysis R8).

export interface DateKey { y: number; m: number; d: number | null }

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";

const ORDINAL = "(?:st|nd|rd|th)?";
/**
 * The words and marks that join two days after one month name: a range ("to", "through", a hyphen or an en dash) or
 * a pair ("and": "November 26 and 27", demo check round 1, where the live answer's "27" was refused although
 * 2026-11-27 was in the result). Either way both days are dates and both must come from a record.
 */
const RANGE_JOIN = "(?:\\s*[-\u2013]\\s*|\\s+(?:to|through|and)\\s+)";

/**
 * Date shapes a person might read: 2026-01-01, 1/1/2026, 01/01/26, January 1, 2026, Jan 1 2026, 1 January 2026,
 * January 2026, and a day range after a month name (November 23 to 27, 2026; Nov 23-27; the two days joined by an en
 * dash). The range comes before the single "Month D" shape, so the alternation takes the whole range.
 */
export const DATE_IN_TEXT = new RegExp(
  [
    "\\b\\d{4}-\\d{2}-\\d{2}(?:T[0-9:.]+Z?)?\\b",
    "\\b\\d{1,2}/\\d{1,2}/(?:\\d{4}|\\d{2})\\b",
    `\\b${MONTH_RE}\\s+\\d{1,2}${ORDINAL}${RANGE_JOIN}\\d{1,2}${ORDINAL}(?:,?\\s+\\d{4})?\\b`,
    `\\b${MONTH_RE}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`,
    `\\b\\d{1,2}\\s+${MONTH_RE}(?:,?\\s+\\d{4})?\\b`,
    `\\b${MONTH_RE}\\s+\\d{4}\\b`,
  ].join("|"),
  "gi",
);

/** A text date as year, month and day; year 0 means the text gave none (it then matches any year). */
export function parseTextDate(raw: string): DateKey | null {
  const s = raw.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/, "$1").replace(/\./g, "");
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) return { y: m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]), m: Number(m[1]), d: Number(m[2]) };
  const month = (w: string) => MONTHS.findIndex((name) => name.startsWith(w.slice(0, 3))) + 1;
  m = /^([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(s);
  if (m) return { y: m[3] ? Number(m[3]) : 0, m: month(m[1]!), d: Number(m[2]) };
  m = /^(\d{1,2})\s+([a-z]+)(?:,?\s+(\d{4}))?$/.exec(s);
  if (m) return { y: m[3] ? Number(m[3]) : 0, m: month(m[2]!), d: Number(m[1]) };
  m = /^([a-z]+)\s+(\d{4})$/.exec(s);
  if (m) return { y: Number(m[2]), m: month(m[1]!), d: null };
  return null;
}

const RANGE_PARTS = new RegExp(`^(${MONTH_RE}\\s+\\d{1,2}${ORDINAL})${RANGE_JOIN}(\\d{1,2})${ORDINAL}(?:,?\\s+(\\d{4}))?$`, "i");

/**
 * One DATE_IN_TEXT match read as dates. A day range after a month name gives both days, with the year (when written)
 * on both. A range whose second day does not follow the first in the same month ("November 30 to 2", "May 3-45") is
 * not one: only "Month D1" is a date (`raw` is that part), and the rest comes back in `rest` with the joining word cut,
 * so the caller still reads its numbers. `dates` is empty when nothing reads as a calendar date.
 */
export function readTextDates(match: string): { dates: DateKey[]; raw: string; rest: string } {
  const s = match.trim();
  const r = RANGE_PARTS.exec(s);
  if (!r) {
    const k = parseTextDate(s);
    return { dates: k && k.m >= 1 ? [k] : [], raw: s, rest: "" };
  }
  const head = r[1]!;
  const first = parseTextDate(r[3] ? `${head}, ${r[3]}` : head);
  const d2 = Number(r[2]);
  if (first && first.m >= 1 && first.d !== null && d2 > first.d && d2 <= 31) return { dates: [first, { ...first, d: d2 }], raw: s, rest: "" };
  const lone = parseTextDate(head);
  return { dates: lone && lone.m >= 1 ? [lone] : [], raw: head, rest: s.slice(head.length).replace(new RegExp(`^${RANGE_JOIN}`, "i"), " ") };
}

/**
 * Every date a source string holds, wherever it sits: "2026-10-26 to 2026-11-09" gives both bounds, "Due October 30,
 * 2026" gives one, "Nov 23-27" gives two. Returns the dates and the string with them cut out, so their parts are not
 * read as numbers.
 */
export function datesIn(s: string): { dates: DateKey[]; rest: string } {
  const dates: DateKey[] = [];
  const rest = s.replace(DATE_IN_TEXT, (match) => {
    const r = readTextDates(match);
    dates.push(...r.dates);
    return ` ${r.rest} `;
  });
  return { dates, rest };
}

/** A claimed date is grounded when a known date agrees on every part both name (year 0 on either side is any year). */
export function dateGrounded(k: DateKey, known: DateKey[]): boolean {
  return known.some((r) => (k.y === 0 || r.y === 0 || r.y === k.y) && r.m === k.m && (k.d === null || r.d === k.d));
}

const DAY_MS = 86_400_000;

function keyOf(t: number): DateKey {
  const d = new Date(t);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

const COUNT_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fourteen: 14, thirty: 30, sixty: 60, ninety: 90,
};

const SPAN_RE = new RegExp(
  `\\b(next|coming|following|upcoming|past|last|previous|within|in|over)\\s+(?:the\\s+)?(?:(?:next|coming|past|last)\\s+)?(\\d{1,3}|${Object.keys(COUNT_WORDS).join("|")})?\\s*(days?|weeks?|months?|fortnight)\\b`,
  "gi",
);
const AGO_RE = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|thirty)\s+(days?|weeks?)\s+(ago|from now)\b/gi;

/**
 * The bounds of every window a relative phrase in `texts` names, against the run clock `now` (an ISO instant, read
 * as a UTC date). Today is always a bound. Calendar weeks run Monday to Sunday and also give their Friday; a span of
 * N days or weeks gives both its exclusive and inclusive end.
 */
export function clockDates(now: string, texts: string[]): DateKey[] {
  const t0 = Date.parse(now);
  if (!Number.isFinite(t0)) return [];
  const day = Math.floor(t0 / DAY_MS) * DAY_MS;
  const out: number[] = [day];
  const add = (...ts: number[]) => { for (const t of ts) out.push(t); };
  const dow = (new Date(day).getUTCDay() + 6) % 7;   // Monday 0 ... Sunday 6
  const monday = day - dow * DAY_MS;
  const week = (offset: number) => { const m = monday + offset * 7 * DAY_MS; add(m, m + 4 * DAY_MS, m + 6 * DAY_MS); };
  const month = (offset: number) => {
    const d = new Date(day);
    const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1);
    const last = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset + 1, 1) - DAY_MS;
    add(first, last);
  };
  const span = (sign: 1 | -1, days: number) => { if (days > 0 && days <= 400) add(day + sign * days * DAY_MS, day + sign * (days - 1) * DAY_MS); };
  const text = texts.join("\n").toLowerCase();
  if (/\btomorrow\b/.test(text)) add(day + DAY_MS);
  if (/\byesterday\b/.test(text)) add(day - DAY_MS);
  if (/\bthis\s+week\b/.test(text)) week(0);
  if (/\bnext\s+week\b/.test(text)) week(1);
  if (/\b(?:last|previous|past)\s+week\b/.test(text)) week(-1);
  if (/\bthis\s+month\b/.test(text)) month(0);
  if (/\bnext\s+month\b/.test(text)) month(1);
  if (/\b(?:last|previous|past)\s+month\b/.test(text)) month(-1);
  for (const m of text.matchAll(SPAN_RE)) {
    const back = /^(past|last|previous)$/.test(m[1]!);
    const raw = m[2];
    const n = raw === undefined ? 1 : /^\d+$/.test(raw) ? Number(raw) : COUNT_WORDS[raw] ?? 0;
    const unit = m[3]!;
    if (unit.startsWith("fortnight")) span(back ? -1 : 1, 14 * Math.max(1, raw === undefined ? 1 : n));
    else if (unit.startsWith("day")) span(back ? -1 : 1, n);
    else if (unit.startsWith("week")) span(back ? -1 : 1, 7 * n);
    else if (unit.startsWith("month") && n > 0 && n <= 12) {
      const d = new Date(day);
      const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (back ? -n : n), d.getUTCDate());
      add(t, back ? t + DAY_MS : t - DAY_MS);
    }
  }
  for (const m of text.matchAll(AGO_RE)) {
    const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : COUNT_WORDS[m[1]!] ?? 0;
    const days = m[2]!.startsWith("week") ? 7 * n : n;
    if (days > 0 && days <= 400) add(day + (m[3] === "ago" ? -days : days) * DAY_MS);
  }
  return out.map(keyOf);
}
