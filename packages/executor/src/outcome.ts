// ToolOutcome builders. Every variant carries tainted.
import type { RefusalCode, ToolOutcome } from "@weft/contracts";
import type { WeftCommand } from "@weft/core";

/**
 * A refusal's hint and example: a Refused error's own extra.hint and extra.example win (they carry values derived for
 * this call, such as the tax.update_rate arguments from the notice), then the command's static errorHints.
 */
export function refusal(code: RefusalCode, message: string, tainted: boolean, def?: WeftCommand | null, derived?: { hint?: string | null; example?: unknown } | null): ToolOutcome {
  const h = def?.errorHints?.[code];
  const hint = derived?.hint ?? h?.hint ?? null;
  const example = derived?.example ?? h?.example ?? null;
  return { ok: false, refusal: { code, message, hint, example }, tainted };
}

/** extra.hint and extra.example from a thrown Refused error, if any. */
export function hintsOfError(err: unknown): { hint?: string | null; example?: unknown } | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { _tag?: string; extra?: { hint?: unknown; example?: unknown } };
  if (e._tag !== "Refused" || !e.extra) return null;
  const hint = typeof e.extra.hint === "string" ? e.extra.hint : null;
  const example = e.extra.example ?? null;
  return hint || example ? { hint, example } : null;
}

const KNOWN = new Set<string>(["UNKNOWN_COMMAND", "UNAVAILABLE", "DELEGATED_ONLY", "INVALID_INPUT", "UNKNOWN_REFERENCE", "NOT_PERMITTED", "OVER_CEILING",
  "LEASE_HELD", "PLAN_REQUIRED", "OUT_OF_PHASE", "NOT_DONE", "SKIPPED_AFTER_BLOCK", "SKIPPED_AFTER_PENDING", "TAINTED_WRITE", "BLOCKED_LINES",
  "UNGROUNDED", "BUDGET_EXCEEDED", "PII_IN_MEMORY", "SECRET_IN_MEMORY", "MISSING_SOURCE", "STALE_SUBJECT", "INTERNAL",
  "SANDBOX_NOT_ALLOWED", "SANDBOX_TIMEOUT", "SANDBOX_OOM", "CALL_BUDGET"]);

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
