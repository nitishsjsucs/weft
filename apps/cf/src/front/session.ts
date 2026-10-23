// /api/_session, /api/_session/lease and /api/_session/verify (design 6.2): the session status, lease start behind
// Turnstile, and the human grant refresh. The front never trusts the browser for a slot: the Lobby assigns one and
// the signed cookie carries it.
import {
  DO_NAMES, HOSTED_CONFIG_KEYS, MIN_LIVE_HEADROOM_USD, NEURON_SHARES, WORKERS_AI_PROVIDER_ID,
  type HostedProviderId, type HostedSpendStatus, type LeaseResult, type SessionStatus, type TurnstileTokenBody, type VerifyResult,
} from "../shared/contracts";
import { agentEnabled, envConfig } from "../shared/config";
import type { FrontEnv } from "../shared/env";
import { hostedError, json, readJson } from "../shared/http";
import { logEvent } from "../shared/log";
import { newVisitorId } from "../shared/tokens";
import { siteverify } from "./turnstile";
import { clearSessionCookies, grantCookie, leaseClaims, sessionCookies, type Visit } from "./visit";

const lobby = (env: FrontEnv) => env.LOBBY.get(env.LOBBY.idFromName(DO_NAMES.lobby));

const HOSTED_PROVIDER_IDS: readonly HostedProviderId[] = ["openai", WORKERS_AI_PROVIDER_ID, "scripted"];
const parseProvider = (v: string | null | undefined): HostedProviderId | null => {
  const t = (v ?? "").trim();
  return (HOSTED_PROVIDER_IDS as readonly string[]).includes(t) ? (t as HostedProviderId) : null;
};
/** Neurons a Workers AI run needs to start (packages/agent/src/providers/hosted.ts MIN_NEURONS_FOR_RUN). */
export const MIN_NEURONS_FOR_RUN = 1_000;

/** The provider a new run would pick: the KV default unless the world chose one, with the reason the banner shows. */
export function wantedProvider(i: { agentEnabled: boolean; configured: string | null; world: string | null }): SessionStatus["provider"] {
  if (!i.agentEnabled) return { id: "scripted", reason: "paused" };
  const fromWorld = parseProvider(i.world);
  return { id: fromWorld ?? parseProvider(i.configured) ?? "openai", reason: fromWorld ? "world" : "default" };
}

/**
 * The provider GET /api/_session reports (design 5.2 and 6.5): chooseHostedProvider's rules (packages/agent/src/
 * providers/hosted.ts, which the front cannot import) over what the front sees. The world's model switch wins over
 * the KV default ("world"); less than MIN_LIVE_HEADROOM_USD left for the day, the visitor, the IP hash or under the
 * live cap means "budget"; Workers AI without the neurons a run needs (the day cap and the agent's share) means
 * "neurons". Which providers the world can build is not visible here, so all of them are assumed.
 */
export function sessionProvider(want: SessionStatus["provider"], s: HostedSpendStatus | null): SessionStatus["provider"] {
  if (want.id === "scripted" || want.reason === "paused" || !s) return want;
  const left = [s.caps.dayUsd * 1e6 - s.spentMicros.day];
  if (s.spentMicros.visitor !== null) left.push(s.caps.visitorDayUsd * 1e6 - s.spentMicros.visitor);
  if (s.spentMicros.ip !== null) left.push(s.caps.ipDayUsd * 1e6 - s.spentMicros.ip);
  if (s.caps.liveUsd !== null) left.push(s.caps.liveUsd * 1e6 - s.spentMicros.live);
  if (left.some((l) => l < MIN_LIVE_HEADROOM_USD * 1e6)) return { id: "scripted", reason: "budget" };
  if (want.id === WORKERS_AI_PROVIDER_ID) {
    const neuronsLeft = Math.min(s.caps.neuronsDay - s.neurons.used, NEURON_SHARES.agent - s.neurons.byProduct.agent);
    if (neuronsLeft < MIN_NEURONS_FOR_RUN) return { id: "scripted", reason: "neurons" };
  }
  return want;
}

export async function sessionStatus(env: FrontEnv, v: Visit): Promise<Response> {
  const cfg = await envConfig(env);
  const st = await lobby(env).status({ visitor: v.session?.visitor ?? null, slot: v.session?.slot ?? null, gen: v.session?.gen ?? null, leaseExpiresMs: v.session?.leaseExpiresMs ?? null });
  const cookies: string[] = [];
  if (v.session && !st.lease) cookies.push(...clearSessionCookies());
  else if (v.session && st.lease && st.lease.gen !== v.session.gen) {
    // The visitor's own lease moved to a newer generation (a hosted reset): reissue the session cookie for it rather
    // than clearing the cookie the reset just set. The Lobby answers this only for a cookie of that same lease (its
    // slot and its total expiry), never for a cookie of the visitor's earlier lease.
    cookies.push(...(await sessionCookies(env, leaseClaims(v.session.visitor, st.lease), false)));
  }
  const enabled = agentEnabled(cfg);
  const want = wantedProvider({ agentEnabled: enabled, configured: cfg.get(HOSTED_CONFIG_KEYS.modelProvider) ?? null, world: st.lease ? st.worldProvider : null });
  let provider = want;
  // Only a leased visitor can start a run, so only a leased visitor's session read asks SpendDO for the caps: a
  // cookie-less GET /api/_session (anyone, any number of times) never reaches the ledger.
  if (st.lease && v.session && want.id !== "scripted" && want.reason !== "paused") {
    try {
      const s = await env.SPEND.get(env.SPEND.idFromName(DO_NAMES.spend)).status({ visitor: v.session.visitor, ipHash: v.ipHash });
      provider = sessionProvider(want, s);
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
    for (const c of await sessionCookies(env, leaseClaims(visitor, r), true)) res.headers.append("set-cookie", c);
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
