// Which provider a hosted run starts on (docs/cloudflare/design.md 5.2, 6.3 and 6.5). KV `model.provider` is the
// global default and the world's Simulators setting overrides it; the provider is chosen once at run creation and the
// run row pins it. A run is created on the scripted provider, with its honest badge and a reason the hosted banner
// shows, when the kill switch is on, when less than $0.01 is left for the day, the visitor or the IP hash, or when the
// neurons a Workers AI run needs are spent. slot-smoke forces scripted. Portable.
import type { ModelProvider } from "@weft/contracts";
import {
  MIN_LIVE_HEADROOM_USD, NEURON_SHARES, WORKERS_AI_PROVIDER_ID, type HostedProviderId, type HostedSpendStatus,
} from "../../../contracts/src/ext/cf-agent";
import { HOSTED_CONFIG_KEYS, HOSTED_SETTINGS, type SessionStatus } from "../../../contracts/src/ext/cf-hosted";
import type { PromptKind } from "../prompts/index";
import type { KvLike } from "../spend-hosted";
import { createProviderFor, ProviderError, type CreateProviderOptions, type ProviderPorts } from "./factory-core";

export type HostedProviderReason = SessionStatus["provider"]["reason"];
export interface HostedProviderChoice { id: HostedProviderId; reason: HostedProviderReason }

/** The providers a hosted world may pick; anything else in KV or the world setting is ignored. */
export const HOSTED_PROVIDER_IDS = ["openai", WORKERS_AI_PROVIDER_ID, "scripted"] as const satisfies readonly HostedProviderId[];
export function parseHostedProviderId(v: string | null | undefined): HostedProviderId | null {
  const t = (v ?? "").trim();
  return (HOSTED_PROVIDER_IDS as readonly string[]).includes(t) ? (t as HostedProviderId) : null;
}

/** Neurons a Workers AI run needs to start: about one worst-case attempt (8,000 output and 8,000 input tokens). */
export const MIN_NEURONS_FOR_RUN = 1_000;

export interface HostedChoiceInput {
  /** KV `agent.enabled` is not "false". */
  agentEnabled: boolean;
  /** KV `model.provider`. */
  configured: string | null;
  /** The world's `hosted.model_provider` setting (the Simulators model switch). */
  world: string | null;
  /** Providers this world can build (an OpenAI key, the AI binding). */
  available: ReadonlySet<HostedProviderId>;
  /** The lease's position in SpendDO; null when it could not be read (then no budget fallback is applied here: the
   * reservation still enforces every cap). */
  status: HostedSpendStatus | null;
  /** slot-smoke: always scripted. */
  forced?: HostedProviderId | null;
}

export function chooseHostedProvider(i: HostedChoiceInput): HostedProviderChoice {
  if (i.forced) return { id: i.forced, reason: "default" };
  if (!i.agentEnabled) return { id: "scripted", reason: "paused" };
  const fromWorld = parseHostedProviderId(i.world);
  const want = fromWorld ?? parseHostedProviderId(i.configured) ?? "openai";
  const reason: HostedProviderReason = fromWorld ? "world" : "default";
  if (want === "scripted" || !i.available.has(want)) return { id: "scripted", reason };
  const s = i.status;
  if (s) {
    const micros = MIN_LIVE_HEADROOM_USD * 1e6;
    const left = [s.caps.dayUsd * 1e6 - s.spentMicros.day];
    if (s.spentMicros.visitor !== null) left.push(s.caps.visitorDayUsd * 1e6 - s.spentMicros.visitor);
    if (s.spentMicros.ip !== null) left.push(s.caps.ipDayUsd * 1e6 - s.spentMicros.ip);
    if (s.caps.liveUsd !== null) left.push(s.caps.liveUsd * 1e6 - s.spentMicros.live);
    if (left.some((l) => l < micros)) return { id: "scripted", reason: "budget" };
    if (want === WORKERS_AI_PROVIDER_ID) {
      const neuronsLeft = Math.min(s.caps.neuronsDay - s.neurons.used, NEURON_SHARES.agent - s.neurons.byProduct.agent);
      if (neuronsLeft < MIN_NEURONS_FOR_RUN) return { id: "scripted", reason: "neurons" };
    }
  }
  return { id: want, reason };
}

export interface HostedModelConfig {
  agentEnabled: boolean;
  provider: string | null;
  /** KV `aig.collect_log`: false when it is "false", else null (no override). */
  collectLog: false | null;
}

/** KV `agent.enabled`, `model.provider` and `aig.collect_log`, memoized for HOSTED_SETTINGS.configMemoMs per isolate.
 * A KV error keeps the last values read (or the defaults: agent on, OpenAI, gateway logging as configured). */
export function kvModelConfig(kv: KvLike, opts: { memoMs?: number; now?: () => number } = {}): (() => Promise<HostedModelConfig>) & { last(): HostedModelConfig | null } {
  const memoMs = opts.memoMs ?? HOSTED_SETTINGS.configMemoMs;
  const now = opts.now ?? Date.now;
  let cached: { at: number; v: HostedModelConfig } | null = null;
  const read = async (): Promise<HostedModelConfig> => {
    if (cached && now() - cached.at < memoMs) return cached.v;
    try {
      const [enabled, provider, collect] = await Promise.all([kv.get(HOSTED_CONFIG_KEYS.agentEnabled), kv.get(HOSTED_CONFIG_KEYS.modelProvider), kv.get(HOSTED_CONFIG_KEYS.aigCollectLog)]);
      const off = (v: string | null) => (v ?? "").trim().toLowerCase() === "false";
      cached = { at: now(), v: { agentEnabled: !off(enabled), provider, collectLog: off(collect) ? false : null } };
    } catch {
      cached = { at: now(), v: cached?.v ?? { agentEnabled: true, provider: null, collectLog: null } };
    }
    return cached.v;
  };
  /** The values last read, synchronously (a transport's per-call collectLog reads this). */
  return Object.assign(read, { last: () => cached?.v ?? null });
}

export interface HostedSelectorInputs {
  /** KV agent.enabled and model.provider (kvModelConfig). */
  config: () => Promise<{ agentEnabled: boolean; provider: string | null }>;
  /** The world's WORLD_MODEL_SETTING row (cf-hosted.ts), read at each run creation. */
  worldSetting: () => Promise<string | null> | string | null;
  /** The lease's spend position (the world's bound ledger status). */
  status: () => Promise<HostedSpendStatus | null>;
  /** slot-smoke forces scripted. */
  forced?: HostedProviderId | null;
}

/**
 * The pool's `select` over KV, the world setting and SpendDO. A source that fails is read as absent (no world
 * setting, no status), never as a reason to stop the run: the reservation still enforces every cap.
 */
export function hostedProviderSelector(i: HostedSelectorInputs): (available: ReadonlySet<HostedProviderId>) => Promise<HostedProviderChoice> {
  const safe = async <T>(f: () => Promise<T> | T, fallback: T): Promise<T> => { try { return await f(); } catch { return fallback; } };
  return async (available) => {
    if (i.forced) return chooseHostedProvider({ agentEnabled: true, configured: null, world: null, available, status: null, forced: i.forced });
    const [config, world, status] = await Promise.all([
      safe(i.config, { agentEnabled: true, provider: null }), safe(i.worldSetting, null), safe(i.status, null),
    ]);
    return chooseHostedProvider({ agentEnabled: config.agentEnabled, configured: config.provider, world, available, status });
  };
}

/** What the runtime asks at run creation, and how a pinned run finds its provider again (after a requeue or restart). */
export interface ProviderPool {
  choose(input: { kind: PromptKind; attended: boolean }): Promise<ModelProvider>;
  /** The provider a run row names, or null when this world has none by that id (the run then cannot continue). */
  byId(id: string, model: string): ModelProvider | null;
}

export interface HostedProviderSet {
  providers: Partial<Record<HostedProviderId, ModelProvider>> & { scripted: ModelProvider };
  /** Providers the factory refused, with its reason (a missing key, the test-mode guard). Never a secret. */
  refused: Partial<Record<HostedProviderId, string>>;
}

/** openai, workers_ai and scripted side by side, each through the same factory and guards. */
export function hostedProviderSet(opts: CreateProviderOptions, ports: ProviderPorts): HostedProviderSet {
  const providers: HostedProviderSet["providers"] = { scripted: createProviderFor("scripted", opts, ports) };
  const refused: HostedProviderSet["refused"] = {};
  for (const id of ["openai", WORKERS_AI_PROVIDER_ID] as const) {
    try {
      providers[id] = createProviderFor(id, opts, ports);
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      refused[id] = e.message;
    }
  }
  return { providers, refused };
}

export interface HostedPoolOptions {
  set: HostedProviderSet;
  /** The decision for a new run (chooseHostedProvider over KV, the world setting and the lease's spend status). */
  select: (available: ReadonlySet<HostedProviderId>) => Promise<HostedProviderChoice>;
}

/** The pool a hosted world's runtime gets; `last` is the most recent choice (the session status and the banner). */
export function createHostedProviderPool(o: HostedPoolOptions): ProviderPool & { readonly last: HostedProviderChoice | null; available: ReadonlySet<HostedProviderId> } {
  const available = new Set(Object.keys(o.set.providers) as HostedProviderId[]);
  let last: HostedProviderChoice | null = null;
  return {
    available,
    get last() { return last; },
    async choose() {
      const c = await o.select(available);
      last = c;
      return o.set.providers[c.id] ?? o.set.providers.scripted;
    },
    byId(id) {
      return o.set.providers[id as HostedProviderId] ?? null;
    },
  };
}
