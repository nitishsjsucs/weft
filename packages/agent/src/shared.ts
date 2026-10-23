// Everything @weft/agent exports that runs on both platforms (index.ts adds Node's file-backed parts; portable.ts,
// the entry a Worker bundle resolves, adds their environment-only and bundle-backed counterparts under the same names).
// No module reachable from here imports node:fs, node:os, node:child_process or node:net (test/portable.test.ts).
export { capsFromEnv, createLedgerCore, fold, neuronsForUsdMicros, nodeCaps, queryFor, randomReservationId, totalsOf, utcDay, type EntryQuery, type Folded, type LedgerCore, type LedgerCoreOptions, type LedgerEntry, type SpendCaps, type SpendStore, type Totals, type TotalsScope } from "./spend-core";
export { createSqlSpendStore, SPEND_SCHEMA, SPEND_SCHEMA_VERSION, type SqlSpendStorage, type SqlSpendStore } from "./spend-sql";
export { bindSpendLedger, createHostedSpendLedger, hostedCapsFromConfig, isWorkersAiModel, kvCapsSource, type BoundSpendLedger, type HostedSpendLedgerOptions, type KvLike, type LeaseBinding } from "./spend-hosted";
export { alarmRunHost, createFetchCounter, FetchBudgetExceeded, guardedFetch, immediateRunHost, type AlarmRunHost, type AlarmRunHostOptions, type DrainResult, type TxGuardLike } from "./run-host";
export { bindWorldScope, currentWorld, perWorld } from "./world";
export { fixtureScriptSource, inlineScriptSource, registeredScriptSource, setScriptSource, type ScriptSource } from "./script-source";
export { AIG_BYOK_ENV, asModelProvider, createProviderFor, createProviderWith, DEFAULT_MODEL, EFFORT_OVERRIDES, effortOverrideFromEnv, isTestEnv, openaiSettingsFromEnv, PROVIDER_CHOICES, ProviderError, WORKERS_AI_TOKEN_ENV, type CreateProviderOptions, type ProviderChoice, type ProviderPorts } from "./providers/factory-core";
export { openaiProvider, createOpenAIClient, buildResponsesRequest, handleResponse, historyToInput, mapUsage, renderNotice, OPENAI_FIXED, OPENAI_ERRORS, type OpenAIProviderOptions } from "./providers/openai";
export { AIG_COLLECT_LOG_HEADER, aiGatewayFromEnv, aigKindOf, aigMetadataHeader, gatewayCacheHit, openAiGatewayTransport, stripAuthorization, type AigWorld, type GatewayStepResult, type GatewayTransport, type GatewayTransportOptions } from "./providers/gateway";
export { normalizeWorkersAiOutput, workersAiBindingTransport, workersAiBody, workersAiProvider, workersAiRestTransport, type BindingTransportOptions, type RestTransportOptions, type WorkersAiProviderOptions, type WorkersAiTransport } from "./providers/workers-ai";
export { chooseHostedProvider, createHostedProviderPool, HOSTED_PROVIDER_IDS, hostedProviderSelector, hostedProviderSet, kvModelConfig, MIN_NEURONS_FOR_RUN, parseHostedProviderId, type HostedChoiceInput, type HostedModelConfig, type HostedPoolOptions, type HostedProviderChoice, type HostedProviderReason, type HostedProviderSet, type HostedSelectorInputs, type ProviderPool } from "./providers/hosted";
export { applyTemplates, parseContext, SCRIPTED_LABEL, ScriptExpectationError, scriptedProviderFrom, type Script, type ScriptedProviderOptions, type ScriptOutput, type ScriptStep } from "./providers/scripted-core";
export { CHAT_TOOLS, DRAFT_TOOLS, DEFAULT_COMPANY_ID, type CreateAgentRuntimeOptions, type RoutinesView, type ChatContextSource, type WeftAgentRuntime } from "./runtime";
export { runLoop, historyFromSteps, renderPlan, outputFor, BUDGETS, MAX_OUTPUT_TOKENS, MAX_TOOLS, assertToolCap, RETRY_OUTPUT_TOKENS, MAX_REQUEUES, type ChecklistState, type LoopDeps, type RunSetup } from "./loop";
export { createRunStore, type RunStore } from "./store";
export { answerForThread, boundTurns, earlierConversationBlock, questionOfPack, TURN_ANSWER_CHARS, TURN_QUESTION_CHARS, type EarlierTurn } from "./threads";
export { buildTrace, summarize, stageLabel, type TraceSummary, type StageRow } from "./trace";
export { createRunQueue, concurrencyFor, type RunQueue } from "./queue";
export { routinePack, chatPack, routineDraftPack, approxTokens, ROUTINE_BUDGET_TOKENS, CHAT_BUDGET_TOKENS, type OpenLoop } from "./context";
export { frozenPrompt, prefixHash, type PromptKind } from "./prompts/index";
export { LUNA, CLAUDE_OPUS_5_5, TERRA, WORKERS_AI_GPT_OSS, NEURONS_PER_M, PRICES_BY_PROVIDER, PRICES_BY_MODEL, RUN_CAP_SCALE_BY_MODEL, runCapScaleFor, stepCostUsd, stepNeurons, reserveUsd, usdToMicros, pricesFromEnv, pricesFor, type Prices } from "./cost";
export { describeSecret, envSecret, parseSecretsFile } from "./secrets-core";
export { canonicalJson, sha256, newNonce, escapeTagText } from "./canonical";
export { lockedWrite, isBusy } from "./busy";
export { setTraceRedactor, traceRedact, runTraceTags, traceMcpCall, type McpCallInfo } from "./otel";   // wave 4 telemetry seam (w4-telemetry)
