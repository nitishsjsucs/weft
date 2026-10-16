// Claude provider (harness 11.3, SPEC 9.1), written only from the bundled claude-api docs (TypeScript README,
// tool-use.md, streaming.md and shared/model-migration.md "Migrating to Claude Opus 5.5"). Official
// @anthropic-ai/sdk, beta Messages API streamed and collected with finalMessage(): model claude-opus-5-5, adaptive
// thinking with summarized display (thinking cannot be disabled on Opus 5.5), an explicit output_config.effort
// (the API default is medium, so it is always sent), server-side fallbacks "default" under the
// server-side-fallback-2026-07-01 beta, strict tools with tool_choice auto (forced tool use is a 400 on Opus 5.5),
// and the frozen prompt as a cached system block. Thinking blocks are replayed unchanged. maxRetries 0: the loop
// retries and reserves every attempt. There is no Anthropic key on this machine, so this is tested only against a
// committed request snapshot and recorded response fixtures.
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Effort, HistoryItem, ModelProvider, ModelStepRequest, ModelStepResult, Usage } from "@weft/contracts";
import { renderNotice } from "./openai";

export const CLAUDE_MODEL = "claude-opus-5-5";
export const CLAUDE_LABEL = "Claude Opus 5.5";

export const CLAUDE_FIXED = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
  thinking: { type: "adaptive", display: "summarized" },
  tool_choice: { type: "auto" },
  /** Thinking counts toward max_tokens on Opus 5.5, so the floor leaves room for it as well as the reply. */
  minMaxTokens: 16_000,
  timeoutMs: 120_000,
} as const;

type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Weft effort to output_config.effort. "none" is OpenAI only; the lowest Claude level is low. */
export function claudeEffort(e: Effort): ClaudeEffort {
  return e === "none" ? "low" : e;
}

export interface ClaudeProviderOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /** For tests: a client with the same beta.messages.stream shape. */
  client?: { beta: { messages: { stream: (body: never, opts?: { signal?: AbortSignal }) => { finalMessage(): Promise<unknown>; request_id?: string | null } } } };
}

type Block = Record<string, unknown>;
type MessageParam = { role: "user" | "assistant"; content: string | Block[] };

/** Weft history to Messages API turns. Consecutive user turns are allowed; the API combines them. */
export function claudeMessages(history: HistoryItem[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const h of history) {
    switch (h.kind) {
      case "context":
      case "user":
        out.push({ role: "user", content: h.text });
        break;
      case "notice":
        out.push({ role: "user", content: renderNotice(h) });
        break;
      case "model":
        if (h.provider !== "claude") throw new Error(`a run is pinned to one provider; found ${h.provider} items in a claude run`);
        // The assistant content verbatim, thinking blocks and signatures included (pass them back unchanged).
        out.push({ role: "assistant", content: Array.isArray(h.native) ? (h.native as Block[]) : [] });
        break;
      case "tool_outputs":
        out.push({ role: "user", content: h.outputs.map((o) => ({ type: "tool_result", tool_use_id: o.callId, content: o.output })) });
        break;
    }
  }
  return out;
}

/** The SDK's own parameter type for beta.messages.stream, so the body is checked against the SDK at compile time. */
export type ClaudeStreamParams = BetaMessageStreamParams;

/** The exact beta.messages.stream body of harness 11.3. Snapshot-tested against __snapshots__/claude-request.json. */
export function buildClaudeRequest(req: ModelStepRequest): Record<string, unknown> {
  return buildClaudeParams(req) as unknown as Record<string, unknown>;
}

function buildClaudeParams(req: ModelStepRequest): ClaudeStreamParams {
  const tools = [...req.tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Beta.Messages.BetaTool.InputSchema, strict: true }));
  return {
    model: req.model,
    max_tokens: Math.max(req.maxOutputTokens, CLAUDE_FIXED.minMaxTokens),
    betas: [...CLAUDE_FIXED.betas],
    fallbacks: CLAUDE_FIXED.fallbacks,
    thinking: { ...CLAUDE_FIXED.thinking },
    output_config: { effort: claudeEffort(req.effort) },
    system: [{ type: "text", text: req.frozenPrompt, cache_control: { type: "ephemeral" } }],
    tools,
    tool_choice: { ...CLAUDE_FIXED.tool_choice },
    messages: claudeMessages(req.history) as Anthropic.Beta.Messages.BetaMessageParam[],
  };
}

interface RawUsage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }
interface RawMessage {
  id?: string;
  model?: string;
  stop_reason?: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  content?: Block[];
  usage?: RawUsage | null;
  _request_id?: string | null;
}

/** Anthropic input_tokens excludes cache reads and writes; Weft's input is the whole prompt. */
export function mapClaudeUsage(u: RawUsage | null | undefined): Usage {
  const cached = u?.cache_read_input_tokens ?? 0;
  const cacheWrite = u?.cache_creation_input_tokens ?? 0;
  return { input: (u?.input_tokens ?? 0) + cached + cacheWrite, cached, cacheWrite, output: u?.output_tokens ?? 0, reasoning: 0 };
}

/** Response handling: refusal before content, a cut-off turn runs nothing, then tool_use blocks or final text. */
export function handleClaudeMessage(msg: RawMessage, model: string, requestId: string | null = null): ModelStepResult {
  const content = Array.isArray(msg.content) ? msg.content : [];
  const base = { usage: mapClaudeUsage(msg.usage), servedBy: msg.model ?? model, requestId: requestId ?? msg._request_id ?? null, native: content };
  const text = content.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("");
  if (msg.stop_reason === "refusal") {
    const explanation = msg.stop_details?.explanation ?? text;
    return { ...base, stop: "refusal", text: explanation ?? "", toolCalls: [], refusal: { text: explanation ?? "", category: msg.stop_details?.category ?? null } };
  }
  if (msg.stop_reason === "max_tokens" || msg.stop_reason === "model_context_window_exceeded") {
    return { ...base, stop: "incomplete", text: "", toolCalls: [], error: { code: "PROVIDER_UNAVAILABLE", message: `incomplete: ${msg.stop_reason}`, retryable: msg.stop_reason === "max_tokens" } };
  }
  if (msg.stop_reason === "pause_turn") {
    // Only server tools pause a turn and Weft sends none, so this is unexpected: fail the step, run nothing.
    return { ...base, stop: "error", text: "", toolCalls: [], error: { code: "PROVIDER_UNAVAILABLE", message: "unexpected pause_turn", retryable: false } };
  }
  const toolCalls = content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ callId: String(b.id), name: String(b.name), argumentsJson: JSON.stringify(b.input ?? {}) }));
  return { ...base, stop: toolCalls.length ? "tool_calls" : "final", text, toolCalls };
}

/** The SDK error classes errorResult maps, for tests (boundary rule: only this file imports @anthropic-ai/sdk). */
export const CLAUDE_ERRORS = {
  APIError: Anthropic.APIError, APIConnectionError: Anthropic.APIConnectionError, APIConnectionTimeoutError: Anthropic.APIConnectionTimeoutError,
  APIUserAbortError: Anthropic.APIUserAbortError, BadRequestError: Anthropic.BadRequestError, AuthenticationError: Anthropic.AuthenticationError,
  RateLimitError: Anthropic.RateLimitError, InternalServerError: Anthropic.InternalServerError,
} as const;

export function claudeErrorResult(e: unknown, model: string): ModelStepResult {
  const empty = { stop: "error" as const, text: "", toolCalls: [], native: [], usage: mapClaudeUsage(null), servedBy: model, requestId: null };
  const msg = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
  const requestId = (e as { requestID?: string | null })?.requestID ?? null;
  const err = (code: NonNullable<ModelStepResult["error"]>["code"], retryable: boolean): ModelStepResult => ({ ...empty, requestId, error: { code, message: msg, retryable } });
  if (e instanceof Anthropic.APIUserAbortError) return err("PROVIDER_TIMEOUT", false);
  if (e instanceof Anthropic.APIConnectionTimeoutError) return err("PROVIDER_TIMEOUT", true);
  if (e instanceof Anthropic.APIConnectionError) return err("PROVIDER_UNAVAILABLE", true);
  if (e instanceof Anthropic.BadRequestError) return err("PROVIDER_REQUEST_INVALID", false);
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError || e instanceof Anthropic.NotFoundError) return err("PROVIDER_CONFIG", false);
  if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError) return err("PROVIDER_UNAVAILABLE", true);
  if (e instanceof Anthropic.APIError && e.status === 529) return err("PROVIDER_UNAVAILABLE", true);
  return err("PROVIDER_UNAVAILABLE", false);
}

export function createClaudeClient(apiKey: string, timeoutMs: number = CLAUDE_FIXED.timeoutMs): Anthropic {
  return new Anthropic({ apiKey, maxRetries: 0, timeout: timeoutMs });
}

export function claudeProvider(opts: ClaudeProviderOptions): ModelProvider {
  const client = opts.client ?? createClaudeClient(opts.apiKey, opts.timeoutMs);
  const model = opts.model ?? CLAUDE_MODEL;
  return {
    id: "claude",
    model,
    label: model === CLAUDE_MODEL ? CLAUDE_LABEL : `Claude ${model}`,
    live: true,
    async step(req) {
      const body = buildClaudeRequest(req);
      try {
        const stream = client.beta.messages.stream(body as never, { signal: req.signal });
        const msg = (await stream.finalMessage()) as RawMessage;
        return handleClaudeMessage(msg, req.model, stream.request_id ?? null);
      } catch (e) {
        return claudeErrorResult(e, req.model);
      }
    },
  };
}
