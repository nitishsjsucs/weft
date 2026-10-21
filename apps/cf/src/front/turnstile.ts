// Turnstile siteverify (design 6.2; developers.cloudflare.com/turnstile/get-started/server-side-validation/). Tokens are
// single-use and expire after 300 s; the call carries the visitor's IP and an idempotency key. The key is one UUID per
// verification, sent again on the one retry after a transport failure (a network error, a timeout or a 5xx), so a
// token Cloudflare already redeemed for a lost response is not refused as a duplicate. A token the client sends again
// is a new verification with a new key, so a replayed token is still refused (a key derived from the token would make
// Cloudflare answer every replay with the first success). At most two siteverify calls per request (design 8.1).
// Local and Miniflare runs use Cloudflare's published test secrets (1x0000000000000000000000000000000AA always passes,
// 2x0000000000000000000000000000000AA always fails) against TURNSTILE_VERIFY_URL; nothing here ever solves or skips
// a real challenge.
import type { FrontEnv } from "../shared/env";

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Per attempt; a retry gets its own. */
export const SITEVERIFY_TIMEOUT_MS = 5_000;

export interface SiteverifyResult { success: boolean; codes: string[]; hostname: string | null }

export async function siteverify(env: FrontEnv, token: string, ip: string, fetchImpl: typeof fetch = fetch): Promise<SiteverifyResult> {
  const secret = env.TURNSTILE_SECRET ?? "";
  if (!secret) return { success: false, codes: ["missing-input-secret"], hostname: null };
  if (!token || token.length > 2048) return { success: false, codes: ["invalid-input-response"], hostname: null };
  const idempotencyKey = crypto.randomUUID();
  let failed: SiteverifyResult = { success: false, codes: ["network"], hostname: null };
  for (let attempt = 0; attempt < 2; attempt++) {
    const form = new FormData();
    form.set("secret", secret);
    form.set("response", token);
    if (ip && ip !== "0.0.0.0") form.set("remoteip", ip);
    form.set("idempotency_key", idempotencyKey);
    try {
      const res = await fetchImpl(env.TURNSTILE_VERIFY_URL || SITEVERIFY_URL, { method: "POST", body: form, signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS) });
      if (res.status >= 500) { failed = { success: false, codes: [`http-${res.status}`], hostname: null }; continue; }
      if (!res.ok) return { success: false, codes: [`http-${res.status}`], hostname: null };
      const body = (await res.json()) as { success?: boolean; "error-codes"?: string[]; hostname?: string };
      return { success: body.success === true, codes: body["error-codes"] ?? [], hostname: body.hostname ?? null };
    } catch (e) {
      failed = { success: false, codes: [e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network"], hostname: null };
    }
  }
  return failed;
}
