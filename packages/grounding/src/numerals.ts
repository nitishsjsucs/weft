// Numeral extraction and JSON leaf walks for the grounding check (harness 4.8). Ported from StaySignal
// src/shared/grounding/numerals.ts (MIT, same author), then extended for Weft: money signs, approximation markers,
// the cents rule on leaves, decimal-string rates and *_display strings.

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

export interface Numeral {
  raw: string;
  value: number;
  decimals: number;
  percent: boolean;
  money: boolean;
  approx: boolean;
  word: boolean;
  index: number;
}

/** "about", "around", "approximately" or "~" right before the number (optionally before the dollar sign). */
const APPROX_BEFORE = /(?:\b(?:about|around|approximately)\s+|~\s?)\$?\s?$/i;

const DIGITS = /(\$\s?)?(?<![A-Za-z0-9_#@.\-/:])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(\s?%|\s?percent)?(?![A-Za-z0-9_/:]|-\d)/g;
const WORD_RE = new RegExp(`\\b(${Object.keys(TENS).join("|")})(?:[-\\s](${Object.keys(UNITS).filter((w) => UNITS[w]! >= 1 && UNITS[w]! <= 9).join("|")}))?\\b|\\b(${Object.keys(UNITS).join("|")})\\b`, "gi");

export function extractNumerals(text: string): Numeral[] {
  const out: Numeral[] = [];
  for (const m of text.matchAll(DIGITS)) {
    const whole = (m[2] ?? "").replace(/,/g, "");
    const frac = m[3] ?? "";
    const index = m.index ?? 0;
    const before = text.slice(Math.max(0, index - 16), index + (m[1] ? m[1].length : 0));
    out.push({
      raw: m[0], value: Number(frac ? `${whole}.${frac}` : whole), decimals: frac.length,
      percent: Boolean(m[4]), money: Boolean(m[1]), approx: APPROX_BEFORE.test(before), word: false, index,
    });
  }
  for (const m of text.matchAll(WORD_RE)) {
    const index = m.index ?? 0;
    let value: number;
    if (m[1]) value = TENS[m[1].toLowerCase()]! + (m[2] ? UNITS[m[2].toLowerCase()]! : 0);
    else value = UNITS[(m[3] ?? "").toLowerCase()] ?? 0;
    const before = text.slice(Math.max(0, index - 16), index);
    out.push({ raw: m[0], value, decimals: 0, percent: false, money: false, approx: APPROX_BEFORE.test(before), word: true, index });
  }
  return out.sort((a, b) => a.index - b.index);
}

const DECIMAL_STRING = /^-?\d+(?:\.\d+)?$/;

export interface Leaves {
  /** Plain numbers: non-cents numeric leaves, *_cents leaves divided by 100, and decimal strings such as rates. */
  values: number[];
  /** Percent values written in *_display strings ("1.9%" gives 1.9). */
  percents: number[];
  /** Every string leaf and key (identifiers, dates, displays). */
  strings: Set<string>;
  /** Lengths of every array (small counts may cite them). */
  lengths: Set<number>;
}

/** Walk tool results once. The cents rule: only leaves whose key ends in `_cents` are divided by 100. */
export function collectLeaves(results: unknown[]): Leaves {
  const out: Leaves = { values: [], percents: [], strings: new Set(), lengths: new Set() };
  const walk = (v: unknown, key: string | null): void => {
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return;
      out.values.push(key !== null && key.endsWith("_cents") ? v / 100 : v);
    } else if (typeof v === "string") {
      out.strings.add(v);
      if (DECIMAL_STRING.test(v.trim())) {
        const n = Number(v.trim());
        out.values.push(key !== null && key.endsWith("_cents") ? n / 100 : n);
      } else if (key !== null && key.endsWith("_display")) {
        for (const n of extractNumerals(v)) (n.percent ? out.percents : out.values).push(n.value);
      }
    } else if (Array.isArray(v)) {
      out.lengths.add(v.length);
      for (const x of v) walk(x, key);
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        out.strings.add(k);
        walk(x, k);
      }
    }
  };
  for (const r of results) walk(r, null);
  return out;
}
