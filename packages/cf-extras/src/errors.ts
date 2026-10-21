// Errors the extras raise. `retryable` tells a queue handler to retry the message (a binding or network failure)
// instead of recording it as failed (bad input, a cap, a switched-off extra). Track cf6-extras.

export type ExtrasErrorCode =
  | "PDF_DISABLED" | "PDF_BUDGET" | "PDF_KEY_MISMATCH" | "PDF_TOO_LARGE" | "PDF_RENDER_FAILED"
  | "JOB_INVALID" | "JOB_STALE" | "BLOB_MISSING" | "BLOB_MISMATCH" | "WRITE_BACK_REFUSED" | "RECALL_UNAVAILABLE"
  | "EMBED_BUDGET" | "BUDGET_WAIT" | "EXPORT_FAILED" | "BINDING_MISSING" | "DEAD_LETTER";

export class ExtrasError extends Error {
  constructor(readonly code: ExtrasErrorCode, message: string, readonly retryable = false) {
    super(message);
    this.name = "ExtrasError";
  }
}

export const isRetryable = (e: unknown): boolean => !(e instanceof ExtrasError) || e.retryable;
export const codeOf = (e: unknown): string => (e instanceof ExtrasError ? e.code : "TRANSIENT");
/** A message safe for logs and D1: no stack, clipped. */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300);
