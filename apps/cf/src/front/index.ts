// weft (the front Worker, design 3.1 and 3.4): workers_dev true at weft.nitish-ratakonda.workers.dev. Pages are static
// assets with no Worker invocation; this runs first only for /api/* and /mcp (run_worker_first). It never imports
// @weft/*, so its cold start and per-request CPU stay a few milliseconds: HMAC checks, the Rate Limiting binding,
// routing by the signed cookie or the MCP key prefix, the showcase memo, and one siteverify on the session routes.
import {
  DO_NAMES, HOSTED_CONFIG_KEYS, HOSTED_PATHS, HOSTED_SETTINGS, parseHostedMcpKey,
  type HostedResetResult,
} from "../shared/contracts";
import { agentEnabled, envConfig } from "../shared/config";
import type { FrontEnv } from "../shared/env";
import { hostedError, isMutation, json, plainError, readJson } from "../shared/http";
import { logError } from "../shared/log";
import { DO_PATHS, HEALTH_PATH, isModelAdmission, isUpload, SIM_RESET_PATH } from "../shared/routes";
import { ADMIN_HEADER, mcpKeyId, signCtx, verifyAdmin } from "../shared/tokens";
import { serveAssets } from "./assets";
import { forwardToWorld, stripTrust } from "./forward";
import { ResponseMemo } from "./memo";
import { sessionStatus, startLease, verifyHuman } from "./session";
import { clearSessionCookies, FrontConfigError, resolveVisit, secrets, sessionCookies, targetOf, withCookies, type Visit } from "./visit";

/** In-isolate memo of showcase GET responses (design 4.5). */
export const showcaseMemo = new ResponseMemo();

const lobby = (env: FrontEnv) => env.LOBBY.get(env.LOBBY.idFromName(DO_NAMES.lobby));
const UPLOAD_OVERHEAD = 64 * 1024;

function originAllowed(req: Request, env: FrontEnv): boolean {
  const origin = req.headers.get("origin");
  const allowed = (env.WEFT_PUBLIC_ORIGIN ?? new URL(req.url).origin).replace(/\/$/, "");
  return origin !== null && origin.replace(/\/$/, "") === allowed;
}

async function rateLimited(rl: RateLimit, key: string): Promise<boolean> {
  try {
    return !(await rl.limit({ key })).success;
  } catch {
    return false;   // the binding is a coarse backstop (design 6.3); the Durable Objects hold the real caps
  }
}

export default {
  async fetch(req: Request, env: FrontEnv): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === HOSTED_PATHS.mcp || path.startsWith(`${HOSTED_PATHS.mcp}/`)) return await mcp(req, env, url);
      if (!path.startsWith("/api/")) return await serveAssets(req, env, url);
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });
      const visit = await resolveVisit(req, env);
      if (visit.tampered) return withCookies(hostedError("SESSION_INVALID", "The session cookie is not valid"), clearSessionCookies());
      if (await rateLimited(env.RL_API, `api:${visit.ipHash}`)) return hostedError("RATE_LIMITED", "Too many requests; slow down a little", { retryAfterS: 60 });

      if (path === HOSTED_PATHS.session && req.method === "GET") return await sessionStatus(env, visit);
      if (path === HOSTED_PATHS.lease || path === HOSTED_PATHS.verify) {
        if (req.method !== "POST") return plainError(405, "ValidationError", "METHOD", "POST a Turnstile token");
        if (!originAllowed(req, env)) return hostedError("ORIGIN_REFUSED", "Cross-origin requests are refused");
        if (await rateLimited(env.RL_MUTATE, `mut:${visit.ipHash}`)) return hostedError("RATE_LIMITED", "Too many requests; slow down a little", { retryAfterS: 60 });
        return path === HOSTED_PATHS.lease ? await startLease(req, env, visit) : await verifyHuman(req, env, visit);
      }
      if (path === HOSTED_PATHS.live) return await live(req, env, visit);
      if (path === HOSTED_PATHS.admin || path.startsWith(`${HOSTED_PATHS.admin}/`)) return await admin(req, env, url);
      if (path.startsWith("/api/_hosted/")) return await hosted(req, env, url, visit);
      if (path.startsWith("/api/v1/")) return await api(req, env, url, visit);
      return plainError(404, "NotFound", "NOT_FOUND", "No such API route");
    } catch (e) {
      if (e instanceof FrontConfigError) return plainError(503, "NotImplemented", "NOT_CONFIGURED", e.message);
      logError("front.error", e, { path });
      return plainError(500, "Internal", "INTERNAL", "Something went wrong in Weft's front door");
    }
  },
} satisfies ExportedHandler<FrontEnv>;

/** The gates every mutation passes (design 6.3): same origin, a lease, a fresh human grant, RL_MUTATE. */
async function mutationGate(req: Request, env: FrontEnv, v: Visit): Promise<Response | null> {
  // A GET gated like a mutation (a PDF) sends no Origin; the SameSite=Strict cookies already keep it same-site.
  if (!v.smoke && isMutation(req.method) && !originAllowed(req, env)) return hostedError("ORIGIN_REFUSED", "Cross-origin requests are refused");
  if (!v.smoke && !v.session) return hostedError("LEASE_REQUIRED", "The shared demo company is read-only; start your own demo company to make changes");
  if (!v.smoke && !v.grant) return hostedError("TURNSTILE_REQUIRED", "Confirm you are human to keep making changes");
  if (await rateLimited(env.RL_MUTATE, `mut:${v.ipHash}`)) return hostedError("RATE_LIMITED", "Too many changes in a minute; slow down a little", { retryAfterS: 60 });
  return null;
}

function ctxOf(v: Visit, slot: string, gen: number) {
  return { slot, gen, visitor: v.smoke ? null : v.session?.visitor ?? null, ipHash: v.ipHash, human: v.smoke || v.grant, smoke: v.smoke };
}

async function api(req: Request, env: FrontEnv, url: URL, v: Visit): Promise<Response> {
  const apiPath = url.pathname.slice("/api".length);
  const t = targetOf(v);
  if (isMutation(req.method)) {
    const refused = await mutationGate(req, env, v);
    if (refused) return refused;
    if (isModelAdmission(req.method, apiPath) && !agentEnabled(await envConfig(env))) {
      return hostedError("AGENT_PAUSED", "The agent is paused on this demo right now", { retryAfterS: 300 });
    }
    if (apiPath === SIM_RESET_PATH && req.method === "POST") return resetIntercept(req, env, v);
    if (isUpload(req.method, req.headers.get("content-type"))) {
      const len = Number(req.headers.get("content-length") ?? "NaN");
      if (!Number.isFinite(len)) return plainError(411, "ValidationError", "LENGTH_REQUIRED", "Uploads need a Content-Length");
      if (len > HOSTED_SETTINGS.uploadMaxBytes + UPLOAD_OVERHEAD) return hostedError("UPLOAD_LIMIT", "Uploads are limited to 1.5 MB on the hosted demo");
      if (!v.smoke) {
        const r = await lobby(env).take({ key: `upload:${v.session!.visitor}`, limit: HOSTED_SETTINGS.uploadsPerVisitorPerDay });
        if (!r.ok) return hostedError("UPLOAD_LIMIT", `The hosted demo allows ${HOSTED_SETTINGS.uploadsPerVisitorPerDay} uploads a day`);
      }
    }
    return forwardToWorld(req, env, { slot: t.slot, ctx: ctxOf(v, t.slot, t.gen), path: apiPath, search: url.search });
  }
  // Reads. The showcase is immutable per snapshot: memoized in the isolate (health is always fresh).
  if (!t.leased && req.method === "GET" && apiPath !== HEALTH_PATH) {
    const cfg = await envConfig(env);
    const key = ResponseMemo.key({ path: apiPath, search: url.search, principal: req.headers.get("x-weft-principal"), snapshot: cfg.get(HOSTED_CONFIG_KEYS.snapshotVersion) ?? "none" });
    const hit = showcaseMemo.get(key);
    if (hit) return hit;
    const res = await forwardToWorld(req, env, { slot: t.slot, ctx: ctxOf(v, t.slot, t.gen), path: apiPath, search: url.search });
    return showcaseMemo.put(key, res);
  }
  return forwardToWorld(req, env, { slot: t.slot, ctx: ctxOf(v, t.slot, t.gen), path: apiPath, search: url.search });
}

/** "Reset demo data..." (design 6.2 step 5): through the Lobby, rich profile only, a new cookie generation. */
async function resetIntercept(req: Request, env: FrontEnv, v: Visit): Promise<Response> {
  const body = await readJson<{ profile?: unknown }>(req);
  if (body === null) return plainError(400, "ValidationError", "BAD_BODY", "The reset body is JSON: { profile? }");
  if (body.profile !== undefined && body.profile !== "rich") return hostedError("HOSTED_RESET_PROFILE", "The hosted demo resets to the rich world only");
  if (v.smoke) {
    const r = await lobby(env).resetWorld({ slot: DO_NAMES.smoke });
    return "error" in r ? hostedError(r.error, r.message) : json({ ...r, profile: "rich" });
  }
  const s = v.session!;
  const r = await lobby(env).reset({ visitor: s.visitor, slot: s.slot, gen: s.gen });
  if ("error" in r) {
    const res = hostedError(r.error, r.message);
    return r.error === "LEASE_ENDED" ? withCookies(res, clearSessionCookies()) : res;
  }
  const out: HostedResetResult & { profile: "rich" } = { ...r, profile: "rich" };
  return withCookies(json(out), await sessionCookies(env, { ...s, gen: r.gen }, false));
}

async function live(req: Request, env: FrontEnv, v: Visit): Promise<Response> {
  if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return plainError(426, "ValidationError", "UPGRADE_REQUIRED", "Expected a WebSocket upgrade");
  const t = targetOf(v);
  if (!t.leased) return hostedError("LEASE_REQUIRED", "The live feed belongs to your own demo company");
  return forwardToWorld(req, env, { slot: t.slot, ctx: ctxOf(v, t.slot, t.gen), path: DO_PATHS.live, search: "" });
}

async function hosted(req: Request, env: FrontEnv, url: URL, v: Visit): Promise<Response> {
  const path = url.pathname;
  const t = targetOf(v);
  if (path === HOSTED_PATHS.modelSwitch || path === HOSTED_PATHS.mcpKey) {
    const refused = await mutationGate(req, env, v);
    if (refused) return refused;
    const inner = path === HOSTED_PATHS.modelSwitch ? DO_PATHS.model : DO_PATHS.mcpKey;
    return forwardToWorld(req, env, { slot: t.slot, ctx: ctxOf(v, t.slot, t.gen), path: inner, search: "" });
  }
  const gated = path === HOSTED_PATHS.dictate || path.startsWith(`${HOSTED_PATHS.pdf}/`);
  if (gated || isMutation(req.method)) {
    const refused = await mutationGate(req, env, v);
    if (refused) return refused;
  }
  if (![HOSTED_PATHS.platform, HOSTED_PATHS.models, HOSTED_PATHS.help, HOSTED_PATHS.dictate].includes(path as never) && !path.startsWith(`${HOSTED_PATHS.pdf}/`)) {
    return plainError(404, "NotFound", "NOT_FOUND", "No such hosted route");
  }
  return forwardToExtras(req, env, url, ctxOf(v, t.slot, t.gen));
}

async function forwardToExtras(req: Request, env: FrontEnv, url: URL, ctx: ReturnType<typeof ctxOf>): Promise<Response> {
  const headers = stripTrust(req.headers);
  headers.set("x-weft-ctx", await signCtx(secrets(env).ctx, { ...ctx, iat: Math.floor(Date.now() / 1000) }));
  const init: RequestInit & { duplex?: "half" } = { method: req.method, headers };
  if (req.body && req.method !== "GET" && req.method !== "HEAD") { init.body = req.body; init.duplex = "half"; }
  return env.CORE.fetch(new Request(url.toString(), init));
}

/** /mcp (design 6.3 and 6.4): routed by the key prefix wk_mcp_<slot>_<gen>_<rand>, never by the URL. */
async function mcp(req: Request, env: FrontEnv, url: URL): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  const key = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? req.headers.get("x-api-key") ?? "";
  const parsed = key ? parseHostedMcpKey(key) : null;
  if (!parsed || !/^slot-\d+$/.test(parsed.slot)) return plainError(401, "Unauthorized", "MCP_KEY_REQUIRED", "Use the MCP key from your demo company (Bearer wk_mcp_...)");
  if (await rateLimited(env.RL_MCP, `mcp:${await mcpKeyId(key)}`)) return hostedError("RATE_LIMITED", "Too many MCP requests in a minute", { retryAfterS: 60 });
  const v = await resolveVisit(req, env);
  return forwardToWorld(req, env, {
    slot: parsed.slot, ctx: { slot: parsed.slot, gen: parsed.gen, visitor: null, ipHash: v.ipHash, human: false, smoke: false },
    path: DO_PATHS.mcp, search: url.search,
  });
}

/** /api/_admin/* (design 9.2 and 10): HMAC with WEFT_ADMIN_TOKEN over method, path, timestamp and body. */
async function admin(req: Request, env: FrontEnv, url: URL): Promise<Response> {
  const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
  if (body.length > 64 * 1024) return plainError(413, "ValidationError", "TOO_LARGE", "Admin bodies are small");
  const ok = await verifyAdmin({ token: env.WEFT_ADMIN_TOKEN, header: req.headers.get(ADMIN_HEADER), method: req.method, path: url.pathname, body });
  if (!ok) return plainError(401, "Unauthorized", "ADMIN_SIGNATURE", "A valid admin signature is required");
  const parsed = (() => { try { return body ? (JSON.parse(body) as Record<string, unknown>) : {}; } catch { return null; } })();
  if (parsed === null) return plainError(400, "ValidationError", "BAD_BODY", "Admin bodies are JSON");
  const op = url.pathname.slice(`${HOSTED_PATHS.admin}/`.length);
  switch (`${req.method} ${op}`) {
    case "POST provision": {
      const slots = Array.isArray(parsed.slots) ? parsed.slots.filter((s): s is string => typeof s === "string") : undefined;
      return json({ ok: true, steps: await lobby(env).provision({ slots, force: parsed.force === true }) });
    }
    case "POST conformance":
      return json(await env.COMPANY.get(env.COMPANY.idFromName(DO_NAMES.conformance)).runConformance());
    case "POST sweep":
      return json(await lobby(env).sweep());
    case "POST reset": {
      const slot = typeof parsed.slot === "string" ? parsed.slot : "";
      const r = await lobby(env).resetWorld({ slot });
      return "error" in r ? hostedError(r.error, r.message) : json(r);
    }
    case "GET ops": {
      const [l, s] = await Promise.all([lobby(env).ops(), env.SPEND.get(env.SPEND.idFromName(DO_NAMES.spend)).status({})]);
      const cfg = await envConfig(env);
      return json({ lobby: l, spend: s, config: Object.fromEntries(cfg), memo: showcaseMemo.size });
    }
    default:
      return plainError(404, "NotFound", "NOT_FOUND", "No such admin route");
  }
}
