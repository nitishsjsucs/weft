// The operator lease (design 6.2 and 9.2): POST /api/_admin/lease and POST /api/_admin/grant, behind the same admin
// signature as every /api/_admin/* route (WEFT_ADMIN_TOKEN, 5-minute timestamp, constant-time check; the caller has
// checked it). They let the deploy's own checks (Playwright, the smoke's MCP and --live cases, the Verify walkthrough)
// hold a pool slot without Turnstile, which nothing automated may solve. Nothing else is skipped: the Lobby assigns the
// slot under the pool, the per-IP-hash lease cap and the day's budget like any lease, the slot charges live runs to the
// operator's visitor and IP hash under the spend caps, and the lease ends at its idle and total times.
import { DO_NAMES, type LeaseResult, type VerifyResult } from "../shared/contracts";
import type { FrontEnv } from "../shared/env";
import { hostedError, json, plainError } from "../shared/http";
import { logEvent } from "../shared/log";
import { DEFAULT_OPERATOR, OPERATOR_NAME_RE, operatorVisitorId } from "../shared/tokens";
import { clearSessionCookies, grantCookie, sessionCookies, withCookies, type Visit } from "./visit";

const lobby = (env: FrontEnv) => env.LOBBY.get(env.LOBBY.idFromName(DO_NAMES.lobby));

function operatorName(body: Record<string, unknown>): string | null {
  const name = body.name === undefined ? DEFAULT_OPERATOR : body.name;
  return typeof name === "string" && OPERATOR_NAME_RE.test(name) ? name : null;
}

/**
 * POST /api/_admin/lease `{ name? }`: a lease for the operator visitor of that name, with the session cookie and a
 * fresh human grant, exactly as a lease behind Turnstile sets them. Asking again while the lease lasts returns the
 * same slot and generation with new cookies; a waitlist, an IP-hash cap or a closed day answers as it would a visitor.
 */
export async function operatorLease(env: FrontEnv, v: Visit, body: Record<string, unknown>): Promise<Response> {
  const name = operatorName(body);
  if (name === null) return plainError(400, "ValidationError", "OPERATOR_NAME", "name is 1 to 32 of a-z, 0-9 and -");
  const visitor = await operatorVisitorId(env.WEFT_ADMIN_TOKEN!, name);
  const r: LeaseResult = await lobby(env).assign({ visitor, ipHash: v.ipHash });
  logEvent("lease.operator", { slot: r.status === "leased" ? r.slot : null, gen: r.status === "leased" ? r.gen : null, outcome: r.status });
  const res = json({ ...r, operator: name });
  if (r.status !== "leased") return res;
  const exp = Math.floor(Date.parse(r.expiresAt) / 1000);
  return withCookies(res, await sessionCookies(env, { visitor, slot: r.slot, gen: r.gen, exp }, true));
}

/**
 * POST /api/_admin/grant `{ name? }`: a fresh human grant for the operator's lease, sent with that lease's session
 * cookie. It never starts a lease: an ended one answers 409 LEASE_ENDED and clears the cookies.
 */
export async function operatorGrant(env: FrontEnv, v: Visit, body: Record<string, unknown>): Promise<Response> {
  const name = operatorName(body);
  if (name === null) return plainError(400, "ValidationError", "OPERATOR_NAME", "name is 1 to 32 of a-z, 0-9 and -");
  const visitor = await operatorVisitorId(env.WEFT_ADMIN_TOKEN!, name);
  if (!v.session || v.session.visitor !== visitor) return hostedError("LEASE_REQUIRED", `Send the session cookie of the operator lease "${name}"`);
  const st = await lobby(env).status({ visitor, slot: v.session.slot, gen: v.session.gen });
  if (!st.lease) return withCookies(hostedError("LEASE_ENDED", "This operator lease has ended; start a new one"), clearSessionCookies());
  const nowS = Math.floor(Date.now() / 1000);
  const cookie = await grantCookie(env, visitor, nowS);
  const exp = Number(/Max-Age=(\d+)/.exec(cookie)?.[1] ?? "0") + nowS;
  const out: VerifyResult = { ok: true, grantExpiresAt: new Date(exp * 1000).toISOString() };
  return withCookies(json(out), [cookie]);
}
