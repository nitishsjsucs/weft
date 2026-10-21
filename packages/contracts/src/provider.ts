// Copied verbatim from research/harness.md section 13 (provider.ts).
// Weft on Cloudflare (docs/cloudflare/design.md 5.2) adds "workers_ai", the hosted Workers AI switch.
export type ProviderId = "openai" | "claude" | "openai_compat" | "scripted" | "workers_ai";
export type Effort = "none" | "low" | "medium" | "high" | "xhigh" | "max";   // "none" is OpenAI only
export type TaskKind = "notice_analysis" | "payroll_review" | "tax_registration" | "it_provisioning";
export type AgentKind = "main" | `task:${TaskKind}`;

export interface ToolSpec {
  name: string;                        // wire name namespace__action
  description: string;
  parameters: Record<string, unknown>; // strict JSON schema, sorted keys
}

export type ToolChoice = { mode: "auto" } | { mode: "allowed"; names: string[] };   // "allowed" is P1

export type NoticeKind = "decision" | "event" | "budget" | "repair";
export type HistoryItem =
  | { kind: "context"; text: string }                                     // input[1], once
  | { kind: "user"; text: string }
  | { kind: "notice"; notice: NoticeKind; attrs: Record<string, string>; text: string }   // rendered with the run nonce
  | { kind: "model"; provider: ProviderId; native: unknown }              // verbatim output items
  | { kind: "tool_outputs"; outputs: { callId: string; name: string; output: string }[] };   // last output may carry _weft_plan

export interface ModelStepRequest {
  runId: string;
  agentKind: AgentKind;
  model: string;
  frozenPrompt: string;
  tools: ToolSpec[];                   // fixed for the run
  toolChoice: ToolChoice;              // { mode: "auto" } in P0
  history: HistoryItem[];              // append-only
  effort: Effort;                      // fixed per agent kind
  maxOutputTokens: number;
  cacheKey: string;                    // weft:<agentKind>:<routineId|chat>:<companyId>
  signal?: AbortSignal;
}

export interface Usage { input: number; cached: number; cacheWrite: number; output: number; reasoning: number }

export interface ModelStepResult {
  stop: "tool_calls" | "final" | "incomplete" | "refusal" | "error";
  text: string;
  toolCalls: { callId: string; name: string; argumentsJson: string }[];
  native: unknown;                     // stored as HistoryItem kind "model"
  refusal?: { text: string; category: string | null };
  usage: Usage;
  servedBy: string;
  requestId: string | null;
  error?: { code: "PROVIDER_REQUEST_INVALID" | "PROVIDER_CONFIG" | "PROVIDER_UNAVAILABLE" | "PROVIDER_TIMEOUT"; message: string; retryable: boolean };
}

export interface ModelProvider {
  id: ProviderId;
  model: string;
  label: string;                       // UI badge
  live: boolean;                       // false only for scripted; the factory guard refuses live providers in tests
  step(req: ModelStepRequest): Promise<ModelStepResult>;   // one attempt, no internal retries
  /** The max_tokens this provider actually sends for a requested output budget (a floor or a cap); the loop reserves
   * spend against it. Absent means the request is sent as asked. */
  outputTokensFor?(requested: number): number;
}
