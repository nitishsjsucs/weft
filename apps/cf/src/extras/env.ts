// weft-core's bindings as the extras see them (design 9.4: AI, IMAGES, BROWSER, MEMVEC, FILES, OPS, CONFIG, and the
// COMPANY, LOBBY and SPEND namespaces; HELP once the AI Search instance exists; METRICS once Analytics Engine is
// enabled), and the factories that turn them into the queue consumers' and HostedExtras' dependencies. A binding
// that is absent switches its extra off instead of failing the Worker. Track cf6-extras.
import {
  buildPlatformReadout, COMPARE_MEMO_MS, createFlagReader, createHelpSearch, createRunCatalog, d1JobLedger, gatewayOption, lobbyCounters, messageOf, neuronBudgetFromLedger,
  PLATFORM_MEMO_MS, puppeteerLauncher, selectMetricsSink,
  type AiSearchLike, type AnalyticsEngineLike, type D1Like, type ExtrasFlags, type ImagesLike, type KvLike, type PlatformReadout, type R2BucketLike, type RunCatalog, type VectorizeLike,
  type WorkersAiBindingLike,
} from "@weft/cf-extras";
import { DO_NAMES } from "../../../../packages/contracts/src/ext/cf-hosted";
import type { HostedExtrasDeps } from "./hosted";
import type { DurableNamespaceLike, LobbyExtrasRpc, SlotExtrasPort, SpendExtrasRpc } from "./ports";
import type { ExtrasJobDeps } from "./queues";

export interface ExtrasEnv {
  AI?: WorkersAiBindingLike;
  IMAGES?: ImagesLike;
  BROWSER?: unknown;
  MEMVEC?: VectorizeLike;
  HELP?: AiSearchLike;
  METRICS?: AnalyticsEngineLike;
  FILES: R2BucketLike;
  OPS: D1Like;
  CONFIG?: KvLike;
  COMPANY: DurableNamespaceLike<SlotExtrasPort>;
  LOBBY: DurableNamespaceLike<LobbyExtrasRpc>;
  SPEND: DurableNamespaceLike<SpendExtrasRpc>;
  WEFT_AIG_GATEWAY?: string;
  WEFT_SEMANTIC_RECALL?: string;
  /** Verifies the front's x-weft-ctx on forwarded /api/_hosted/* requests. */
  WEFT_CTX_SECRET?: string;
  /** Dictation's per-visitor rate limit, the same binding and key as the slot's agent runs (design 6.3). */
  RL_RUN?: { limit(input: { key: string }): Promise<{ success: boolean }> };
}
export interface ExecutionContextLike { waitUntil(p: Promise<unknown>): void }
export type ExtrasLog = (evt: Record<string, unknown>) => void;
/** One JSON line per event in Workers Logs; events carry codes and clipped messages, never bodies or visitor data. */
export const consoleLog: ExtrasLog = (evt) => console.log(JSON.stringify(evt));

const readers = new WeakMap<object, () => Promise<ExtrasFlags>>();
/** One memoized flag reader per KV binding (per isolate), so a busy isolate reads KV once a minute. */
export function flagsFor(env: Pick<ExtrasEnv, "CONFIG" | "WEFT_SEMANTIC_RECALL">): () => Promise<ExtrasFlags> {
  const key = (env.CONFIG ?? env) as object;
  let r = readers.get(key);
  if (!r) { r = createFlagReader(env.CONFIG ?? null, { WEFT_SEMANTIC_RECALL: env.WEFT_SEMANTIC_RECALL }); readers.set(key, r); }
  return r;
}

const catalogs = new WeakMap<object, RunCatalog>();
/** One run catalog per D1 binding (per isolate), so the model comparison's 60 s memo (COMPARE_MEMO_MS) serves every
 * GET /api/_hosted/models the isolate answers: the route is anonymous, and each read is D1 rows read. */
export function catalogFor(db: D1Like): RunCatalog {
  let c = catalogs.get(db);
  if (!c) { c = createRunCatalog(db, { memoMs: COMPARE_MEMO_MS }); catalogs.set(db, c); }
  return c;
}

/** The Platform readout per D1 binding (per isolate), reused PLATFORM_MEMO_MS: GET /api/_hosted/platform is anonymous,
 * and each fresh readout is a Lobby RPC (and a SpendDO one when the Lobby's level memo is cold) plus a D1 count. */
const platformMemos = new WeakMap<object, { at: number; value: Promise<PlatformReadout> }>();
export function memoizedPlatform(key: object, read: () => Promise<PlatformReadout>, now = Date.now()): Promise<PlatformReadout> {
  const m = platformMemos.get(key);
  if (m && now >= m.at && now - m.at < PLATFORM_MEMO_MS) return m.value;
  const value = read();
  platformMemos.set(key, { at: now, value });
  value.catch(() => { if (platformMemos.get(key)?.value === value) platformMemos.delete(key); });
  return value;
}

const lobby = (env: ExtrasEnv) => env.LOBBY.get(env.LOBBY.idFromName(DO_NAMES.lobby));
const spend = (env: ExtrasEnv) => env.SPEND.get(env.SPEND.idFromName(DO_NAMES.spend));

export function jobDepsFromEnv(env: ExtrasEnv, ctx: ExecutionContextLike, log: ExtrasLog = consoleLog): ExtrasJobDeps {
  return {
    ai: env.AI ?? null,
    images: env.IMAGES ?? null,
    vectors: env.MEMVEC ?? null,
    launch: env.BROWSER ? puppeteerLauncher(env.BROWSER) : null,
    files: env.FILES,
    ledger: d1JobLedger(env.OPS),
    counters: lobbyCounters(lobby(env)),
    neurons: neuronBudgetFromLedger(spend(env)),
    flags: flagsFor(env),
    slots: (slot) => env.COMPANY.get(env.COMPANY.idFromName(slot)),
    recordVectorIds: (slot, gen, ids) => lobby(env).extrasRecordVectors(slot, gen, ids),
    metrics: selectMetricsSink(env, { waitUntil: (p) => ctx.waitUntil(p), onError: (e) => log({ evt: "extras.metrics", outcome: "flush_failed", message: messageOf(e) }) }),
    gatewayFor: (meta) => gatewayOption(env as unknown as Record<string, unknown>, meta),
    log,
  };
}

export function hostedDepsFromEnv(env: ExtrasEnv, ctx: ExecutionContextLike, log: ExtrasLog = consoleLog): HostedExtrasDeps {
  const flags = flagsFor(env);
  const counters = lobbyCounters(lobby(env));
  return {
    help: createHelpSearch({ search: env.HELP ?? null, counters, enabled: async () => (await flags()).help, onError: (e) => log({ evt: "extras.help", outcome: "search_failed", message: messageOf(e) }) }),
    ai: env.AI ?? null,
    neurons: neuronBudgetFromLedger(spend(env)),
    dictationEnabled: async () => (await flags()).dictation,
    catalog: catalogFor(env.OPS),
    platform: () => memoizedPlatform(env.OPS as object, () => buildPlatformReadout({ lobby: () => lobby(env).extrasReadout(), spend: spend(env), ops: env.OPS, counters })),
    files: env.FILES,
    metrics: selectMetricsSink(env, { waitUntil: (p) => ctx.waitUntil(p), onError: (e) => log({ evt: "extras.metrics", outcome: "flush_failed", message: messageOf(e) }) }),
    gatewayFor: (meta) => gatewayOption(env as unknown as Record<string, unknown>, meta),
  };
}
