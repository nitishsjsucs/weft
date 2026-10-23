// Who is asking (design 3.4 and 6.2): the signed session cookie (visitor, slot, generation, expiry), the human grant,
// the smoke header and the daily-salted IP hash. About 0.1 ms of HMAC per request; no Durable Object call.
import { DO_NAMES, HOSTED_SETTINGS, HUMAN_GRANT_COOKIE, SESSION_COOKIE, TRUST_HEADERS, type SessionClaims } from "../shared/contracts";
import type { FrontEnv } from "../shared/env";
import { clearCookie, parseCookies, setCookie, utcDay } from "../shared/http";
import { grantToken, ipHash, readGrant, readSession, sessionToken, verifySmoke } from "../shared/tokens";
import { verifyToken } from "../shared/crypto";

export interface Visit {
  ip: string;
  ipHash: string;
  /** A valid, unexpired session. */
  session: SessionClaims | null;
  /** The visitor id of an expired but authentic session cookie (reused for the next lease). */
  lapsedVisitor: string | null;
  /** The session cookie is present but forged or malformed. */
  tampered: boolean;
  /** A valid grant for this session's visitor, and when it expires (unix seconds). */
  grant: boolean;
  grantExp: number | null;
  /** A valid x-weft-smoke header: a human session restricted to slot-smoke. */
  smoke: boolean;
}

export class FrontConfigError extends Error {}

export function secrets(env: FrontEnv): { session: string; ctx: string; proxy: string } {
  const session = env.WEFT_SESSION_SECRET ?? "";
  const ctx = env.WEFT_CTX_SECRET ?? "";
  const proxy = env.WEFT_PROXY_SECRET ?? "";
  if (session.length < 32 || ctx.length < 32 || proxy.length < 32) throw new FrontConfigError("the front Worker's secrets are not installed");
  return { session, ctx, proxy };
}

export async function resolveVisit(req: Request, env: FrontEnv): Promise<Visit> {
  const s = secrets(env);
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? "0.0.0.0";
  const visit: Visit = { ip, ipHash: await ipHash(s.session, ip, utcDay()), session: null, lapsedVisitor: null, tampered: false, grant: false, grantExp: null, smoke: false };
  const cookies = parseCookies(req.headers.get("cookie"));
  const sc = cookies.get(SESSION_COOKIE);
  if (sc) {
    const r = await readSession(s.session, sc);
    if (r.ok) visit.session = r.claims;
    else if (r.reason === "expired") {
      const raw = await verifyToken<SessionClaims>(s.session, "weft-session", sc);
      visit.lapsedVisitor = raw.ok && typeof raw.claims.visitor === "string" ? raw.claims.visitor : null;
    } else visit.tampered = true;
  }
  const gc = cookies.get(HUMAN_GRANT_COOKIE);
  if (gc && visit.session) {
    const g = await readGrant(s.session, gc);
    visit.grant = g.ok && g.claims.visitor === visit.session.visitor;
    visit.grantExp = visit.grant && g.ok ? g.claims.exp : null;
  }
  visit.smoke = await verifySmoke(env.WEFT_SMOKE_TOKEN, req.headers.get(TRUST_HEADERS.smoke), { method: req.method, path: new URL(req.url).pathname });
  return visit;
}

/** The world a request goes to: slot-smoke for the smoke, the lease's slot, or the showcase. */
export function targetOf(v: Visit): { slot: string; gen: number; leased: boolean } {
  if (v.smoke) return { slot: DO_NAMES.smoke, gen: 0, leased: true };
  if (v.session) return { slot: v.session.slot, gen: v.session.gen, leased: true };
  return { slot: DO_NAMES.showcase, gen: 0, leased: false };
}

export async function sessionCookies(env: FrontEnv, c: SessionClaims, grant: boolean, nowS = Math.floor(Date.now() / 1000)): Promise<string[]> {
  const s = secrets(env);
  const out = [setCookie(SESSION_COOKIE, await sessionToken(s.session, c), c.exp - nowS)];
  if (grant) out.push(await grantCookie(env, c.visitor, nowS));
  return out;
}

export async function grantCookie(env: FrontEnv, visitor: string, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  const exp = nowS + HOSTED_SETTINGS.humanGrantMinutes * 60;
  return setCookie(HUMAN_GRANT_COOKIE, await grantToken(secrets(env).session, { visitor, exp }), exp - nowS);
}

export const clearSessionCookies = (): string[] => [clearCookie(SESSION_COOKIE), clearCookie(HUMAN_GRANT_COOKIE)];

export function withCookies(res: Response, cookies: string[]): Response {
  if (!cookies.length) return res;
  const out = new Response(res.body, res);
  for (const c of cookies) out.headers.append("set-cookie", c);
  return out;
}
