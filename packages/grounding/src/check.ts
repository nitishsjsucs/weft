// The numeric grounding check (harness 4.8). Ported from StaySignal src/shared/grounding/check.ts (MIT, same author),
// pattern from DataTrust packages/rca/src/summary/validate.ts (MIT). Every numeral a person will read must equal a
// value in this run's evidence, with Weft's rules:
// - cents: only *_cents leaves are divided by 100; a bare "$2,650" must match exactly, while "about", "around",
//   "approximately" or "~" allow rounding to the stated precision;
// - percents match a fraction times 100 (rate_delta 0.019 grounds "1.9%") or a percent written in a result string;
// - dates match ISO and US forms of any date in the results; a bare year matches a known date's year;
// - integers up to 10 are exempt (ordinary prose), and so are numbers inside identifiers the results contain;
// - evidence is the tool results (numbers, and the numerals and dates of every untainted string), plus, when the
//   caller passes them, the person's own request, the run clock with the bounds of the relative windows the request
//   or answer names, and a stated count total that sums the counts the answer lists from one result.
import { PLACEHOLDER } from "./aliases";
import { clockDates, DATE_IN_TEXT, dateGrounded, parseTextDate, type DateKey } from "./dates";
import { collectLeaves, emptyLeaves, extractNumerals, mineString, TAINTED_LEAF, type Leaves, type Numeral } from "./numerals";

export interface GroundingResult { ok: boolean; offending: string[] }

/** Evidence beyond the tool results. Every field is optional, so the frozen two-argument call is unchanged. */
export interface CheckOptions {
  /** The person's own words (never text from other people): numerals and dates they wrote may be repeated. */
  request?: string | null;
  /** The run clock (ISO instant): today and the bounds of relative windows in the request or answer are dates. */
  now?: string | null;
  /** Strings the run sent as tool arguments: a result string equal to one is an echo, not evidence for numerals. */
  echoes?: Iterable<string>;
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

/** Small plain integers count as listed figures when one result holds them as a value or a list length. */
function heldBy(n: Numeral, leaves: Leaves): boolean {
  return grounded(n, leaves) || (!n.percent && !n.money && n.decimals === 0 && leaves.lengths.has(n.value));
}

/**
 * A stated count total: `total` equals the sum of a run of at least two plain counts written right before or right
 * after it, every one held by the same single result. "47 people: 13, 9, 9, 8, 5 and 3" and "13, 9, 9, 8, 5 and 3,
 * so 47 in all" both qualify; a sum across results does not. Money and percent totals still come from a tool
 * (reports.query range_totals, harness 4.8 "derived numbers come from tools"), never from the answer's arithmetic.
 */
function statedTotal(total: Numeral, all: Numeral[], perResult: Leaves[]): boolean {
  const plain = (n: Numeral) => !n.money && !n.percent && n.decimals === 0;
  if (!plain(total)) return false;
  const i = all.indexOf(total);
  const same = plain;
  const sums = (run: Numeral[]) => {
    const sum = run.reduce((a, n) => a + n.value, 0);
    return total.approx ? approxMatches(total, sum) : exactMatches(total, sum);
  };
  for (const leaves of perResult) {
    const held = (n: Numeral) => same(n) && heldBy(n, leaves);
    for (const dir of [-1, 1] as const) {
      const run: Numeral[] = [];
      for (let j = i + dir; j >= 0 && j < all.length && held(all[j]!); j += dir) {
        run.push(all[j]!);
        if (run.length >= 2 && sums(run)) return true;
      }
    }
  }
  return false;
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

/**
 * Frozen signature (SPEC 9.0): every number in `text` must appear in some tool result. The optional third argument
 * adds the evidence a chat run has beyond its tool results (the request, the clock, its own echoed arguments).
 */
export function check(text: string, toolResults: unknown[], opts: CheckOptions = {}): GroundingResult {
  const echoes = new Set(opts.echoes ?? []);
  const leaves = collectLeaves(toolResults, { echoes });
  const extra = emptyLeaves();
  const request = (opts.request ?? "").trim();
  if (request && !TAINTED_LEAF.test(request)) mineString(request, extra);
  const evidence: Leaves = {
    values: [...leaves.values, ...extra.values], percents: [...leaves.percents, ...extra.percents],
    strings: leaves.strings, lengths: leaves.lengths, dates: [...leaves.dates, ...extra.dates],
  };
  const known: DateKey[] = [...evidence.dates, ...(opts.now ? clockDates(opts.now, [request, text]) : [])];
  const years = new Set(known.map((d) => d.y).filter((y) => y > 0));
  const offending: string[] = [];

  let stripped = text.replace(PLACEHOLDER, " ");
  // Identifiers the results contain (wrk_0014, DE 2088, CA_EDD_DE2088_2026.txt) are names, not claims. They are cut
  // only as whole tokens, so "ax 5" never eats the middle of "tax 5000".
  const identifiers = [...leaves.strings].filter(isIdentifier).sort((a, b) => b.length - a.length);
  if (identifiers.length) stripped = stripped.replace(new RegExp(`(?<![A-Za-z0-9_])(?:${identifiers.map(escapeRe).join("|")})(?![A-Za-z0-9_])`, "g"), " ");
  // Dates: each must be a known date, then it leaves the text so its parts are not read as numbers.
  stripped = stripped.replace(DATE_IN_TEXT, (raw) => {
    const k = parseTextDate(raw);
    if (!k || k.m < 1 || !dateGrounded(k, known)) offending.push(raw.trim());
    return " ";
  });
  const numerals = extractNumerals(stripped);
  let perResult: Leaves[] | null = null;
  for (const n of numerals) {
    if (!n.percent && !n.money && n.decimals === 0 && Number.isInteger(n.value) && n.value <= 10) continue;
    if (!n.percent && !n.money && n.decimals === 0 && n.value >= 1900 && n.value <= 2100 && years.has(n.value)) continue;
    if (!n.percent && !n.money && n.decimals === 0 && leaves.lengths.has(n.value)) continue;
    if (grounded(n, evidence)) continue;
    perResult ??= toolResults.map((r) => collectLeaves([r], { echoes }));
    if (statedTotal(n, numerals, perResult)) continue;
    offending.push(n.raw.trim());
  }
  return { ok: offending.length === 0, offending };
}
