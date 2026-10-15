// `_tag` errors (SPEC 10). HTTP body: `{ _tag, message, ...extra }`.
export const ERROR_STATUS = {
  Unauthorized: 401, Forbidden: 403, NotFound: 404, ValidationError: 400, Conflict: 409,
  Refused: 422, RateLimitExceeded: 429, NotImplemented: 501, Internal: 500,
} as const;
export type ErrorTag = keyof typeof ERROR_STATUS;
export interface ErrorBody { _tag: ErrorTag; message: string; [extra: string]: unknown }

export class WeftError extends Error {
  readonly _tag: ErrorTag;
  readonly extra: Record<string, unknown>;
  constructor(tag: ErrorTag, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this._tag = tag;
    this.extra = extra;
    this.name = tag;
  }
  get status(): number { return ERROR_STATUS[this._tag]; }
  toBody(): ErrorBody { return { ...this.extra, _tag: this._tag, message: this.message }; }
}
export class Unauthorized extends WeftError { constructor(m = "Unauthorized", x?: Record<string, unknown>) { super("Unauthorized", m, x); } }
export class Forbidden extends WeftError { constructor(m = "Forbidden", x?: Record<string, unknown>) { super("Forbidden", m, x); } }
export class NotFound extends WeftError { constructor(m = "Not found", x?: Record<string, unknown>) { super("NotFound", m, x); } }
export class ValidationError extends WeftError { constructor(m = "Invalid request", x?: Record<string, unknown>) { super("ValidationError", m, x); } }
export class Conflict extends WeftError { constructor(m = "Conflict", x?: Record<string, unknown>) { super("Conflict", m, x); } }
export class Refused extends WeftError { constructor(code: string, m: string, x?: Record<string, unknown>) { super("Refused", m, { ...x, code }); } }
export class RateLimitExceeded extends WeftError { constructor(m = "Rate limit exceeded", x?: Record<string, unknown>) { super("RateLimitExceeded", m, x); } }
export class NotImplemented extends WeftError { constructor(what: string) { super("NotImplemented", `Not implemented: ${what}`); } }
export class Internal extends WeftError { constructor(m = "Internal error", x?: Record<string, unknown>) { super("Internal", m, x); } }

export function isWeftError(e: unknown): e is WeftError { return e instanceof WeftError; }
