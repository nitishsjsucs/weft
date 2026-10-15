import type { Context } from "hono";
import { ZodError } from "zod";
import { Internal, isWeftError, NotFound, ValidationError, type ErrorBody } from "@weft/contracts";
import type { WeftEnv } from "./context";

/** Maps any thrown value to the `{ _tag, message, ...extra }` body (SPEC 10). Messages are redacted. */
export function toErrorResponse(err: unknown, c: Context<WeftEnv>): Response {
  const redact = (s: string) => { try { return c.var.weft?.executor.redact(s) ?? s; } catch { return s; } };
  let e = err;
  if (err instanceof ZodError) e = new ValidationError("Invalid request", { issues: err.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message })) });
  if (!isWeftError(e)) {
    if (!c.var.weft?.testMode) console.error(redact(err instanceof Error ? err.stack ?? err.message : String(err)));
    e = new Internal("Internal error");
  }
  const we = e as InstanceType<typeof Internal>;
  const body: ErrorBody = { ...we.toBody(), message: redact(we.message) };
  return c.json(body, we.status as 400);
}

export function notFoundResponse(c: Context<WeftEnv>): Response {
  return toErrorResponse(new NotFound(`No route for ${c.req.method} ${new URL(c.req.url).pathname}`), c);
}
