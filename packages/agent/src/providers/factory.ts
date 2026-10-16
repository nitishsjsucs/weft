// Provider selection (harness 11.1, SPEC 9.1). WEFT_LLM defaults to scripted; a model runs only when WEFT_LLM names
// one explicitly: openai (Luna, Responses API), claude (Claude Opus 5.5, bundled-docs provider), mlx or llama (a local
// OpenAI-compatible chat-completions server at WEFT_LOCAL_BASE_URL). Under VITEST or NODE_ENV=test every one of them
// is refused with LIVE_PROVIDER_IN_TEST unless WEFT_LIVE_OPENAI=1. A missing setting throws PROVIDER_CONFIG naming
// the variable to set.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalProviderConfig, type ModelProvider, type SpendLedger } from "@weft/contracts";
import { loadSecret, type Env } from "../secrets";
import { chatCompletionsProvider, LOCAL_DEFAULT_MODELS, type LocalMode } from "./chat-completions";
import { CLAUDE_MODEL, claudeProvider } from "./claude";
import { openaiProvider } from "./openai";
import { scriptedProvider, type ScriptedProviderOptions } from "./scripted";

export class ProviderError extends Error {
  constructor(readonly code: "LIVE_PROVIDER_IN_TEST" | "PROVIDER_CONFIG", message: string) {
    super(`${code}: ${message}`);
    this.name = code;
  }
}

export const DEFAULT_MODEL = "gpt-5.6-luna";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const DEFAULT_SCRIPTS_DIR = join(REPO_ROOT, "scenarios");

export interface CreateProviderOptions {
  env: Env; ledger: SpendLedger; testMode: boolean;
  /** Scripted provider only: picks a routine script variant (see ScriptedProviderOptions.variant). */
  scriptVariant?: ScriptedProviderOptions["variant"];
  /** Local providers only: the registry's compactDescription by wire name (falls back to the first sentence). */
  compactDescriptions?: (wireName: string) => string | null | undefined;
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

export function isTestEnv(env: Env, testMode: boolean): boolean {
  return testMode || Boolean(env.VITEST) || env.NODE_ENV === "test";
}

export function createProvider(opts: CreateProviderOptions): ModelProvider {
  const { env } = opts;
  const which = (env.WEFT_LLM ?? "").trim() || "scripted";
  if (which === "scripted") return scriptedProvider({ scriptsDir: env.WEFT_SCRIPTS_DIR ?? DEFAULT_SCRIPTS_DIR, variant: opts.scriptVariant });
  if (isTestEnv(env, opts.testMode) && env.WEFT_LIVE_OPENAI !== "1") {
    throw new ProviderError("LIVE_PROVIDER_IN_TEST", `WEFT_LLM=${which} is a live provider; tests use the scripted provider unless WEFT_LIVE_OPENAI=1`);
  }
  switch (which) {
    case "openai": {
      const apiKey = loadSecret("OPENAI_API_KEY", env);
      if (!apiKey) throw new ProviderError("PROVIDER_CONFIG", "OPENAI_API_KEY is not set in the environment or in WEFT_SECRETS_FILE");
      return openaiProvider({ apiKey, model: (env.WEFT_MODEL ?? "").trim() || DEFAULT_MODEL, stripReplayIds: env.WEFT_STRIP_REPLAY_IDS === "1" });
    }
    case "claude": {
      const apiKey = loadSecret("ANTHROPIC_API_KEY", env);
      if (!apiKey) throw new ProviderError("PROVIDER_CONFIG", "ANTHROPIC_API_KEY is not set in the environment or in WEFT_SECRETS_FILE");
      return claudeProvider({ apiKey, model: (env.WEFT_CLAUDE_MODEL ?? "").trim() || CLAUDE_MODEL });
    }
    case "mlx":
    case "llama":
      return chatCompletionsProvider({ mode: which, config: localConfigFromEnv(env, which), compactDescriptions: opts.compactDescriptions });
    default:
      throw new ProviderError("PROVIDER_CONFIG", `unknown WEFT_LLM=${which}; use scripted, openai, claude, mlx or llama`);
  }
}
