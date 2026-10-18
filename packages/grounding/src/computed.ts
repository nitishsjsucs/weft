// Figures a routine computed in code, as grounding evidence (the routine grounding fix after the wave 4 model
// comparison). A prebuilt routine's precheck counts, totals and dates its findings before any model step, and its
// derived text quotes them ("48 employees by work state (CA 22, NY 14, TX 12)"). The message guard used to know only
// the company facts, so a figure the routine itself had computed was refused as ungrounded and the run retried until
// its step cap. computedFigures turns a precheck result into one evidence item the guard can index.
//
// Only structured figures survive, so the guard stays strict for anything with no source:
// - finite numbers (a *_cents key is still divided by 100 by collectLeaves) and decimal strings;
// - whole ISO dates and instants ("2026-11-02", "2026-10-26T15:30:00.000Z");
// - a *_display string that is a figure and nothing else ("$412.38", "18.0%").
// Every other string is dropped: prose, names, titles, notes and the derived message text itself. So the routine's
// own text never grounds itself, and a number inside a string the precheck carried along (a notice title, a worker's
// note) is never evidence, wrapped as untrusted or not. An object left with no figure is dropped too. Arrays keep their
// length (a dropped item becomes null), so a list the routine counted can still ground a small count, as a tool
// result's list does.

const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
/** A display string that is one figure: an optional sign, "~" or "$", digits with separators, an optional percent. */
const FIGURE = /^[-~]?\$?\d{1,3}(?:,\d{3})*(?:\.\d+)?\s?%?$|^[-~]?\$?\d+(?:\.\d+)?\s?%?$/;
const MAX_DEPTH = 12;

function keep(v: unknown, key: string | null, depth: number): unknown {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (DECIMAL.test(s) || ISO_DATE.test(s)) return s;
    if (key !== null && key.endsWith("_display") && FIGURE.test(s)) return s;
    return null;
  }
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(v)) return v.map((x) => keep(x, key, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const y = keep(x, k, depth + 1);
      if (y !== null) out[k] = y;
    }
    return Object.keys(out).length ? out : null;
  }
  return null;
}

/**
 * The structured figures of a value a routine computed in code (a precheck's findings and derived arguments), for the
 * grounding check's results argument. Strings that are not a number, a whole date or a figure-only *_display value
 * are dropped (see the header); null when nothing is left.
 */
export function computedFigures(value: unknown): unknown {
  return keep(value, null, 0);
}
