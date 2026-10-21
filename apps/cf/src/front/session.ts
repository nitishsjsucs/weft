// /api/_session, /api/_session/lease and /api/_session/verify (design 6.2): the session status, lease start behind
// Turnstile, and the human grant refresh. The front never trusts the browser for a slot: the Lobby assigns one and
// the signed cookie carries it.
import {
  DO_NAMES, HOSTED_CONFIG_KEYS, MIN_LIVE_HEADROOM_USD,
  type HostedProviderId, type LeaseResult, type SessionStatus, type TurnstileTokenBody, type VerifyResult,
} from "../shared/contracts";
import { agentEnabled, envConfig } from "../shared/config";
import type { FrontEnv } from "../shared/env";
import { hostedError, json, readJson } from "../shared/http";
import { logEvent } from "../shared/log";
import { newVisitorId } from "../shared/tokens";
import { siteverify } from "./turnstile";
import { clearSessionCookies, grantCookie, sessionCookies, type Visit } from "./visit";

const lobby = (env: FrontEnv) => env.LOBBY.get(env.LOBBY.idFromName(DO_NAMES.lobby));

export async function sessionStatus(env: FrontEnv, v: Visit): Promise<Response> {
  const cfg = await envConfig(env);
  const st = await lobby(env).status({ visitor: v.session?.visitor ?? null, slot: v.session?.slot ?? null, gen: v.session?.gen ?? null });
  const cookies: string[] = [];
  if (v.session && !st.lease) cookies.push(...clearSessionCookies());
  const enabled = agentEnabled(cfg);
  const configured = (cfg.get(HOSTED_CONFIG_KEYS.modelProvider) ?? "openai").trim() as HostedProviderId;
  let provider: SessionStatus["provider"] = { id: configured, reason: "default" };
  if (!enabled) provider = { id: "scripted", reason: "paused" };
  else if (configured !== "scripted") {
    try {
      const s = await env.SPEND.get(env.SPEND.idFromName(DO_NAMES.spend)).status({ visitor: st.lease ? v.session?.visitor ?? null : null, ipHash: v.ipHash });
      const leftDay = s.caps.dayUsd * 1e6 - s.spentMicros.day;
      const leftVisitor = s.spentMicros.visitor === null ? Infinity : s.caps.visitorDayUsd * 1e6 - s.spentMicros.visitor;
      const leftIp = s.spentMicros.ip === null ? Infinity : s.caps.ipDayUsd * 1e6 - s.spentMicros.ip;
      if (Math.min(leftDay, leftVisitor, leftIp) < MIN_LIVE_HEADROOM_USD * 1e6) provider = { id: "scripted", reason: "budget" };
      else if (configured === "workers_ai" && s.neurons.used >= s.caps.neuronsDay) provider = { id: "scripted", reason: "neurons" };
    } catch { /* the status still answers; the run admission decides for itself */ }
  }
  const grantExpiresAt = v.grantExp !== null && st.lease ? new Date(v.grantExp * 1000).toISOString() : null;
  const body: SessionStatus = {
    world: st.lease ? "slot" : "showcase",
    lease: st.lease,
    grantExpiresAt,
    level: st.level,
    pool: st.pool,
    provider,
    agentEnabled: enabled,
  };
  const res = json(body);
  for (const c of cookies) res.headers.append("set-cookie", c);
  return res;
}

export async function startLease(req: Request, env: FrontEnv, v: Visit): Promise<Response> {
  const body = await readJson<TurnstileTokenBody>(req);
  if (!body || typeof body.token !== "string") return hostedError("TURNSTILE_FAILED", "A Turnstile token is required");
  const check = await siteverify(env, body.token, v.ip);
  if (!check.success) {
    logEvent("turnstile.failed", { outcome: check.codes.join(",") });
    return hostedError("TURNSTILE_FAILED", "The human check did not pass; try again");
  }
  const visitor = v.session?.visitor ?? v.lapsedVisitor ?? newVisitorId();
  const r: LeaseResult = await lobby(env).assign({ visitor, ipHash: v.ipHash });
  const res = json(r);
  if (r.status === "leased") {
    const exp = Math.floor(Date.parse(r.expiresAt) / 1000);
    for (const c of await sessionCookies(env, { visitor, slot: r.slot, gen: r.gen, exp }, true)) res.headers.append("set-cookie", c);
  } else if (v.session) {
    for (const c of clearSessionCookies()) res.headers.append("set-cookie", c);
  }
  return res;
}

export async function verifyHuman(req: Request, env: FrontEnv, v: Visit): Promise<Response> {
  if (!v.session) return hostedError("LEASE_REQUIRED", "Start your own demo company first");
  const body = await readJson<TurnstileTokenBody>(req);
  if (!body || typeof body.token !== "string") return hostedError("TURNSTILE_FAILED", "A Turnstile token is required");
  const check = await siteverify(env, body.token, v.ip);
  if (!check.success) return hostedError("TURNSTILE_FAILED", "The human check did not pass; try again");
  const nowS = Math.floor(Date.now() / 1000);
  const cookie = await grantCookie(env, v.session.visitor, nowS);
  const exp = Number(/Max-Age=(\d+)/.exec(cookie)?.[1] ?? "0") + nowS;
  const out: VerifyResult = { ok: true, grantExpiresAt: new Date(exp * 1000).toISOString() };
  const res = json(out);
  res.headers.append("set-cookie", cookie);
  return res;
}
