// Forwarding to a world (design 3.4 steps 5 to 7 and 6.4): client copies of the trust headers and the cookies are
// dropped, x-weft-proxy and an HMAC'd x-weft-ctx are set, and the request goes to the Durable Object named by the
// signed cookie, the smoke header or an MCP key prefix, never by anything else the client sends. Bodies stream both
// ways (SSE included).
import { DO_NAMES, TRUST_HEADERS, type WeftCtx } from "../shared/contracts";
import type { FrontEnv } from "../shared/env";
import { LEASE_HEADER } from "../shared/routes";
import { signCtx } from "../shared/tokens";
import { clearSessionCookies, secrets, withCookies } from "./visit";

export interface ForwardTarget {
  slot: string;
  ctx: Omit<WeftCtx, "iat">;
  /** The path inside the world (for example /v1/workers or /mcp). */
  path: string;
  search: string;
}

export function stripTrust(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const h of Object.values(TRUST_HEADERS)) out.delete(h);
  out.delete("cookie");
  out.delete("x-forwarded-host");
  return out;
}

export async function forwardToWorld(req: Request, env: FrontEnv, t: ForwardTarget): Promise<Response> {
  const s = secrets(env);
  const headers = stripTrust(req.headers);
  headers.set(TRUST_HEADERS.proxy, s.proxy);
  headers.set(TRUST_HEADERS.ctx, await signCtx(s.ctx, { ...t.ctx, iat: Math.floor(Date.now() / 1000) }));
  const origin = (env.WEFT_PUBLIC_ORIGIN ?? new URL(req.url).origin).replace(/\/$/, "");
  const init: RequestInit & { duplex?: "half" } = { method: req.method, headers, redirect: "manual" };
  if (req.body && req.method !== "GET" && req.method !== "HEAD") { init.body = req.body; init.duplex = "half"; }
  const stub = env.COMPANY.get(env.COMPANY.idFromName(t.slot));
  const res = await stub.fetch(new Request(`${origin}${t.path}${t.search}`, init));
  if (res.status === 409 && res.headers.get(LEASE_HEADER) === "ended") {
    // A request that left with the cookie from before a hosted reset of the visitor's own lease reaches the world
    // after the generation moved on. The lease lives on (the reset reissued the cookie), so keep the cookies and let
    // the next session read pick up the new generation, instead of logging the visitor out.
    if (await leaseMovedOn(env, t.ctx)) return res;
    return withCookies(res, clearSessionCookies());
  }
  return res;
}

/** True when the visitor still holds a lease on the same slot under a newer generation than this request carried. */
async function leaseMovedOn(env: FrontEnv, ctx: ForwardTarget["ctx"]): Promise<boolean> {
  if (!ctx.visitor) return false;
  try {
    const st = await env.LOBBY.get(env.LOBBY.idFromName(DO_NAMES.lobby)).status({ visitor: ctx.visitor, slot: ctx.slot, gen: ctx.gen });
    return !!st.lease && st.lease.slot === ctx.slot && st.lease.gen > ctx.gen;
  } catch {
    return false;
  }
}
