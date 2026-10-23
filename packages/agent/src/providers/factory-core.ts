// Provider selection (harness 11.1, SPEC 9.1). WEFT_LLM defaults to scripted; a model runs only when WEFT_LLM names
// one explicitly: openai (Luna, Responses API, through AI Gateway when WEFT_AIG_ACCOUNT_ID and WEFT_AIG_GATEWAY are
// set), claude (Claude Opus 5.5, bundled-docs provider), mlx or llama (a local OpenAI-compatible chat-completions
// server at WEFT_LOCAL_BASE_URL), or workers_ai (the hosted switch, docs/cloudflare/design.md 5.2). Under VITEST or
// NODE_ENV=test every one of them is refused with LIVE_PROVIDER_IN_TEST unless WEFT_LIVE_OPENAI=1. A missing setting
// throws PROVIDER_CONFIG naming the variable to set. Portable: secrets and scripts come through ports, so the
// durable platform reads only Worker secrets and its bundled scripts (factory.ts wires Node's file-backed ports).
import { LocalProviderConfig, type Effort, type ModelProvider, type SpendLedger } from "@weft/contracts";
import { WORKERS_AI_PROVIDER_ID, type FetchCounter, type HostedProviderId, type WorkersAiBindingLike } from "../../../contracts/src/ext/cf-agent";
import { guardedFetch, type TxGuardLike } from "../run-host";
import type { ScriptSource } from "../script-source";
import type { Env } from "../secrets-core";
import { chatCompletionsProvider, LOCAL_DEFAULT_MODELS, type LocalMode } from "./chat-completions";
import { CLAUDE_MODEL, claudeProvider } from "./claude";
import { aiGatewayFromEnv, openAiGatewayTransport, type AigWorld } from "./gateway";
import { openaiProvider } from "./openai";
import { scriptedProviderFrom, type ScriptedProviderOptions } from "./scripted-core";
import { workersAiBindingTransport, workersAiProvider, workersAiRestTransport } from "./workers-ai";

export class ProviderError extends Error {
  constructor(readonly code: "LIVE_PROVIDER_IN_TEST" | "PROVIDER_CONFIG", message: string) {
    super(`${code}: ${message}`);
    this.name = code;
  }
}

export const DEFAULT_MODEL = "gpt-5.6-luna";

/** The narrow Workers AI token for the Node side by side (design 5.2); the durable platform uses the AI binding. */
export const WORKERS_AI_TOKEN_ENV = "WEFT_WORKERS_AI_TOKEN";
/** "1": phase 2 BYOK, the gateway holds the OpenAI key (needs CF_AIG_TOKEN). */
export const AIG_BYOK_ENV = "WEFT_AIG_BYOK";

export interface CreateProviderOptions {
  env: Env; ledger: SpendLedger; testMode: boolean;
  /** Scripted provider only: picks a routine script variant (see ScriptedProviderOptions.variant). */
  scriptVariant?: ScriptedProviderOptions["variant"];
  /** Local providers only: the registry's compactDescription by wire name (falls back to the first sentence). */
  compactDescriptions?: (wireName: string) => string | null | undefined;
  // Hosted additions (docs/cloudflare/design.md 5): all optional, so Node's callers are unchanged.
  /** Scripts for the scripted provider instead of the scenarios directory (the durable platform's fixtures). */
  scriptSource?: ScriptSource;
  /** True on the durable platform: secrets are Worker secrets in `env` only, never WEFT_SECRETS_FILE. */
  envOnlySecrets?: boolean;
  /** The Workers AI binding (`env.AI`) for workers_ai; absent on Node, which uses the REST transport. */
  ai?: WorkersAiBindingLike | null;
  /** The world a call is for, for `cf-aig-metadata`. */
  world?: () => AigWorld | null;
  /** The per-invocation fetch counter and the IO_IN_TX guard every transport fetch goes through. */
  counter?: FetchCounter | null;
  guard?: TxGuardLike | null;
  /** The fetch underneath the transports (tests). */
  fetch?: typeof fetch;
  /** KV `aig.collect_log`, read per call (false: the gateway keeps no log of Weft's calls). */
  collectLog?: () => boolean | null;
}

/** Where the factory reads secrets and scripts: Node's file-backed ports (factory.ts) or the environment and bundle. */
export interface ProviderPorts {
  secret(name: string): string | null;
  scripts(): ScriptSource;
}

/** WEFT_LOCAL_BASE_URL (required) and WEFT_LOCAL_MODEL (optional) validated with LocalProviderConfig. */
export function localConfigFromEnv(env: Env, mode: LocalMode): LocalProviderConfig {
  const baseUrl = (env.WEFT_LOCAL_BASE_URL ?? "").trim();
  if (!baseUrl) {
    throw new ProviderError("PROVIDER_CONFIG", `WEFT_LOCAL_BASE_URL is not set; WEFT_LLM=${mode} needs the local server's URL, for example http://127.0.0.1:8080/v1`);
  }
  const parsed = LocalProviderConfig.safeParse({ baseUrl, model: (env.WEFT_LOCAL_MODEL ?? "").trim() || LOCAL_DEFAULT_MODELS[mode] });
  if (!parsed.success) throw new ProviderError("PROVIDER_CONFIG", `WEFT_LOCAL_BASE_URL is not a valid URL (${baseUrl.slice(0, 80)})`);
  return parsed.data;
}

/** The efforts WEFT_EFFORT accepts. */
export const EFFORT_OVERRIDES = ["low", "medium", "high"] as const satisfies readonly Effort[];

/**
 * The experiment-only reasoning effort override (WEFT_EFFORT=low|medium|high). When set, the OpenAI provider sends it
 * on every model call and the runtime records it on every run it opens with that provider; unset (or empty) returns
 * null and today's per-stage efforts apply unchanged. Any other value throws PROVIDER_CONFIG before a call is made.
 */
export function effortOverrideFromEnv(env: Env): Effort | null {
  const raw = (env.WEFT_EFFORT ?? "").trim();
  if (!raw) return null;
  if (!(EFFORT_OVERRIDES as readonly string[]).includes(raw)) {
    throw new ProviderError("PROVIDER_CONFIG", `WEFT_EFFORT=${raw.slice(0, 20)} is not one of ${EFFORT_OVERRIDES.join(", ")}; unset it for the per-stage defaults`);
  }
  return raw as Effort;
}

/** The OpenAI provider's settings from the environment: WEFT_MODEL (default Luna), WEFT_EFFORT and WEFT_STRIP_REPLAY_IDS. */
export function openaiSettingsFromEnv(env: Env): { model: string; effort?: Effort; stripReplayIds: boolean } {
  const effort = effortOverrideFromEnv(env);
  return { model: (env.WEFT_MODEL ?? "").trim() || DEFAULT_MODEL, ...(effort ? { effort } : {}), stripReplayIds: env.WEFT_STRIP_REPLAY_IDS === "1" };
}

export function isTestEnv(env: Env, testMode: boolean): boolean {
  return testMode || Boolean(env.VITEST) || env.NODE_ENV === "test";
}

/** Every value WEFT_LLM accepts. */
export const PROVIDER_CHOICES = ["scripted", "openai", "claude", "mlx", "llama", WORKERS_AI_PROVIDER_ID] as const;
export type ProviderChoice = (typeof PROVIDER_CHOICES)[number];

/** The provider WEFT_LLM names. */
export function createProviderWith(opts: CreateProviderOptions, ports: ProviderPorts): ModelProvider {
  const which = (opts.env.WEFT_LLM ?? "").trim() || "scripted";
  return createProviderFor(which, opts, ports);
}

/**
 * One named provider, whatever WEFT_LLM says (the hosted pool builds openai, workers_ai and scripted side by side).
 * The live-provider guard applies to every name but scripted.
 */
export function createProviderFor(which: string, opts: CreateProviderOptions, ports: ProviderPorts): ModelProvider {
  const { env } = opts;
  if (which === "scripted") return scriptedProviderFrom({ source: ports.scripts(), variant: opts.scriptVariant });
  if (isTestEnv(env, opts.testMode) && env.WEFT_LIVE_OPENAI !== "1") {
    throw new ProviderError("LIVE_PROVIDER_IN_TEST", `WEFT_LLM=${which} is a live provider; tests use the scripted provider unless WEFT_LIVE_OPENAI=1`);
  }
  switch (which) {
    case "openai": {
      const gateway = aiGatewayFromEnv(env);
      const byok = env[AIG_BYOK_ENV] === "1";
      if (byok && !gateway) throw new ProviderError("PROVIDER_CONFIG", `${AIG_BYOK_ENV}=1 needs WEFT_AIG_ACCOUNT_ID and WEFT_AIG_GATEWAY`);
      if (byok && !gateway?.token) throw new ProviderError("PROVIDER_CONFIG", `${AIG_BYOK_ENV}=1 needs CF_AIG_TOKEN (the gateway authenticates the request and holds the OpenAI key)`);
      const apiKey = byok ? "byok" : ports.secret("OPENAI_API_KEY");
      if (!apiKey) throw new ProviderError("PROVIDER_CONFIG", `OPENAI_API_KEY is not set in the environment${opts.envOnlySecrets ? " (Worker secrets only on this platform)" : " or in WEFT_SECRETS_FILE"}`);
      const transport = gateway
        ? openAiGatewayTransport({ gateway, byok, world: opts.world, counter: opts.counter, guard: opts.guard, ...(opts.collectLog ? { collectLog: opts.collectLog } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) })
        : undefined;
      // Without a gateway the SDK fetches OpenAI directly: the same IO_IN_TX guard and fetch budget as the gateway and
      // Workers AI paths. With neither (Node) the SDK keeps its own fetch, exactly as before.
      const direct = !transport && (opts.guard || opts.counter)
        ? guardedFetch(opts.fetch ?? ((input, init) => fetch(input, init)), { what: "openai fetch", guard: opts.guard, counter: opts.counter })
        : opts.fetch;
      return openaiProvider({ apiKey, ...openaiSettingsFromEnv(env), ...(transport ? { gateway: transport } : direct ? { fetch: direct } : {}) });
    }
    case "claude": {
      const apiKey = ports.secret("ANTHROPIC_API_KEY");
      if (!apiKey) throw new ProviderError("PROVIDER_CONFIG", "ANTHROPIC_API_KEY is not set in the environment or in WEFT_SECRETS_FILE");
      return claudeProvider({ apiKey, model: (env.WEFT_CLAUDE_MODEL ?? "").trim() || CLAUDE_MODEL });
    }
    case "mlx":
    case "llama":
      return chatCompletionsProvider({ mode: which, config: localConfigFromEnv(env, which), compactDescriptions: opts.compactDescriptions });
    case WORKERS_AI_PROVIDER_ID: {
      const gateway = aiGatewayFromEnv(env);
      if (opts.ai) {
        return asModelProvider(workersAiProvider({ transport: workersAiBindingTransport(opts.ai, { gateway: gateway?.gateway ?? ((env.WEFT_AIG_GATEWAY ?? "").trim() || null), world: opts.world, guard: opts.guard }) }));
      }
      if (!gateway) throw new ProviderError("PROVIDER_CONFIG", "WEFT_LLM=workers_ai on Node needs WEFT_AIG_ACCOUNT_ID and WEFT_AIG_GATEWAY (the gateway's Workers AI REST path)");
      const token = ports.secret(WORKERS_AI_TOKEN_ENV);
      if (!token) throw new ProviderError("PROVIDER_CONFIG", `${WORKERS_AI_TOKEN_ENV} is not set (a narrow Workers AI token for the gateway's Workers AI path)`);
      return asModelProvider(workersAiProvider({ transport: workersAiRestTransport({ accountId: gateway.accountId, gateway: gateway.gateway, token, gatewayToken: gateway.token, counter: opts.counter, guard: opts.guard, ...(opts.fetch ? { fetch: opts.fetch } : {}) }) }));
    }
    default:
      throw new ProviderError("PROVIDER_CONFIG", `unknown WEFT_LLM=${which}; use scripted, openai, claude, mlx, llama or workers_ai`);
  }
}

/** A hosted provider as the runtime holds it. The frozen ProviderId gains `workers_ai` at integration (cf-agent.ts);
 * until then the id travels as a string the run store keeps as written. */
export function asModelProvider(p: Omit<ModelProvider, "id"> & { id: HostedProviderId }): ModelProvider {
  return p as unknown as ModelProvider;
}
