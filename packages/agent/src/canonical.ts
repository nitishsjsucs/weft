// Canonical JSON (sorted keys, no whitespace) so replays and cache prefixes are byte-identical.
import { createHash, randomBytes } from "node:crypto";

export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A run nonce: 12 lowercase hex characters, minted once per run and never placed in the frozen prompt. */
export function newNonce(): string {
  return randomBytes(6).toString("hex");
}

/** Escape text that goes inside a nonce-tagged element so it can never close the element from inside. */
export function escapeTagText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
