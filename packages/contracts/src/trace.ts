// Copied verbatim from research/harness.md section 13 (trace.ts).
import type { AgentKind, Effort, ProviderId, Usage } from "./provider";
import type { RefusalCode } from "./commands";
import type { Proposal } from "./approvals";
export type RunStatus = "queued" | "running" | "waiting" | "held" | "done" | "failed" | "refused" | "escalated" | "expired" | "cancelled";
export type Stage = "admission" | "assemble" | "model" | "dispatch" | "post" | "terminal";
export type TerminalReason = "DONE" | "WAITING_APPROVAL" | "REFUSED" | "MODEL_INCOMPLETE" | "BUDGET_EXCEEDED" | "REPEATED_ERRORS"
  | "NOT_DONE" | "CANCELLED" | "PROVIDER_DOWN" | "EXPIRED" | "HELD" | "PROCESS_RESTART"
  | "HANDED_OFF";   // the cursor assistant handed the request to a chat run in the same thread (ext/assist.ts, additive)

export interface AgentRunRow {
  id: string; companyId: string; kind: AgentKind; parentRunId: string | null; threadId: string | null; routineRunId: string | null;
  trigger: string; attended: boolean; provider: ProviderId; model: string; effort: Effort; cacheKey: string;
  status: RunStatus; terminalReason: TerminalReason | null;
  tainted: boolean; taintedBy: string | null;      // read-only mirror of run_taint
  checklist: { id: string; label: string; passed: boolean }[] | null;
  budget: { steps: number; usd: number; minutes: number };
  stepsUsed: number; requeues: number; consecutiveErrors: number; costUsdMicros: number;
  tokens: Usage; createdAt: string; endedAt: string | null; summary: string | null;
}

export interface StepTimings { admissionMs: number; assembleMs: number; timeToLlmMs: number; modelMs: number; dispatchMs: number; tokensPerSecond: number | null }

export interface RunStepRow {
  runId: string; n: number; parentN: number | null; stage: Stage;
  kind: "context" | "model_call" | "tool_call" | "notice" | "recite" | "verify" | "error";
  callId: string | null; toolName: string | null; toolArgs: unknown | null;   // redacted
  outcome: "ok" | `refused:${RefusalCode}` | `pending:${string}` | "error" | null;
  result: unknown | null;                                       // redacted, or artifact summary
  native: unknown | null;                                       // provider output items verbatim (model_call)
  usage: Usage | null; costUsdMicros: number; attempt: number; requestId: string | null; prefixHash: string | null;
  timings: StepTimings | null; createdAt: string;
}

export interface RunTrace { run: AgentRunRow; steps: RunStepRow[]; proposals: Proposal[]; actions: { seq: number; command: string; summary: string }[]; children: RunTrace[] }
