// ToolOutcome builders. Every variant carries tainted.
import type { RefusalCode, ToolOutcome } from "@weft/contracts";
import type { WeftCommand } from "@weft/core";

export function refusal(code: RefusalCode, message: string, tainted: boolean, def?: WeftCommand | null): ToolOutcome {
  const h = def?.errorHints?.[code];
  return { ok: false, refusal: { code, message, hint: h?.hint ?? null, example: h?.example ?? null }, tainted };
}

const KNOWN = new Set<string>(["UNKNOWN_COMMAND", "UNAVAILABLE", "DELEGATED_ONLY", "INVALID_INPUT", "UNKNOWN_REFERENCE", "NOT_PERMITTED", "OVER_CEILING",
  "LEASE_HELD", "PLAN_REQUIRED", "OUT_OF_PHASE", "NOT_DONE", "SKIPPED_AFTER_BLOCK", "SKIPPED_AFTER_PENDING", "TAINTED_WRITE", "BLOCKED_LINES",
  "UNGROUNDED", "BUDGET_EXCEEDED", "PII_IN_MEMORY", "SECRET_IN_MEMORY", "MISSING_SOURCE", "STALE_SUBJECT", "INTERNAL"]);

/** A command may throw a Refused WeftError, or any error with a string `code`, to refuse with that code. */
export function codeOfError(err: unknown): RefusalCode | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { _tag?: string; extra?: { code?: unknown }; code?: unknown };
  const c = e._tag === "Refused" ? e.extra?.code : e.code;
  if (typeof c !== "string") return null;
  return KNOWN.has(c) || c.startsWith("DOMAIN_") ? (c as RefusalCode) : null;
}

/** Thrown inside a transaction to roll it back while carrying the outcome out. */
export class Rollback extends Error {
  constructor(readonly outcome: ToolOutcome) { super("rollback"); }
}
