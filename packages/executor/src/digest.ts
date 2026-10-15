// Stable digests: canonical JSON (sorted keys, integer cents) after a JSON round trip drops undefined.
import { canonicalJson, sha256Hex } from "@weft/core";

export function stableJson(v: unknown): string {
  const plain = v === undefined ? null : JSON.parse(JSON.stringify(v));
  try { return canonicalJson(plain); } catch {
    const sort = (x: unknown): unknown => Array.isArray(x) ? x.map(sort)
      : x && typeof x === "object" ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])])) : x;
    return JSON.stringify(sort(plain));
  }
}
export function digestOf(v: unknown): string { return sha256Hex(stableJson(v)); }
