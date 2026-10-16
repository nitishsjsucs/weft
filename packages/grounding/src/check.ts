// The numeric grounding check (harness 4.8). Ported from StaySignal src/shared/grounding/check.ts (MIT, same author),
// pattern from DataTrust packages/rca/src/summary/validate.ts (MIT). Every numeral a person will read must equal a
// value in this run's tool results, with Weft's rules:
// - cents: only *_cents leaves are divided by 100; a bare "$2,650" must match exactly, while "about", "around",
//   "approximately" or "~" allow rounding to the stated precision;
// - percents match a fraction times 100 (rate_delta 0.019 grounds "1.9%") or a percent display string;
// - dates match ISO and US forms of any date in the results; a bare year matches a result date's year;
// - integers up to 10 are exempt (ordinary prose), and so are numbers inside identifiers the results contain.
import { PLACEHOLDER } from "./aliases";
import { collectLeaves, extractNumerals, type Leaves, type Numeral } from "./numerals";

export interface GroundingResult { ok: boolean; offending: string[] }

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
/** Date shapes a person might read: 2026-01-01, 1/1/2026, 01/01/26, January 1, 2026, Jan 1 2026, 1 January 2026, January 2026. */
const DATE_IN_TEXT = new RegExp(
  [
    "\\b\\d{4}-\\d{2}-\\d{2}(?:T[0-9:.]+Z?)?\\b",
    "\\b\\d{1,2}/\\d{1,2}/(?:\\d{4}|\\d{2})\\b",
    `\\b${MONTH_RE}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`,
    `\\b\\d{1,2}\\s+${MONTH_RE}(?:,?\\s+\\d{4})?\\b`,
    `\\b${MONTH_RE}\\s+\\d{4}\\b`,
  ].join("|"),
  "gi",
);

interface DateKey { y: number; m: number; d: number | null }

function parseTextDate(raw: string): DateKey | null {
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

function resultDates(strings: Set<string>): DateKey[] {
  const out: DateKey[] = [];
  for (const s of strings) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) out.push({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) });
  }
  return out;
}

function dateGrounded(k: DateKey, known: DateKey[]): boolean {
  return known.some((r) => (k.y === 0 || r.y === k.y) && r.m === k.m && (k.d === null || r.d === k.d));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Round to the stated precision: decimals when written, else each power of ten the trailing zeros allow. */
function approxMatches(n: Numeral, v: number): boolean {
  if (n.decimals > 0) {
    const f = 10 ** n.decimals;
    return Math.abs(Math.round(Math.abs(v) * f) / f - n.value) < 1e-9;
  }
  let zeros = 0;
  for (let x = Math.round(n.value); x >= 10 && x % 10 === 0; x /= 10) zeros++;
  for (let j = 0; j <= zeros; j++) {
    const p = 10 ** j;
    if (Math.abs(Math.round(Math.abs(v) / p) * p - n.value) < 1e-9) return true;
  }
  return false;
}

function exactMatches(n: Numeral, v: number): boolean {
  return Math.abs(Math.abs(v) - n.value) < 1e-9 * Math.max(1, n.value);
}

function grounded(n: Numeral, leaves: Leaves): boolean {
  const match = (v: number) => (n.approx ? approxMatches(n, v) : exactMatches(n, v));
  if (n.percent) {
    if (leaves.percents.some(match)) return true;
    return leaves.values.some((v) => match(v * 100) || match(v));
  }
  return leaves.values.some(match);
}

/** One token of a spaced code such as "DE 2088", "DR 0004" or "Form W-4": capitals, digits and code punctuation. */
const CODE_TOKEN = /^[A-Z0-9][A-Z0-9_\-./#]*$/;

/**
 * Whether a result string names something (an id, a file, a form code) rather than says something. A string with no
 * whitespace qualifies when it mixes digits and letters. A string with whitespace qualifies only as a short code
 * (at most 3 tokens, each all capitals and digits, such as "DE 2088"); prose like "Ran 48 checks" or "4 of 7" never
 * does, because stripping it would hide the numbers it states (gate report item 7).
 */
export function isIdentifier(s: string): boolean {
  if (!/\d/.test(s) || !/[A-Za-z_@#]/.test(s) || /^\d{4}-\d{2}-\d{2}/.test(s) || s.length > 80 || /[$%]/.test(s)) return false;
  if (!/\s/.test(s)) return true;
  const tokens = s.trim().split(/\s+/);
  return tokens.length <= 3 && tokens.every((t) => CODE_TOKEN.test(t)) && tokens.some((t) => /[A-Z]/.test(t));
}

/** Frozen signature (SPEC 9.0): every number in `text` must appear in some tool result. */
export function check(text: string, toolResults: unknown[]): GroundingResult {
  const leaves = collectLeaves(toolResults);
  const offending: string[] = [];
  const known = resultDates(leaves.strings);
  const years = new Set(known.map((d) => d.y));

  let stripped = text.replace(PLACEHOLDER, " ");
  // Identifiers the results contain (wrk_0014, DE 2088, CA_EDD_DE2088_2026.txt) are names, not claims. They are cut
  // only as whole tokens, so "ax 5" never eats the middle of "tax 5000".
  const identifiers = [...leaves.strings].filter(isIdentifier).sort((a, b) => b.length - a.length);
  if (identifiers.length) stripped = stripped.replace(new RegExp(`(?<![A-Za-z0-9_])(?:${identifiers.map(escapeRe).join("|")})(?![A-Za-z0-9_])`, "g"), " ");
  // Dates: each must be a result date, then it leaves the text so its parts are not read as numbers.
  stripped = stripped.replace(DATE_IN_TEXT, (raw) => {
    const k = parseTextDate(raw);
    if (!k || k.m < 1 || !dateGrounded(k, known)) offending.push(raw.trim());
    return " ";
  });
  for (const n of extractNumerals(stripped)) {
    if (!n.percent && !n.money && n.decimals === 0 && Number.isInteger(n.value) && n.value <= 10) continue;
    if (!n.percent && !n.money && n.decimals === 0 && n.value >= 1900 && n.value <= 2100 && years.has(n.value)) continue;
    if (!n.percent && !n.money && n.decimals === 0 && leaves.lengths.has(n.value)) continue;
    if (grounded(n, leaves)) continue;
    offending.push(n.raw.trim());
  }
  return { ok: offending.length === 0, offending };
}
