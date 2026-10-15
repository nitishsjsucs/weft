// Untrusted wrapper that cannot be closed from inside (harness 6.3). The nonce is per run (16 hex); every real
// harness tag carries it. Inside untrusted text, `<untrusted`, `</untrusted`, `<weft_` and `</weft_` get their `<`
// replaced by U+2039 so the text cannot close or forge a tag.
import { createHash, randomBytes } from "node:crypto";

export const LT_ESCAPE = "‹";

/** The run nonce is derived from the run token, so the brain (which holds the handle) and the executor agree. */
export function nonceFromToken(token: string): string {
  return createHash("sha256").update("weft-run-nonce:" + token).digest("hex").slice(0, 16);
}
export function randomNonce(): string { return randomBytes(8).toString("hex"); }

export function escapeUntrusted(text: string): string {
  return text.replace(/<(\/?)(untrusted|weft_)/gi, `${LT_ESCAPE}$1$2`);
}

const attr = (s: string) => s.replace(/[^A-Za-z0-9_:.\-]/g, "_");

export function wrapUntrusted(text: string, nonce: string, source: string): string {
  return `<untrusted n="${nonce}" source="${attr(source)}">${escapeUntrusted(text)}</untrusted>`;
}

function nonEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.some(nonEmpty);
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).some(nonEmpty);
  return true;
}

/**
 * Walks the declared dotted paths (arrays are traversed element by element). Returns the wrapped copy of `data`
 * and whether any declared path was non-empty (the run taints). Non-string values at a path are JSON-encoded
 * and wrapped as a string.
 */
export function applyUntrusted(data: unknown, paths: string[], nonce: string, source: string): { data: unknown; found: boolean } {
  let found = false;
  const walk = (node: unknown, parts: string[]): unknown => {
    if (node === null || node === undefined) return node;
    if (Array.isArray(node)) return node.map((x) => walk(x, parts));
    if (parts.length === 0) {
      if (!nonEmpty(node)) return node;
      found = true;
      return wrapUntrusted(typeof node === "string" ? node : JSON.stringify(node), nonce, source);
    }
    if (typeof node !== "object") return node;
    const [head, ...rest] = parts as [string, ...string[]];
    const obj = node as Record<string, unknown>;
    if (!(head in obj)) return node;
    return { ...obj, [head]: walk(obj[head], rest) };
  };
  let out = data;
  for (const p of paths) out = walk(out, p.split(".").filter(Boolean));
  return { data: out, found };
}
