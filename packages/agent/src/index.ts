// The brain (SPEC 9.1, 9.5 to 9.10, harness 4, 7, 10, 11). Owner: t4-agent.
// Imports only @weft/contracts, @weft/grounding, its own run store tables and its providers (tests/boundaries.test.ts).
import { NotImplemented, type AgentExecutor, type AgentRuntime, type ModelProvider, type RoutineDef, type SimClock, type SpendLedger } from "@weft/contracts";
import type { Db } from "@weft/db";

export interface CreateSpendLedgerOptions { dir: string }
export function createSpendLedger(_opts: CreateSpendLedgerOptions): SpendLedger {
  throw new NotImplemented("createSpendLedger (t4-agent)");
}

export interface CreateProviderOptions { env: Record<string, string | undefined>; ledger: SpendLedger; testMode: boolean }
/** Throws LIVE_PROVIDER_IN_TEST for a live provider under VITEST or NODE_ENV=test unless WEFT_LIVE_OPENAI=1. */
export function createProvider(_opts: CreateProviderOptions): ModelProvider {
  throw new NotImplemented("createProvider (t4-agent)");
}

export interface OpenAIProviderOptions { apiKey: string; model: string; ledger: SpendLedger; timeoutMs?: number }
export function openaiProvider(_opts: OpenAIProviderOptions): ModelProvider {
  throw new NotImplemented("openaiProvider (t4-agent)");
}

export interface ScriptedProviderOptions { scriptsDir: string }
export function scriptedProvider(_opts: ScriptedProviderOptions): ModelProvider {
  throw new NotImplemented("scriptedProvider (t4-agent)");
}

/** Read access to routine definitions for the loop (context packs, checklists). */
export interface RoutinesView { get(routineId: string): Promise<RoutineDef | null> }

export interface CreateAgentRuntimeOptions { db: Db; clock: SimClock; executor: AgentExecutor; provider: ModelProvider; ledger: SpendLedger; routinesView: RoutinesView }
export function createAgentRuntime(_opts: CreateAgentRuntimeOptions): AgentRuntime {
  throw new NotImplemented("createAgentRuntime (t4-agent)");
}
