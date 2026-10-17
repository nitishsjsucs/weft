import { z } from "zod";
// Wave 4 telemetry contracts (docs/wave4.md section 3, research/wave4/phoenix.md). Owner of the implementation:
// w4-telemetry. Every other track reads these names; nobody else emits spans.
// Rule: every attribute value is built from Weft's already redacted copies and passes through the injected redactor
// before it reaches a span (phoenix.md section 6). Vault values, keys and credential values never reach a span.

/** The pinned local Phoenix. Never a hosted account, never `latest` or `nightly`. */
export const PHOENIX = {
  version: "20.23.0",
  fallbackVersion: "20.22.0",
  python: "3.13",
  host: "127.0.0.1",
  /** The one long-lived wave 4 Phoenix (UI, REST and OTLP over HTTP). Override with WEFT_PHOENIX_PORT. */
  httpPort: 6206,
  /** gRPC binds every interface whatever PHOENIX_HOST says; Weft never sends to it. Override with WEFT_PHOENIX_GRPC_PORT. */
  grpcPort: 6207,
  /** Relative to $HOME; outside the repo so Nitish can browse every trace later. Never committed. */
  workingDir: "Developer/projects/weft-notes/phoenix",
  /** Project for interactive dev runs; eval runs use `weft-eval-<date>-<sha>-<variant>`. */
  devProject: "weft",
} as const;

/** WEFT_TRACE=phoenix turns tracing on in apps/api and the eval runner; unset means a no-op tracer and nothing sent. */
export const TRACE_ENV = { switch: "WEFT_TRACE", url: "WEFT_PHOENIX_URL", project: "WEFT_PHOENIX_PROJECT" } as const;

/** OpenInference span kinds Weft emits (phoenix.md 5.2). */
export const WeftSpanKind = z.enum(["AGENT", "CHAIN", "LLM", "TOOL", "RETRIEVER", "GUARDRAIL"]);
export type WeftSpanKind = z.infer<typeof WeftSpanKind>;

/** Span names. One AGENT span per run, one CHAIN per stage row, LLM per provider call, TOOL per executor call. */
export const SPAN_NAMES = {
  run: "agent.run", admission: "admission", assemble: "assemble", model: "model", dispatch: "dispatch", post: "post", terminal: "terminal",
  llm: "llm.responses", recall: "memory.recall", grounding: "grounding.check", taint: "taint.check",
} as const;

/** Weft-specific attribute keys (OpenInference keys come from @arizeai/openinference-semantic-conventions). */
export const WEFT_ATTR = {
  runId: "weft.run_id", stepN: "weft.step_n", attempt: "weft.attempt", outcome: "weft.outcome", refusalCode: "weft.refusal_code",
  prefixHash: "weft.prefix_hash", requestId: "weft.request_id", guardrail: "weft.guardrail", terminalReason: "weft.terminal_reason",
  proposalId: "weft.proposal_id", tainted: "weft.tainted", recipe: "weft.recipe",
} as const;

/** weft.outcome on TOOL spans. Refusals keep span status UNSET; ERROR is for exceptions and provider failures only. */
export type ToolOutcomeCode = "ok" | "proposal" | `refused:${string}` | "error";
export function toolOutcomeCode(o: { ok: true; proposalId?: string } | { ok: true; status?: string } | { ok: false; refusal: { code: string } } | { error: unknown }): ToolOutcomeCode {
  if ("error" in o) return "error";
  if (!o.ok) return `refused:${o.refusal.code}`;
  return "proposalId" in o && o.proposalId ? "proposal" : "ok";
}

/** The eval variants. `default` keeps both pending decisions off; `chat_can_propose` is reported separately, never as the default. */
export const EvalVariant = z.enum(["default", "chat_can_propose"]); export type EvalVariant = z.infer<typeof EvalVariant>;

/**
 * Metadata on every span of a run (OpenInference `metadata`), set once at run start. The eval fields are filled by the
 * eval runner through RunTraceTags; dev runs leave them null.
 */
export const TraceRunMeta = z.object({
  run_id: z.string(), company_id: z.string(), kind: z.string(), trigger: z.string(), attended: z.boolean(),
  provider: z.string(), model: z.string(), prompt_version: z.string().nullable(), harness_sha: z.string().nullable(),
  routine_id: z.string().nullable(), routine_run_id: z.string().nullable(), golden_path: z.string().nullable(),
  eval_task_id: z.string().nullable(), eval_split: z.enum(["dev", "test"]).nullable(), eval_variant: EvalVariant.nullable(), eval_trial: z.number().int().nullable(),
  chat_can_propose: z.boolean(),
});
export type TraceRunMeta = z.infer<typeof TraceRunMeta>;
export type EvalTraceTags = Pick<TraceRunMeta, "eval_task_id" | "eval_split" | "eval_variant" | "eval_trial" | "golden_path" | "harness_sha">;

/** session.id: the chat thread, else `routine_run:<id>`, else the eval task id. user.id: the principal, or `routine:<id>` unattended. */
export function traceSessionId(run: { threadId: string | null; routineRunId: string | null }, evalTaskId: string | null): string | null {
  return run.threadId ?? (run.routineRunId ? `routine_run:${run.routineRunId}` : evalTaskId);
}

/** The redactor the composition root injects (Redactor.value bound). The brain never imports the vault. */
export type TraceRedact = <T>(value: T) => T;

/**
 * Process-wide eval tags. Trials run one at a time in one process, so the eval runner sets the tags before a trial and
 * clears them after; the loop reads them when it opens the AGENT span. Implemented in packages/agent/src/otel.ts.
 */
export interface RunTraceTags { set(tags: Partial<EvalTraceTags> | null): void; current(): Partial<EvalTraceTags> | null }

/** Strings that must never appear in an exported span (the G9 canary and the telemetry redaction tests use them). */
export const SECRET_PATTERNS: readonly RegExp[] = [/sk-[A-Za-z0-9_-]{20,}/, /sk-ant-[A-Za-z0-9_-]{20,}/, /\b\d{3}-\d{2}-\d{4}\b/];
