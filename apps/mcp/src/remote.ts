// Remote MCP over Streamable HTTP (docs/cloudflare/design.md 3.3 and 6.3; track cf3-agent). The same server as stdio
// (server.ts) on the SDK's WebStandardStreamableHTTPServerTransport, stateless: every POST /mcp gets a fresh server and
// transport, answers with JSON (no SSE stream to hold a Durable Object open), and closes them. `fetchImpl` calls the
// slot's own Hono app in process, so a tool call never leaves the Durable Object. The mcp-scope key comes from the
// request (`Authorization: Bearer <key>` or `x-api-key`) and the API checks it on every call; the tools are read and
// propose only (NEVER_EXPOSED unchanged). agent_ask long-polls GET /v1/agent/runs/:id?wait=25, so a call makes at most
// 3 requests, and it is limited to MCP_AGENT_ASK_PER_KEY_DAY runs per key per UTC day. Portable: no node: imports.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { MCP_AGENT_ASK_PER_KEY_DAY, RUN_LONG_POLL_MAX_S, type RemoteMcpHandler } from "../../../packages/contracts/src/ext/cf-agent";
import { createMcpServer, type AskLimiter, type Fetch } from "./server";

/** agent_ask on the remote handler: the POST plus at most two long polls. */
export const REMOTE_ASK_MAX_REQUESTS = 3;

export interface RemoteMcpConfig {
  /** The origin the in-process fetch is given (the slot's Hono app reads only the path). */
  apiUrl?: string;
  /** Default: an in-memory counter per isolate. CompanyDO passes stateAskLimiter over its SmallState. */
  askLimiter?: AskLimiter | null;
  /** When set, a request whose Origin header is not listed gets 403 (requests without Origin are machine clients). */
  allowedOrigins?: readonly string[];
  /** POST body cap (default 256 KiB). */
  maxBodyBytes?: number;
  /** The tool listing is the registry's (code), the same for every mcp key: it is memoized per key for this long
   * (default 60 s), so a client's repeated tools/list skips the in-process API call (design 8.1). 0 turns it off. */
  listCacheMs?: number;
  now?: () => number;
}

/** The mcp-scope key a request carries, or null. */
export function mcpKeyOf(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
  const key = m?.[1] ?? (req.headers.get("x-api-key") ?? "").trim();
  return key ? key : null;
}

const jsonRpcError = (status: number, code: number, message: string, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), { status, headers: { "content-type": "application/json", ...headers } });

const LISTING = "/v1/tools?surface=mcp";

export function createRemoteMcpHandler(cfg: RemoteMcpConfig, fetchImpl: Fetch): RemoteMcpHandler {
  const apiUrl = cfg.apiUrl ?? "http://weft.internal";
  const askLimiter = cfg.askLimiter === undefined ? memoryAskLimiter(MCP_AGENT_ASK_PER_KEY_DAY) : cfg.askLimiter;
  const listCacheMs = cfg.listCacheMs ?? 60_000;
  const now = cfg.now ?? Date.now;
  const listings = new Map<string, { at: number; body: string }>();
  /** The in-process fetch, with the tool listing memoized per key (only a 200 listing is kept). */
  const fetchFor = (key: string): Fetch => async (url, init) => {
    const u = new URL(url);
    if (listCacheMs <= 0 || (init?.method ?? "GET") !== "GET" || `${u.pathname}${u.search}` !== LISTING) return fetchImpl(url, init);
    const tag = await keyTag(key);
    const hit = listings.get(tag);
    if (hit && now() - hit.at < listCacheMs) return new Response(hit.body, { status: 200, headers: { "content-type": "application/json" } });
    const res = await fetchImpl(url, init);
    if (res.status !== 200) return res;
    const body = await res.text();
    if (listings.size >= 256) listings.clear();
    listings.set(tag, { at: now(), body });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  return async (req) => {
    if (req.method !== "POST") {
      // Stateless: no standalone SSE stream (GET) and no session to end (DELETE).
      return jsonRpcError(405, -32000, `${req.method} is not supported: POST JSON-RPC messages to this endpoint`, { allow: "POST" });
    }
    const origin = req.headers.get("origin");
    if (origin && cfg.allowedOrigins && !cfg.allowedOrigins.includes(origin)) return jsonRpcError(403, -32000, "Origin not allowed");
    const key = mcpKeyOf(req);
    if (!key) return jsonRpcError(401, -32001, "An mcp-scope key is required: send Authorization: Bearer <key> or x-api-key", { "www-authenticate": "Bearer" });
    const server = createMcpServer({ apiUrl, apiKey: key }, fetchFor(key), {
      agentAsk: { kind: "long_poll", waitS: RUN_LONG_POLL_MAX_S, maxRequests: REMOTE_ASK_MAX_REQUESTS },
      askLimiter,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: cfg.maxBodyBytes ?? 256 * 1024 });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      await server.close().catch(() => undefined);
    }
  };
}

// agent_ask limits ------------------------------------------------------------------------------------------------

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** A short, stable name for a key (SHA-256, 16 hex): counters never hold the key itself. */
export async function keyTag(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Per isolate, in memory: counts reset with the isolate, so a durable limiter is stateAskLimiter. */
export function memoryAskLimiter(limit = MCP_AGENT_ASK_PER_KEY_DAY, now: () => Date = () => new Date()): AskLimiter {
  const counts = new Map<string, number>();
  return {
    async take(apiKey) {
      const day = utcDay(now());
      const k = `${await keyTag(apiKey)}:${day}`;
      for (const old of counts.keys()) if (!old.endsWith(`:${day}`)) counts.delete(old);
      const n = counts.get(k) ?? 0;
      if (n >= limit) return { ok: false, limit };
      counts.set(k, n + 1);
      return { ok: true };
    },
  };
}

/** Small synchronous state (the slot's `kv_state`, cf-platform.ts SmallState), typed structurally. */
export interface AskState { get(key: string): string | null; set(key: string, value: string): void; delete?(key: string): void }

/** Counts in the world's small state (`mcp.ask.<key tag>.<day>`): they survive an eviction and go with a reset. */
export function stateAskLimiter(state: AskState, limit = MCP_AGENT_ASK_PER_KEY_DAY, now: () => Date = () => new Date()): AskLimiter {
  return {
    async take(apiKey) {
      const k = `mcp.ask.${await keyTag(apiKey)}.${utcDay(now())}`;
      const n = Number(state.get(k) ?? "0") || 0;
      if (n >= limit) return { ok: false, limit };
      state.set(k, String(n + 1));
      return { ok: true };
    },
  };
}
