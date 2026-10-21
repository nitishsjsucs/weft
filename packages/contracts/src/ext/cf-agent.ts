// Weft on Cloudflare, round 0 contract (track cf0-contracts; docs/cloudflare/design.md 3.3, 4.3, 5 and 6.3).
// Additive only. The hosted model path and spend enforcement behind the existing agent contracts: the RunHost port,
// the SpendDO ledger with its hosted caps, the `workers_ai` provider id, the AI Gateway transport settings, the
// per-invocation fetch counter and the remote MCP handler. Implemented by cf3-agent (packages/agent, apps/mcp) and
// served by cf4-worker (SpendDO, the CompanyDO alarm). Types, constants and pure helpers only.
import type { ModelProvider, ProviderId } from "../provider";
import type { SpendLedger } from "../spend";

// Providers -----------------------------------------------------------------------------------------------------

/** The Workers AI switch (design 5.2). An ext addition: the frozen ProviderId union gains it at integration. */
export const WORKERS_AI_PROVIDER_ID = "workers_ai" as const;
export type HostedProviderId = ProviderId | typeof WORKERS_AI_PROVIDER_ID;
/** A provider whose id may be `workers_ai`; everything else is the frozen ModelProvider. */
export type HostedModelProvider = Omit<ModelProvider, "id"> & { id: HostedProviderId };

export const WORKERS_AI_MODEL = "@cf/openai/gpt-oss-120b";
export const WORKERS_AI_LABEL = "Workers AI gpt-oss-120b";
/** Neurons per million tokens for WORKERS_AI_MODEL (research: Workers AI pricing). */
export const WORKERS_AI_NEURONS_PER_M = { input: 31_818, output: 68_182 } as const;
/** USD per 1,000 neurons past the free allocation; the ledger prices Workers AI runs in these USD equivalents. */
export const USD_PER_1K_NEURONS = 0.011;

/** The `env.AI` binding as the provider calls it (non-streaming; Weft does not stream), typed structurally. */
export interface WorkersAiBindingLike {
  run(model: string, inputs: Record<string, unknown>, options?: { gateway?: { id: string; metadata?: Record<string, string | number | boolean | null> } }): Promise<unknown>;
}

// AI Gateway ----------------------------------------------------------------------------------------------------

/** Worker env names the gateway transport reads. The gateway name is a secret while the gateway is unauthenticated. */
export const AIG_ENV = { accountId: "WEFT_AIG_ACCOUNT_ID", gateway: "WEFT_AIG_GATEWAY", token: "CF_AIG_TOKEN" } as const;
export const AIG_HEADERS = { metadata: "cf-aig-metadata", authorization: "cf-aig-authorization", cacheStatus: "cf-aig-cache-status" } as const;
/** The value of `cf-aig-cache-status` on a cache hit; the provider settles that call at $0. */
export const AIG_CACHE_HIT = "HIT";
export type AigCallKind = "chat" | "routine" | "draft" | "embed" | "ocr" | "dictation" | "smoke";
/** `cf-aig-metadata`: at most 5 keys. */
export interface AigMetadata { slot: string; gen: number; run: string | null; kind: AigCallKind; visitor: string | null }
export interface AiGatewayConfig { accountId: string; gateway: string; token?: string | null }
/** The OpenAI base URL through the gateway. Only the URL and headers differ from a direct request (design 5.1). */
export function aiGatewayOpenAiBaseUrl(cfg: Pick<AiGatewayConfig, "accountId" | "gateway">): string {
  return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(cfg.accountId)}/${encodeURIComponent(cfg.gateway)}/openai`;
}

// Hosted spend --------------------------------------------------------------------------------------------------

/** Every cap SpendDO enforces (design 6.3). The first three are the frozen SpendLedger caps. */
export type HostedCap = "run" | "day" | "live" | "visitor" | "ip" | "neurons";
type FrozenCap = "run" | "day" | "live";
/** The frozen cap a hosted refusal reports in `cap`: the visitor, IP-hash and neuron caps are daily caps. */
export const FROZEN_CAP: Record<HostedCap, FrozenCap> = { run: "run", day: "day", live: "live", visitor: "day", ip: "day", neurons: "day" };

/**
 * Hosted caps in USD (neurons for `neuronsDay`). Read from KV `weft-config` (cf-hosted HOSTED_CONFIG_KEYS), so they
 * change without a redeploy; these are the defaults Nitish chose on 2026-10-20 (design section 0).
 */
export interface HostedCaps {
  runUsd: number;
  dayUsd: number;
  /** Cumulative live cap; null is off (the hosted default: no lifetime or monthly ceiling). */
  liveUsd: number | null;
  /** Per visitor and per daily-salted IP hash per UTC day; each equals the day cap unless set on its own. */
  visitorDayUsd: number;
  ipDayUsd: number;
  neuronsDay: number;
}
export const HOSTED_CAP_DEFAULTS: HostedCaps = { runUsd: 0.1, dayUsd: 2, liveUsd: null, visitorDayUsd: 2, ipDayUsd: 2, neuronsDay: 5000 };

/** Workers AI neurons Weft may use per UTC day, by product: 5,000 of the account's 10,000 (design 5.2). */
export type NeuronProduct = "agent" | "ocr" | "embeddings" | "dictation";
export const NEURON_SHARES: Record<NeuronProduct, number> = { agent: 4000, ocr: 500, embeddings: 200, dictation: 300 };

/** A run's reservation as the agent loop makes it, plus who it is charged to. Background runs carry the lease's visitor and IP hash. */
export interface HostedReserveInput {
  runId: string | null;
  usdMicros: number;
  model: string;
  live: boolean;
  runCapScale?: number;
  /** "slot-N:gen-G", the run cap key together with the run id. */
  world?: string | null;
  visitor?: string | null;
  ipHash?: string | null;
  /** Workers AI only: the neurons this attempt may use, against the neuron day cap and the product's share. */
  neurons?: number;
  product?: NeuronProduct;
}
export interface HostedReserveRefusal {
  ok: false;
  code: "BUDGET_EXCEEDED";
  /** The frozen cap (FROZEN_CAP of hostedCap), so the agent loop's existing handling applies unchanged. */
  cap: FrozenCap;
  hostedCap: HostedCap;
  spentMicros: number;
  capMicros: number;
}
export interface HostedSpendScope { day?: string; runId?: string; live?: boolean; world?: string; visitor?: string; ipHash?: string }

/** Today's position for admission and the Platform page. Open reservations count as spent. */
export interface HostedSpendStatus {
  day: string;
  caps: HostedCaps;
  spentMicros: { day: number; visitor: number | null; ip: number | null; live: number };
  neurons: { used: number; byProduct: Record<NeuronProduct, number> };
  openReservations: number;
}

/**
 * SpendDO's ledger (`spend_entries` and `neuron_entries`, never reset). It runs the same fold, totals and cap code as
 * the file ledger (`spend-core.ts`). It extends the frozen SpendLedger, so an adapter bound to a world's visitor and
 * IP hash is what the agent runtime receives. Reservations are made outside executor transactions.
 */
export interface HostedSpendLedger extends SpendLedger {
  reserve(input: HostedReserveInput): Promise<{ ok: true; reservationId: string } | HostedReserveRefusal>;
  settle(reservationId: string, actualUsdMicros: number, actual?: { neurons?: number }): Promise<void>;
  spent(scope: HostedSpendScope): Promise<number>;
  status(scope: { visitor?: string | null; ipHash?: string | null }): Promise<HostedSpendStatus>;
  /** Settles reservations open longer than ORPHAN_SETTLE_MS at their reserved worst case; returns how many. */
  settleOrphans(now?: Date): Promise<number>;
}
/** A reservation from a run killed mid-step settles at its reserved amount after this long (design 6.3). */
export const ORPHAN_SETTLE_MS = 15 * 60_000;
/** Below this much left for the day or the visitor, a new run is created on the scripted provider (design 5.2). */
export const MIN_LIVE_HEADROOM_USD = 0.01;

// Runs ----------------------------------------------------------------------------------------------------------

/** One run job, as the runtime's queue hands it to the host. */
export interface RunHostJob {
  readonly runId: string;
  /** A live provider run; at most one starts per alarm invocation. */
  readonly live: boolean;
  start(): Promise<void>;
}

/**
 * Where a run job starts (design 3.3). Node (`immediate`) starts it at once, inside today's queue concurrency
 * (1 for openai, 8 for scripted). Durable (`alarm`) keeps a FIFO and arms the DO alarm; each alarm invocation
 * starts what it may (at most one live run, so its model calls get a fresh 50-fetch budget) and re-arms while
 * jobs remain. A job never survives the isolate: eviction is a process restart and the boot rule applies.
 */
export interface RunHost {
  readonly kind: "immediate" | "alarm";
  submit(job: RunHostJob): void;
  /** Run ids submitted and not yet started, in order. */
  pending(): string[];
  /** Starts what one invocation may and waits for those jobs; Node resolves at once with nothing started. */
  drain(): Promise<{ started: number; remaining: number }>;
}

/** Counts outbound fetches per invocation; tests assert an alarm stays at or under MAX_FETCHES_PER_ALARM. */
export interface FetchCounter {
  readonly count: number;
  wrap(f: typeof fetch): typeof fetch;
  reset(): void;
}
/** Workers Free allows 50 external subrequests per invocation; Weft keeps 10 in reserve. */
export const MAX_FETCHES_PER_ALARM = 40;
export const EXTERNAL_SUBREQUEST_LIMIT = 50;

/** `GET /v1/agent/runs/:id?wait=25`: the additive long poll `agent_ask` uses (at most 3 requests per call). */
export const RUN_LONG_POLL_MAX_S = 25;

// Remote MCP ----------------------------------------------------------------------------------------------------

/** `createRemoteMcpHandler(cfg, fetchImpl)` in apps/mcp: stateless Streamable HTTP, `fetchImpl` calling the slot's
 * own Hono app in process. Tools are read and propose only; NEVER_EXPOSED is unchanged. */
export type RemoteMcpHandler = (req: Request) => Promise<Response>;
/** `agent_ask` calls per hosted MCP key per UTC day, inside the visitor's caps. */
export const MCP_AGENT_ASK_PER_KEY_DAY = 5;
