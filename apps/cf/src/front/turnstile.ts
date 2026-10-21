// Turnstile siteverify (design 6.2; developers.cloudflare.com/turnstile/get-started/server-side-validation/). Tokens are
// single-use and expire after 300 s; the call carries the visitor's IP and an idempotency key so a retried verify is
// not a second use. At most one siteverify per request (design 8.1). Local and Miniflare runs use Cloudflare's
// published test secrets (1x0000000000000000000000000000000AA always passes, 2x0000000000000000000000000000000AA
// always fails); nothing here ever solves or skips a real challenge.
import type { FrontEnv } from "../shared/env";

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface SiteverifyResult { success: boolean; codes: string[]; hostname: string | null }

export async function siteverify(env: FrontEnv, token: string, ip: string, fetchImpl: typeof fetch = fetch): Promise<SiteverifyResult> {
  const secret = env.TURNSTILE_SECRET ?? "";
  if (!secret) return { success: false, codes: ["missing-input-secret"], hostname: null };
  if (!token || token.length > 2048) return { success: false, codes: ["invalid-input-response"], hostname: null };
  const form = new FormData();
  form.set("secret", secret);
  form.set("response", token);
  if (ip && ip !== "0.0.0.0") form.set("remoteip", ip);
  form.set("idempotency_key", crypto.randomUUID());
  try {
    const res = await fetchImpl(env.TURNSTILE_VERIFY_URL || SITEVERIFY_URL, { method: "POST", body: form, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { success: false, codes: [`http-${res.status}`], hostname: null };
    const body = (await res.json()) as { success?: boolean; "error-codes"?: string[]; hostname?: string };
    return { success: body.success === true, codes: body["error-codes"] ?? [], hostname: body.hostname ?? null };
  } catch (e) {
    return { success: false, codes: [e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network"], hostname: null };
  }
}
