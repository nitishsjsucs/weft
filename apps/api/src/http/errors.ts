import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "hono";
import { ZodError } from "zod";
import { Internal, isWeftError, NotFound, ValidationError, type ErrorBody } from "@weft/contracts";
import type { WeftEnv } from "./context";

/**
 * Where a 500's stack goes when the API runs under tests: `<dataDir>/run/errors.log` (vitest testMode, or the e2e
 * runner's WEFT_E2E=1). Tests keep stdout and stderr quiet, so without this file a 500 under load left no trace.
 */
export const ERROR_LOG = join("run", "errors.log");
/** The durable platform's 500 traces under tests (it has no errors.log); the last 50, newest last. */
export const durableErrors: string[] & { push(...t: string[]): number } = Object.assign([] as string[], {
  push(this: string[], ...t: string[]) { Array.prototype.push.apply(this, t); while (this.length > 50) this.shift(); return this.length; },
});

function logInternal(c: Context<WeftEnv>, text: string): void {
  const weft = c.var.weft;
  const underTest = !!weft?.testMode || process.env.WEFT_E2E === "1";
  // The durable platform has no data dir on disk: its 500s go to console.error, redacted, and so to Workers Logs.
  if (weft?.platform?.kind === "durable") { if (!weft.testMode) console.error(text); else durableErrors.push(text.slice(0, 4000)); return; }
  if (underTest && weft?.dataDir && weft.dataDir !== ":memory:") {
    try {
      mkdirSync(join(weft.dataDir, "run"), { recursive: true });
      appendFileSync(join(weft.dataDir, ERROR_LOG), `${new Date().toISOString()} ${c.req.method} ${new URL(c.req.url).pathname}\n${text}\n\n`);
    } catch { /* the data dir is gone (a test closed it); the 500 body still goes out */ }
  }
  if (!weft?.testMode) console.error(text);
}

/** Maps any thrown value to the `{ _tag, message, ...extra }` body (SPEC 10). Messages are redacted. */
export function toErrorResponse(err: unknown, c: Context<WeftEnv>): Response {
  const redact = (s: string) => { try { return c.var.weft?.executor.redact(s) ?? s; } catch { return s; } };
  let e = err;
  if (err instanceof ZodError) e = new ValidationError("Invalid request", { issues: err.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message })) });
  if (!isWeftError(e)) {
    logInternal(c, redact(err instanceof Error ? err.stack ?? err.message : String(err)));
    e = new Internal("Internal error");
  }
  const we = e as InstanceType<typeof Internal>;
  const body: ErrorBody = { ...we.toBody(), message: redact(we.message) };
  return c.json(body, we.status as 400);
}

export function notFoundResponse(c: Context<WeftEnv>): Response {
  return toErrorResponse(new NotFound(`No route for ${c.req.method} ${new URL(c.req.url).pathname}`), c);
}
