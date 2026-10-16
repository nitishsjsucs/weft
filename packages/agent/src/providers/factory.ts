// Provider selection (harness 11.1, SPEC 9.1). WEFT_LLM defaults to scripted; Luna runs only when WEFT_LLM=openai is
// explicit. Under VITEST or NODE_ENV=test a live provider is refused with LIVE_PROVIDER_IN_TEST unless
// WEFT_LIVE_OPENAI=1. Claude and the local providers keep their contracts and are P1.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelProvider, SpendLedger } from "@weft/contracts";
import { loadSecret, type Env } from "../secrets";
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
    case "claude":
    case "mlx":
    case "llama":
      throw new ProviderError("PROVIDER_CONFIG", `not built in P0 (WEFT_LLM=${which})`);
    default:
      throw new ProviderError("PROVIDER_CONFIG", `unknown WEFT_LLM=${which}; use scripted or openai`);
  }
}
