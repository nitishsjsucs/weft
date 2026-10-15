// Result aliases and placeholders. Ported from StaySignal src/shared/grounding/aliases.ts (MIT, same author), trimmed
// for Weft: a model may write {{r1.net_cents|usd}} and code renders the value from the stored tool result, so the
// number a person reads is copied, never retyped. Grounding strips placeholders before it looks for numerals.

export const PLACEHOLDER = /\{\{\s*(r\d+)\.([A-Za-z0-9_.]+)\s*(?:\|\s*(int|usd|pct|raw))?\s*\}\}/g;

export interface AliasEntry { alias: string; resultId: string; tool: string; values: unknown }
export type AliasMap = Map<string, AliasEntry>;

export function resolvePath(values: unknown, path: string): unknown {
  let cur: unknown = values;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

/** Cents as a display string: 264987 gives "$2,649.87". */
export function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

function fmtValue(v: unknown, path: string, fmt: string | undefined): string | null {
  if (typeof v === "number") {
    if (fmt === "usd" || (fmt === undefined && path.endsWith("_cents"))) return usd(v);
    if (fmt === "pct") return `${(Math.round(v * 10000) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
    if (fmt === "int") return Math.round(v).toLocaleString("en-US");
    return String(v);
  }
  if (typeof v === "string") return v;
  return null;
}

export interface RenderResult { text: string; unresolved: string[]; used: { alias: string; path: string; resultId: string; value: unknown }[] }

export function renderPlaceholders(text: string, aliases: AliasMap): RenderResult {
  const unresolved: string[] = [];
  const used: RenderResult["used"] = [];
  const out = text.replace(PLACEHOLDER, (whole, alias: string, path: string, fmt: string | undefined) => {
    const entry = aliases.get(alias);
    const v = entry ? resolvePath(entry.values, path) : undefined;
    const s = entry ? fmtValue(v, path, fmt) : null;
    if (!entry || s === null) {
      unresolved.push(whole);
      return whole;
    }
    used.push({ alias, path, resultId: entry.resultId, value: v });
    return s;
  });
  return { text: out, unresolved, used };
}
