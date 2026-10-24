// Weft on Cloudflare, round 0 contract (track cf0-contracts; docs/cloudflare/design.md 3.4, 6 and section 0).
// Additive only. What the front Worker, the Durable Objects and the hosted web agree on: world names, the settings
// Nitish chose on 2026-10-20, the KV `weft-config` keys, the session and human-grant cookies, the trust headers and
// the HMAC'd `x-weft-ctx`, the WebSocket change feed, the hosted HTTP paths and bodies, and the hosted error codes.
// The session settings were changed on 2026-10-23 (HOSTED_SETTINGS).
// Implemented by cf4-worker (front, LobbyDO, CompanyDO) and used by cf5-web. Types, constants and pure helpers only:
// the front Worker imports this file and must stay near its 10 ms CPU budget, so nothing here builds a schema.
import type { ErrorTag } from "../errors";
import type { HostedProviderId } from "./cf-agent";

// Worlds --------------------------------------------------------------------------------------------------------

/** showcase: the read-only world unleased visitors see. slot: a leased pool world. smoke: the deployed smoke's
 * reserved world (scripted provider, never leased). conformance: the scratch object the deployed transaction
 * conformance run uses and wipes. */
export type WorldMode = "showcase" | "slot" | "smoke" | "conformance";
/** Durable Object names (`idFromName`). Pool slots are `slot-1` to `slot-<poolSize>`. */
export const DO_NAMES = { showcase: "showcase", smoke: "slot-smoke", conformance: "conformance", lobby: "lobby", spend: "spend" } as const;
export const slotName = (n: number): string => `slot-${n}`;
export interface HostedWorldRef { slot: string; gen: number; mode: WorldMode }
/** The world id the spend ledger keys runs by, kept in `kv_state('world.id')`: "slot-N:gen-G". The generation
 * increments on every reset, so run ids restart safely for the ledger. */
export const hostedWorldId = (w: { slot: string; gen: number }): string => `${w.slot}:gen-${w.gen}`;

/** The clock every hosted world starts frozen at: Mon 2026-10-26 08:30 PT. Time moves only through the Simulators
 * advance buttons (WEFT_CLOCK_RATE=0). */
export const HOSTED_CLOCK = { at: "2026-10-26T15:30:00.000Z", rate: 0 } as const;
/**
 * How far a hosted world's clock moves (design 6.3). One advance moves it at most `maxStepDays` (so "+1 hour",
 * "+1 day" and "next routine" work and one request cannot jump years, which writes and reads the rows of every cron
 * slot and queues a run for each), and never past `maxDaysFromStart` after HOSTED_CLOCK.at; past it the visitor
 * resets the workspace. A refusal is 400 CLOCK_LIMIT. Node worlds have no such bound.
 */
export const HOSTED_CLOCK_LIMITS = { maxStepDays: 7, maxDaysFromStart: 60 } as const;

// Settings ------------------------------------------------------------------------------------------------------

/**
 * The hosted settings from design section 0. Nitish chose them on 2026-10-20; on 2026-10-23 he chose the lease
 * times, the resets per lease and the leases per IP hash below, because only two people use the hosted app (Nitish
 * and his interviewer), so a session shows no limits. They override every other value in the design and tracks (the
 * 9.4 config sketch's WEFT_POOL_SIZE 4 and WEFT_LIVE_USD_CAP 0.50, 6.2's 15 and 60 minute leases and 3 leases per IP,
 * and the 2026-10-20 values: 30 minutes idle, 3 hours in all, 20 leases per IP hash a day, 3 resets per lease). The
 * guards on the shared account quotas stay as they were: Turnstile and the human grant, HOSTED_RATE_LIMITS, the spend
 * caps (HOSTED_CAP_DEFAULTS in cf-agent.ts), each generation's rows budget, the level 3 brake (RESETS_PAUSED and no
 * new leases), the showcase read cap and HOSTED_CLOCK_LIMITS.
 */
export const HOSTED_SETTINGS = {
  /** Pool slots besides the showcase and slot-smoke, so the whole pool seeds on the first UTC day. */
  poolSize: 2,
  /** A lease ends after 24 hours without activity (2026-10-23). */
  leaseIdleMinutes: 1440,
  /** No total cap in practice: 30 days (2026-10-23). It stays a number, so the cookie's `exp` and `leaseExpiresMs`
   * still name the lease. */
  leaseTotalMinutes: 43_200,
  /** High enough that two people never meet it (2026-10-23); it still refuses past its value. */
  leasesPerIpHashPerDay: 500,
  /** Resets ("Reset workspace data...") per lease, high enough that two people never meet it (2026-10-23). Every
   * reset is still refused at level 3 (RESETS_PAUSED), and each one starts a generation with its own rows budget. */
  resetsPerLease: 1_000,
  /** The human grant a mutation needs, refreshed by an invisible Turnstile run. */
  humanGrantMinutes: 10,
  /** AI Search Help queries per UTC day (a Lobby counter). */
  helpQueriesPerDay: 30,
  uploadMaxBytes: 1_500_000,
  uploadsPerVisitorPerDay: 5,
  /** In-isolate memo of KV `weft-config` reads. */
  configMemoMs: 60_000,
} as const;

/** Rate Limiting binding settings (coarse and per location, never the cap; design 6.3). RL_API fits the guided tour
 * (a peak of 158 /api requests in 60 s, measured on cf:dev) about four times over: two tabs, or two visitors behind
 * one address, never see a rate-limited banner. */
export const HOSTED_RATE_LIMITS = {
  RL_API: { limit: 600, period: 60 },
  RL_MUTATE: { limit: 30, period: 60 },
  RL_MCP: { limit: 60, period: 60 },
  RL_RUN: { limit: 6, period: 60 },
} as const;

/** KV `weft-config` keys. Every cap is read from here (absent means the default), memoized for configMemoMs. */
export const HOSTED_CONFIG_KEYS = {
  /** "false" pauses every model-calling admission: 503 AGENT_PAUSED. */
  agentEnabled: "agent.enabled",
  /** The global default provider: "openai" (default), "workers_ai" or "scripted". A per-world setting overrides it. */
  modelProvider: "model.provider",
  /** "on" turns semantic recall candidates on, after the live L1 to L4 gate. */
  recallSemantic: "recall.semantic",
  /** "false" asks AI Gateway not to collect logs, if the shared logs allowance runs short. */
  aigCollectLog: "aig.collect_log",
  snapshotVersion: "snapshot.version",
  capRunUsd: "caps.run_usd",
  capDayUsd: "caps.day_usd",
  /** "off" (the default) or a USD amount. */
  capLiveUsd: "caps.live_usd",
  capVisitorDayUsd: "caps.visitor_day_usd",
  capIpDayUsd: "caps.ip_day_usd",
  capNeuronsDay: "caps.neurons_day",
  /** Extras flags, each "on" or "off" (cf6-extras; everything off leaves every other suite byte-identical). */
  extrasOcr: "extras.ocr",
  extrasPdf: "extras.pdf",
  extrasHelp: "extras.help",
  extrasDictation: "extras.dictation",
} as const;

/** The per-world `settings` row the Simulators panel's model switch writes; it overrides `model.provider`. */
export const WORLD_MODEL_SETTING = "hosted.model_provider";

/**
 * The degradation ladder (design 6.5), computed by the Lobby from its daily counters against Weft's shares.
 * 0 normal; 1 at 70% of any share (poll intervals triple, refresh from the socket only); 2 the day dollar cap, the
 * neuron cap or the kill switch (new runs use the scripted provider, with a banner); 3 at 90% of DO rows written,
 * rows read or DO requests (no new leases, the showcase stays); 4 the account Workers request cap (static notice).
 */
export type DegradationLevel = 0 | 1 | 2 | 3 | 4;

// Cookies and trust headers -------------------------------------------------------------------------------------

/** HMAC over {visitor, slot, gen, exp, leaseExpiresMs}. HttpOnly, Secure, SameSite=Strict, Path=/. */
export const SESSION_COOKIE = "__Host-weft";
/** The human grant, HMAC over {visitor, exp}, set after a passed Turnstile check. Same attributes. */
export const HUMAN_GRANT_COOKIE = "__Host-weft-h";
/**
 * `exp` is when the cookie expires (unix seconds, the lease's total expiry). `leaseExpiresMs` is the lease's total
 * expiry to the millisecond (LeaseInfo.expiresAt): it names the lease the cookie was issued for, since a reset keeps
 * the lease's start and the visitor's next lease has another, so only a cookie of the same lease moves to the lease's
 * newer generation after a reset.
 */
export interface SessionClaims { visitor: string; slot: string; gen: number; exp: number; leaseExpiresMs: number }
export interface HumanGrantClaims { visitor: string; exp: number }

/** Headers the front Worker deletes from every client request, then sets itself. */
export const TRUST_HEADERS = { proxy: "x-weft-proxy", ctx: "x-weft-ctx", smoke: "x-weft-smoke" } as const;
/** `x-weft-ctx`: HMAC'd with WEFT_CTX_SECRET by the front, verified by the DO. The DO answers 409 LEASE_ENDED when
 * `gen` is older than the world's. `ipHash` uses a daily salt derived from WEFT_SESSION_SECRET; raw IPs are never kept. */
export interface WeftCtx { slot: string; gen: number; visitor: string | null; ipHash: string | null; human: boolean; smoke: boolean; iat: number }
/** GET responses list the tables they read (comma-separated, sorted); the web refetches queries whose tables a commit wrote. */
export const TABLES_HEADER = "x-weft-tables";
/** GET responses list the query parameter names their route read (sorted, comma-separated; "*" for all of them), so the
 * front's showcase memo keys a read by those parameters only and a parameter the route ignores cannot vary the key. */
export const QUERY_HEADER = "x-weft-query";
/** ETag on polled GETs: W/"<gen>.<hash(route, query, principal, versions of the tables it read)>". */
export const hostedEtag = (gen: number, hash: string): string => `W/"${gen}.${hash}"`;

// HTTP paths ----------------------------------------------------------------------------------------------------

/**
 * Hosted paths (everything else under /api/v1/* is the Node API, rewritten to /v1/*). `/api/*` and `/mcp` run the
 * front Worker first; pages are static assets with no Worker invocation.
 */
export const HOSTED_PATHS = {
  /** GET: SessionStatus. */
  session: "/api/_session",
  /** POST TurnstileTokenBody: LeaseResult; sets both cookies on "leased". */
  lease: "/api/_session/lease",
  /** POST TurnstileTokenBody: VerifyResult; refreshes the human grant. */
  verify: "/api/_session/verify",
  /** WebSocket upgrade: LiveMessage frames to the visitor's own slot; the client sends none. */
  live: "/api/_live",
  /** POST: the front intercepts it, resets through the Lobby (rich profile only) and reissues the cookie. */
  reset: "/api/v1/sim/reset",
  /** GET: PlatformReadout (cf-extras.ts). */
  platform: "/api/_hosted/platform",
  /** GET: ModelComparisonRow[] (cf-extras.ts). */
  models: "/api/_hosted/models",
  /** PUT ModelSwitchBody, forwarded to the visitor's slot. */
  modelSwitch: "/api/_hosted/model",
  /** GET ?q=: HelpSearchResult (cf-extras.ts). */
  help: "/api/_hosted/help",
  /** POST audio (at most 30 s): DictationResult (cf-extras.ts). */
  dictate: "/api/_hosted/dictate",
  /** GET /api/_hosted/pdf/<PdfKind>/<subject id>: a PDF, served from R2 once rendered. */
  pdf: "/api/_hosted/pdf",
  /** POST: McpKeyMint, the lease's MCP key, shown once. */
  mcpKey: "/api/_hosted/mcp-key",
  /** HMAC with WEFT_ADMIN_TOKEN and a 5-minute timestamp: provision, conformance, ops, seed-index (SeedIndexProgress). */
  admin: "/api/_admin",
  mcp: "/mcp",
} as const;

/**
 * POST /api/_admin/seed-index (design 5.4): one metered step of the seed memory index. The showcase embeds the
 * snapshot's memory notes into `seed-<snapshot>` from `from` until SpendDO's embeddings share refuses a batch; the
 * Lobby keeps `nextChunk` per snapshot, so the operator calls it once a day until `done`. Semantic recall (KV
 * recall.semantic) stays off until then.
 */
export interface SeedIndexProgress {
  snapshot: string;
  namespace: string;
  notes: number;
  chunks: number;
  /** The chunk this step started from. */
  from: number;
  /** The first chunk not indexed yet, or null once every chunk is. */
  nextChunk: number | null;
  done: boolean;
  /** When this step ran (ISO); a step on a complete index runs nothing and keeps the time of the last one. */
  at: string;
  /** False when the index was already complete (or another step was running) and nothing ran. */
  ran: boolean;
}

export interface TurnstileTokenBody { token: string }
export interface LeaseInfo { slot: string; gen: number; expiresAt: string; idleExpiresAt: string; resetsLeft: number }
export type LeaseResult =
  | ({ status: "leased" } & LeaseInfo)
  /** "All N workspaces are in use. One frees in about M min." */
  | { status: "waitlist"; position: number; poolSize: number; etaMinutes: number | null }
  /** Every workspace is in use and the waitlist is full (the Lobby's cap on live entries): no place in line. */
  | { status: "full"; poolSize: number; etaMinutes: number | null }
  /** "Today's budget is used up; back after 00:00 UTC." */
  | { status: "budget"; reopensAt: string }
  | { status: "ip_limit"; reopensAt: string }
  /** Degradation level 3 or more: no new leases. */
  | { status: "closed"; level: DegradationLevel };
export interface VerifyResult { ok: true; grantExpiresAt: string }
export interface SessionStatus {
  world: "showcase" | "slot";
  lease: LeaseInfo | null;
  grantExpiresAt: string | null;
  level: DegradationLevel;
  pool: { size: number; free: number; waitlist: number };
  /** The provider new runs in this world use, and why when it is the scripted fallback. */
  provider: { id: HostedProviderId; reason: "default" | "world" | "budget" | "neurons" | "paused" };
  agentEnabled: boolean;
}
export interface HostedResetResult { ok: true; gen: number; resetsLeft: number }
export interface ModelSwitchBody { provider: HostedProviderId | null }
export interface McpKeyMint { key: string; url: string; expiresAt: string }

/** A world's rows budget as GET /api/v1/health reports it (design 6.3): this generation's (a leased slot) or this UTC
 * day's (the showcase) rows against the limits; a null limit is not enforced there. */
export interface HostedBudgetReadout { rowsWritten: number; rowsRead: number; events: number; limits: { rowsWritten: number | null; rowsRead: number } }
/** GET /api/v1/health on hosted adds these fields (additive). */
export interface HostedHealthFields { runtime: "node" | "cloudflare"; world?: HostedWorldRef; budget?: HostedBudgetReadout }

// WebSocket feed ------------------------------------------------------------------------------------------------

/** Frames on /api/_live. A commit frame follows every commit that wrote a table; the lease frame tells the tab its
 * lease ended or its world was reset (the cookie generation is now old). */
export type LiveMessage =
  | { type: "commit"; seq: number; tables: string[] }
  | { type: "lease"; state: "ended" | "reset"; gen: number };
/** With the socket connected, polling drops to this safety net. */
export const LIVE_POLL_FALLBACK_MS = 60_000;
/** The client's keepalive text frame on /api/_live and the slot's answer. CompanyDO answers it with the hibernation
 * auto-response (setWebSocketAutoResponse), so a ping never wakes the object; neither is a LiveMessage. */
export const LIVE_PING = "ping";
export const LIVE_PONG = "pong";

// Errors --------------------------------------------------------------------------------------------------------

/** Hosted gate errors. The body is the usual `{ _tag, message, code }`; the HTTP status is `status` here, which for
 * 428 and 503 is not ERROR_STATUS[_tag]. */
export const HOSTED_ERRORS = {
  LEASE_REQUIRED: { status: 409, tag: "Conflict" },
  LEASE_ENDED: { status: 409, tag: "Conflict" },
  SESSION_INVALID: { status: 401, tag: "Unauthorized" },
  ORIGIN_REFUSED: { status: 403, tag: "Forbidden" },
  TURNSTILE_REQUIRED: { status: 428, tag: "Forbidden" },
  TURNSTILE_FAILED: { status: 403, tag: "Forbidden" },
  RATE_LIMITED: { status: 429, tag: "RateLimitExceeded" },
  RESET_LIMIT: { status: 429, tag: "RateLimitExceeded" },
  UPLOAD_LIMIT: { status: 413, tag: "Refused" },
  HOSTED_RESET_PROFILE: { status: 400, tag: "ValidationError" },
  WORLD_READ_ONLY: { status: 409, tag: "Conflict" },
  AGENT_PAUSED: { status: 503, tag: "Refused" },
  /** A hosted clock advance past HOSTED_CLOCK_LIMITS. */
  CLOCK_LIMIT: { status: 400, tag: "ValidationError" },
  /** This workspace used its rows budget for this generation (design 6.3): reset it, or come back later. */
  DEMO_LIMIT: { status: 429, tag: "RateLimitExceeded" },
  /** The shared showcase read its rows for the UTC day (design 6.3); leased workspaces and the static pages work. */
  SHOWCASE_LIMIT: { status: 503, tag: "Refused" },
  /** Past level 3 of the day's share no reset starts (a reset would refill a generation's rows budget); the lease goes on. */
  RESETS_PAUSED: { status: 503, tag: "Refused" },
} as const satisfies Record<string, { status: number; tag: ErrorTag }>;
export type HostedErrorCode = keyof typeof HOSTED_ERRORS;
export interface HostedErrorBody { _tag: ErrorTag; code: HostedErrorCode; message: string; retryAfterS?: number }

// MCP keys ------------------------------------------------------------------------------------------------------

/** Hosted MCP keys route by prefix, never by URL: wk_mcp_<slot>_<gen>_<rand>. A key dies with its lease generation. */
export const HOSTED_MCP_KEY_PREFIX = "wk_mcp_";
export function formatHostedMcpKey(slot: string, gen: number, rand: string): string {
  return `${HOSTED_MCP_KEY_PREFIX}${slot}_${gen}_${rand}`;
}
export function parseHostedMcpKey(key: string): { slot: string; gen: number } | null {
  const m = /^wk_mcp_([a-z0-9-]{1,32})_(\d{1,9})_[A-Za-z0-9]{16,128}$/.exec(key);
  return m ? { slot: m[1]!, gen: Number(m[2]) } : null;
}
