// weft (the front Worker, design 3.1 and 3.4): workers_dev true at weft.nitish-ratakonda.workers.dev. Pages are static
// assets with no Worker invocation; this runs first only for /api/* and /mcp (run_worker_first). It never imports
// @weft/*, so its cold start and per-request CPU stay a few milliseconds: HMAC checks, the Rate Limiting binding,
// routing by the signed cookie or the MCP key prefix, the showcase memo, and one siteverify on the session routes.
import {
  DO_NAMES, HOSTED_CONFIG_KEYS, HOSTED_PATHS, HOSTED_SETTINGS, parseHostedMcpKey,
  type HostedResetResult,
} from "../shared/contracts";
import { agentEnabled, envConfig } from "../shared/config";
import { isPoolSlot, type FrontEnv } from "../shared/env";
import { ADMIN_MAX_BODY_BYTES, hostedError, isMutation, json, plainError, readJson, readTextCapped } from "../shared/http";
import { logError } from "../shared/log";
import { DO_PATHS, HEALTH_PATH, isModelAdmission, isUpload, SIM_RESET_PATH } from "../shared/routes";
import { ADMIN_HEADER, mcpKeyId, signCtx, verifyAdmin } from "../shared/tokens";
import { serveAssets } from "./assets";
import { forwardToWorld, stripTrust } from "./forward";
import { HEALTH_MEMO_MS, readNames, ResponseMemo, type NormalizedRead } from "./memo";
import { operatorGrant, operatorLease, operatorRelease } from "./operator";
import { sessionStatus, startLease, verifyHuman } from "./session";
import { clearSessionCookies, FrontConfigError, resolveVisit, secrets, sessionCookies, targetOf, withCookies, type Visit } from "./visit";

/** In-isolate memo of showcase GET responses (design 4.5). */
export const showcaseMemo = new ResponseMemo();

const lobby = (env: FrontEnv) => env.LOBBY.get(env.LOBBY.idFromName(DO_NAMES.lobby));
const UPLOAD_OVERHEAD = 64 * 1024;
/** GET /api/_hosted/export/<memory|world>/<job id> (cf6-extras), and the dictation body cap (30 s of 16 kHz PCM WAV). */
const HOSTED_EXPORT_PREFIX = "/api/_hosted/export/";
const DICTATE_MAX_BYTES = 1024 * 1024;

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
      // A valid smoke visit (x-weft-smoke HMAC) is the deploy's own check and skips RL_API; an unsigned burst does not.
      if (!visit.smoke && await rateLimited(env.RL_API, `api:${visit.ipHash}`)) return hostedError("RATE_LIMITED", "Too many requests; slow down a little", { retryAfterS: 60 });

      if (path === HOSTED_PATHS.session && req.method === "GET") return await sessionStatus(env, visit);
      if (path === HOSTED_PATHS.lease || path === HOSTED_PATHS.verify) {
        if (req.method !== "POST") return plainError(405, "ValidationError", "METHOD", "POST a Turnstile token");
        if (!originAllowed(req, env)) return hostedError("ORIGIN_REFUSED", "Cross-origin requests are refused");
        if (await rateLimited(env.RL_MUTATE, `mut:${visit.ipHash}`)) return hostedError("RATE_LIMITED", "Too many requests; slow down a little", { retryAfterS: 60 });
        return path === HOSTED_PATHS.lease ? await startLease(req, env, visit) : await verifyHuman(req, env, visit);
      }
      if (path === HOSTED_PATHS.live) return await live(req, env, visit);
      if (path === HOSTED_PATHS.admin || path.startsWith(`${HOSTED_PATHS.admin}/`)) return await admin(req, env, url, visit);
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

/** RL_MUTATE's key for valid smoke visits (slot-smoke only, never a visitor's world). */
const SMOKE_MUTATE_KEY = "mut:smoke";

/** The gates every mutation passes (design 6.3): same origin, a lease, a fresh human grant, RL_MUTATE. */
async function mutationGate(req: Request, env: FrontEnv, v: Visit): Promise<Response | null> {
  // A GET gated like a mutation (a PDF) sends no Origin; the SameSite=Strict cookies already keep it same-site.
  if (!v.smoke && isMutation(req.method) && !originAllowed(req, env)) return hostedError("ORIGIN_REFUSED", "Cross-origin requests are refused");
  if (!v.smoke && !v.session) return hostedError("LEASE_REQUIRED", "The shared demo company is read-only; start your own demo company to make changes");
  if (!v.smoke && !v.grant) return hostedError("TURNSTILE_REQUIRED", "Confirm you are human to keep making changes");
  // A valid smoke visit (the deploy's own checks, signed with WEFT_SMOKE_TOKEN) has its own key, so automated checks
  // from the operator's address never spend that address's visitor budget; a forged or unsigned one is a visitor.
  if (await rateLimited(env.RL_MUTATE, v.smoke ? SMOKE_MUTATE_KEY : `mut:${v.ipHash}`)) return hostedError("RATE_LIMITED", "Too many changes in a minute; slow down a little", { retryAfterS: 60 });
  return null;
}

function ctxOf(v: Visit, slot: string, gen: number) {
  return { slot, gen, visitor: v.smoke ? null : v.session?.visitor ?? null, ipHash: v.ipHash, human: v.smoke || v.grant, smoke: v.smoke };
}

/** The world a visit's request goes to, its signed context, and the session cookie's lease (forward.ts). */
function worldOf(v: Visit, t: { slot: string; gen: number }) {
  return { slot: t.slot, ctx: ctxOf(v, t.slot, t.gen), leaseExpiresMs: v.smoke ? null : v.session?.leaseExpiresMs ?? null };
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
    return forwardToWorld(req, env, { ...worldOf(v, t), path: apiPath, search: url.search });
  }
  // Reads. The showcase is immutable per snapshot: memoized in the isolate, HEAD and health included.
  if (!t.leased && (req.method === "GET" || req.method === "HEAD")) return showcaseRead(req, env, url, v, t, apiPath);
  return forwardToWorld(req, env, { ...worldOf(v, t), path: apiPath, search: url.search });
}

/** A HEAD answer: the GET's status and headers without its body. */
const forMethod = (req: Request, res: Response): Response => (req.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res);

/**
 * An unleased GET or HEAD (design 4.5): answered from the showcase memo, else the showcase is asked the normalized
 * read the key names (memo.ts) as a GET, so nothing a client adds can vary the key: not an unknown parameter, not a
 * known one the route does not read (learned from the world's x-weft-query), not the method. Misses are capped per
 * path family per window, so free values cannot make the showcase read without end. GET /api/v1/health is reused for
 * HEALTH_MEMO_MS, so a showcase tab's health poll reaches no Durable Object while the answer is fresh.
 */
async function showcaseRead(req: Request, env: FrontEnv, url: URL, v: Visit, t: ReturnType<typeof targetOf>, apiPath: string): Promise<Response> {
  const cfg = await envConfig(env);
  const base = { path: apiPath, search: url.search, principal: req.headers.get("x-weft-principal"), snapshot: cfg.get(HOSTED_CONFIG_KEYS.snapshotVersion) ?? "none" };
  const maxAge = apiPath === HEALTH_PATH ? HEALTH_MEMO_MS : undefined;
  let read = ResponseMemo.normalize({ ...base, reads: showcaseMemo.readsFor(apiPath) });
  const hit = showcaseMemo.get(read.key, maxAge);
  if (hit) return forMethod(req, hit);
  if (!showcaseMemo.admitMiss(apiPath, read)) {
    return hostedError("RATE_LIMITED", "The shared demo company is answering many different requests right now; try again in a minute, or start your own demo company", { retryAfterS: 60 });
  }
  const ask = (r: NormalizedRead) => {
    const headers = new Headers(req.headers);
    if (r.principal) headers.set("x-weft-principal", r.principal);
    else headers.delete("x-weft-principal");
    return forwardToWorld(new Request(req.url, { method: "GET", headers }), env, { ...worldOf(v, t), path: apiPath, search: r.search });
  };
  let res = await ask(read);
  let names = readNames(res);
  // The route read a parameter the learned set had left out (it reads it only for some values of another): ask again
  // with every known parameter, so the answer is the one this request asked for.
  if (read.dropped.length && (names === null || read.dropped.some((d) => names!.has(d)))) {
    await res.body?.cancel();
    read = ResponseMemo.normalize({ ...base, reads: null });
    res = await ask(read);
    names = readNames(res);
  }
  if (res.status !== 200) return forMethod(req, res);
  // Kept under the key of everything this route is known to read, which this request and the asked one agree on.
  const learned = showcaseMemo.learn(apiPath, names);
  return forMethod(req, await showcaseMemo.put(ResponseMemo.normalize({ ...base, reads: learned }).key, res));
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
  return forwardToWorld(req, env, { ...worldOf(v, t), path: DO_PATHS.live, search: "" });
}

async function hosted(req: Request, env: FrontEnv, url: URL, v: Visit): Promise<Response> {
  const path = url.pathname;
  const t = targetOf(v);
  if (path === HOSTED_PATHS.modelSwitch || path === HOSTED_PATHS.mcpKey) {
    const refused = await mutationGate(req, env, v);
    if (refused) return refused;
    const inner = path === HOSTED_PATHS.modelSwitch ? DO_PATHS.model : DO_PATHS.mcpKey;
    return forwardToWorld(req, env, { ...worldOf(v, t), path: inner, search: "" });
  }
  const gated = path === HOSTED_PATHS.dictate || path.startsWith(`${HOSTED_PATHS.pdf}/`);
  if (gated || isMutation(req.method)) {
    const refused = await mutationGate(req, env, v);
    if (refused) return refused;
  }
  // A PDF is the visitor's world's own document (design 6.3): gated like a mutation above, then answered by the
  // visitor's slot (cf6-extras: CompanyDO runs handleHostedPdf over the world's own read routes on /_hosted/pdf/...).
  if (path.startsWith(`${HOSTED_PATHS.pdf}/`)) {
    if (req.method !== "GET") return plainError(405, "ValidationError", "METHOD", "GET a PDF");
    return forwardToWorld(req, env, { ...worldOf(v, t), path: `${DO_PATHS.pdf}${path.slice(HOSTED_PATHS.pdf.length)}`, search: "" });
  }
  // Exports belong to a leased world (the job id names its slot's file).
  if (path.startsWith(HOSTED_EXPORT_PREFIX) && !t.leased && !v.smoke) return hostedError("LEASE_REQUIRED", "Exports belong to your own demo company");
  if (![HOSTED_PATHS.platform, HOSTED_PATHS.models, HOSTED_PATHS.help, HOSTED_PATHS.dictate].includes(path as never) && !path.startsWith(HOSTED_EXPORT_PREFIX)) {
    return plainError(404, "NotFound", "NOT_FOUND", "No such hosted route");
  }
  if (path === HOSTED_PATHS.dictate) {
    const len = Number(req.headers.get("content-length") ?? "NaN");
    if (!Number.isFinite(len)) return plainError(411, "ValidationError", "LENGTH_REQUIRED", "Dictation needs a Content-Length");
    if (len > DICTATE_MAX_BYTES) return plainError(413, "ValidationError", "DICTATION_TOO_LONG", "Dictation clips are at most 30 seconds");
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

/**
 * /mcp (design 6.3 and 6.4): routed by the key prefix wk_mcp_<slot>_<gen>_<rand>, never by the URL. Only a real pool
 * slot is routed (a key naming slot-99 or anything else would otherwise create a Durable Object), and RL_MCP is
 * asked per IP hash before it is asked per key, so random well-formed keys from one address are limited like one.
 */
async function mcp(req: Request, env: FrontEnv, url: URL): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  const key = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? req.headers.get("x-api-key") ?? "";
  const parsed = key ? parseHostedMcpKey(key) : null;
  if (!parsed || !isPoolSlot(env, parsed.slot)) return plainError(401, "Unauthorized", "MCP_KEY_REQUIRED", "Use the MCP key from your demo company (Bearer wk_mcp_...)");
  const v = await resolveVisit(req, env);
  if (await rateLimited(env.RL_MCP, `mcp-ip:${v.ipHash}`)) return hostedError("RATE_LIMITED", "Too many MCP requests in a minute", { retryAfterS: 60 });
  if (await rateLimited(env.RL_MCP, `mcp:${await mcpKeyId(key)}`)) return hostedError("RATE_LIMITED", "Too many MCP requests in a minute", { retryAfterS: 60 });
  return forwardToWorld(req, env, {
    slot: parsed.slot, ctx: { slot: parsed.slot, gen: parsed.gen, visitor: null, ipHash: v.ipHash, human: false, smoke: false },
    path: DO_PATHS.mcp, search: url.search,
  });
}

/** /api/_admin/* (design 6.2, 9.2 and 10): HMAC with WEFT_ADMIN_TOKEN over method, path, timestamp and body. */
async function admin(req: Request, env: FrontEnv, url: URL, v: Visit): Promise<Response> {
  // Refused from the Content-Length before reading, or as soon as a chunked body passes the cap.
  const body = req.method === "GET" || req.method === "HEAD" ? "" : await readTextCapped(req, ADMIN_MAX_BODY_BYTES);
  if (body === null) return plainError(413, "ValidationError", "TOO_LARGE", "Admin bodies are small");
  const check = await verifyAdmin({ token: env.WEFT_ADMIN_TOKEN, header: req.headers.get(ADMIN_HEADER), method: req.method, path: url.pathname, body });
  if (!check.ok) return plainError(401, "Unauthorized", "ADMIN_SIGNATURE", "A valid admin signature is required");
  // Each signature is good for one request: a captured one cannot be replayed within its window. The counter is
  // keyed by the signature's own UTC day, so a replay across midnight finds it too.
  const fresh = await lobby(env).take({ key: `admin_sig:${check.id}`, limit: 1, now: check.ts * 1000 });
  if (!fresh.ok) return plainError(401, "Unauthorized", "ADMIN_SIGNATURE", "This admin signature was already used; sign each request");
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
    case "POST seed-index": {
      const r = await lobby(env).seedIndex();
      return "error" in r ? plainError(503, "NotImplemented", r.error, r.message) : json(r);
    }
    case "POST reset": {
      const slot = typeof parsed.slot === "string" ? parsed.slot : "";
      const r = await lobby(env).resetWorld({ slot });
      return "error" in r ? hostedError(r.error, r.message) : json(r);
    }
    case "POST lease":
      return operatorLease(env, v, parsed);
    case "POST grant":
      return operatorGrant(env, v, parsed);
    case "POST release":
      return operatorRelease(env, v, parsed);
    case "GET ops": {
      const [l, s] = await Promise.all([lobby(env).ops(), env.SPEND.get(env.SPEND.idFromName(DO_NAMES.spend)).status({})]);
      const cfg = await envConfig(env);
      return json({ lobby: l, spend: s, config: Object.fromEntries(cfg), memo: showcaseMemo.size });
    }
    default:
      return plainError(404, "NotFound", "NOT_FOUND", "No such admin route");
  }
}
