// The brain (SPEC 9.1, 9.5 to 9.10, harness 4, 7, 10, 11). Owner: t4-agent.
// Imports only @weft/contracts, @weft/grounding, its own run store tables and its providers (tests/boundaries.test.ts).
export { createSpendLedger, capsFromEnv, SpendLockTimeout, type SpendLedgerOptions, type SpendCaps, type WeftSpendLedger } from "./spend";
export type { SpendLedgerOptions as CreateSpendLedgerOptions } from "./spend";
export { createProvider, isTestEnv, ProviderError, DEFAULT_MODEL, DEFAULT_SCRIPTS_DIR, EFFORT_OVERRIDES, effortOverrideFromEnv, openaiSettingsFromEnv, type CreateProviderOptions } from "./providers/factory";
export { openaiProvider, createOpenAIClient, buildResponsesRequest, handleResponse, historyToInput, mapUsage, renderNotice, OPENAI_FIXED, OPENAI_ERRORS, type OpenAIProviderOptions } from "./providers/openai";
export { scriptedProvider, applyTemplates, parseContext, SCRIPTED_LABEL, ScriptExpectationError, type Script, type ScriptStep, type ScriptOutput, type ScriptedProviderOptions } from "./providers/scripted";
export { createAgentRuntime, CHAT_TOOLS, DRAFT_TOOLS, DEFAULT_COMPANY_ID, type CreateAgentRuntimeOptions, type RoutinesView, type ChatContextSource, type WeftAgentRuntime } from "./runtime";
export { runLoop, historyFromSteps, renderPlan, outputFor, BUDGETS, MAX_OUTPUT_TOKENS, MAX_TOOLS, assertToolCap, RETRY_OUTPUT_TOKENS, MAX_REQUEUES, type ChecklistState, type LoopDeps, type RunSetup } from "./loop";
export { createRunStore, type RunStore } from "./store";
export { buildTrace, summarize, stageLabel, type TraceSummary, type StageRow } from "./trace";
export { createRunQueue, concurrencyFor, type RunQueue } from "./queue";
export { routinePack, chatPack, routineDraftPack, approxTokens, ROUTINE_BUDGET_TOKENS, CHAT_BUDGET_TOKENS, type OpenLoop } from "./context";
export { frozenPrompt, prefixHash, type PromptKind } from "./prompts/index";
export { LUNA, CLAUDE_OPUS_5_5, TERRA, PRICES_BY_PROVIDER, PRICES_BY_MODEL, RUN_CAP_SCALE_BY_MODEL, runCapScaleFor, stepCostUsd, reserveUsd, usdToMicros, pricesFromEnv, pricesFor, type Prices } from "./cost";
export { loadSecret, parseSecretsFile } from "./secrets";
export { canonicalJson, sha256, newNonce, escapeTagText } from "./canonical";
export { lockedWrite, isBusy } from "./busy";
export { setTraceRedactor, traceRedact, runTraceTags, traceMcpCall, type McpCallInfo } from "./otel";   // wave 4 telemetry seam (w4-telemetry)
