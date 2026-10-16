// Local OpenAI-compatible provider (harness 11.4, SPEC 9.1): plain fetch to <base>/v1/chat/completions on a local
// server (mlx_lm.server for WEFT_LLM=mlx, llama-server for WEFT_LLM=llama). Reasoning is off
// (chat_template_kwargs.enable_thinking false, and any <think> text is dropped), tools carry compact descriptions,
// tool-call arguments are parsed as strict JSON with no repair, and one attempt runs per step with no retries.
// The server is local and free, so the provider is not live: the loop reserves and settles every attempt at zero.
// The LIVE_PROVIDER_IN_TEST guard still refuses WEFT_LLM=mlx or llama in tests (the factory checks the name).
import type { HistoryItem, LocalProviderConfig, ModelProvider, ModelStepRequest, ModelStepResult, ToolSpec, Usage } from "@weft/contracts";
import { renderNotice } from "./openai";

export type LocalMode = "mlx" | "llama";

export const LOCAL_DEFAULT_MODELS: Record<LocalMode, string> = { mlx: "mlx-community/Qwen3.6-27B-4bit", llama: "Qwen3-1.7B-Q4_0" };
export const LOCAL_LABELS: Record<LocalMode, string> = { mlx: "Local Qwen3.6-27B", llama: "Local Qwen3-1.7B (smoke)" };

export const LOCAL_FIXED = { maxTokens: 768, timeoutMs: 180_000, temperature: 0, compactChars: 200 } as const;

export interface ChatCompletionsProviderOptions {
  mode: LocalMode;
  config: LocalProviderConfig;
  /** Registry compactDescription by wire name; a missing or empty one falls back to compactFromDescription. */
  compactDescriptions?: (wireName: string) => string | null | undefined;
  maxTokens?: number;
  timeoutMs?: number;
  /** For tests: a fetch with the same shape. */
  fetchImpl?: typeof fetch;
}

type Message = Record<string, unknown>;

/** The first sentence of a full description, at most 200 characters, for tools with no compactDescription. */
export function compactFromDescription(description: string, max: number = LOCAL_FIXED.compactChars): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const m = /^(.*?[.!?])(\s|$)/.exec(flat);
  const first = m ? m[1]! : flat;
  return first.length <= max ? first : `${first.slice(0, max - 3).trimEnd()}...`;
}

/** <base>/v1/chat/completions, whether or not the configured base URL already ends in /v1. */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return /\/v1$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

export function localMessages(frozenPrompt: string, history: HistoryItem[]): Message[] {
  const out: Message[] = [{ role: "system", content: frozenPrompt }];
  for (const h of history) {
    switch (h.kind) {
      case "context":
      case "user":
        // The pack goes in a user message, not the system one: Qwen chat templates refuse a request with no user
        // message, which a routine run (context only) would otherwise be.
        out.push({ role: "user", content: h.text });
        break;
      case "notice":
        out.push({ role: "user", content: renderNotice(h) });
        break;
      case "model":
        if (h.provider !== "openai_compat") throw new Error(`a run is pinned to one provider; found ${h.provider} items in a local run`);
        out.push(...(Array.isArray(h.native) ? (h.native as Message[]) : [h.native as Message]));
        break;
      case "tool_outputs":
        for (const o of h.outputs) out.push({ role: "tool", tool_call_id: o.callId, content: o.output });
        break;
    }
  }
  return out;
}

/** The exact request body. Tools are sorted by name with compact descriptions; parameters stay the strict schema. */
export function buildChatCompletionsRequest(req: ModelStepRequest, opts: { compactDescriptions?: ChatCompletionsProviderOptions["compactDescriptions"]; maxTokens?: number } = {}): Record<string, unknown> {
  const describe = (t: ToolSpec) => {
    const c = opts.compactDescriptions?.(t.name);
    return c && c.trim() ? c.trim() : compactFromDescription(t.description);
  };
  const tools = [...req.tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({ type: "function", function: { name: t.name, description: describe(t), parameters: t.parameters } }));
  return {
    model: req.model,
    messages: localMessages(req.frozenPrompt, req.history),
    ...(tools.length ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {}),
    max_tokens: Math.min(req.maxOutputTokens, opts.maxTokens ?? LOCAL_FIXED.maxTokens),
    temperature: LOCAL_FIXED.temperature,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
}

export type ParsedArgs = { ok: true; json: string } | { ok: false; raw: string };

/**
 * Strict JSON for tool arguments: JSON.parse with no repair, and the value must be an object. An empty string means
 * no arguments. A valid object is re-serialized; anything else is passed through untouched so the loop answers the
 * call with an INVALID_INPUT tool error (the run continues, nothing crashes).
 */
export function parseToolArguments(raw: unknown): ParsedArgs {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) return { ok: true, json: JSON.stringify(raw) };
  if (typeof raw !== "string") return { ok: false, raw: raw === undefined ? "" : String(raw) };
  if (!raw.trim()) return { ok: true, json: "{}" };
  try {
    const v = JSON.parse(raw) as unknown;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return { ok: true, json: JSON.stringify(v) };
    return { ok: false, raw };
  } catch {
    return { ok: false, raw };
  }
}

/** A string that JSON.parse refuses, so the loop refuses the call with INVALID_INPUT rather than guessing. */
function invalidMarker(raw: string): string {
  return `<invalid json> ${raw.slice(0, 500)}`;
}

/** Strip reasoning text if a template ignores enable_thinking. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*?<\/think>/, "").trim();
}

interface RawUsage { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null }
interface RawToolCall { id?: string; type?: string; function?: { name?: string; arguments?: unknown } }
interface RawChoice { finish_reason?: string | null; message?: { role?: string; content?: string | null; tool_calls?: RawToolCall[] | null; refusal?: string | null } }
interface RawCompletion { id?: string; model?: string; choices?: RawChoice[]; usage?: RawUsage | null }

export function mapLocalUsage(u: RawUsage | null | undefined): Usage {
  return { input: u?.prompt_tokens ?? 0, cached: u?.prompt_tokens_details?.cached_tokens ?? 0, cacheWrite: 0, output: u?.completion_tokens ?? 0, reasoning: 0 };
}

/** Parse one /v1/chat/completions body. Call ids are made deterministic when the server leaves them empty. */
export function handleCompletion(res: RawCompletion, req: Pick<ModelStepRequest, "runId" | "model" | "history">, requestId: string | null = null): ModelStepResult {
  const usage = mapLocalUsage(res.usage);
  const choice = Array.isArray(res.choices) ? res.choices[0] : undefined;
  const base = { usage, servedBy: res.model ?? req.model, requestId: requestId ?? res.id ?? null };
  if (!choice?.message) {
    return { ...base, native: [], stop: "error", text: "", toolCalls: [], error: { code: "PROVIDER_UNAVAILABLE", message: "the response has no choices", retryable: false } };
  }
  const msg = choice.message;
  const text = stripThinking(typeof msg.content === "string" ? msg.content : "");
  const step = req.history.filter((h) => h.kind === "model").length + 1;
  const toolCalls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).map((c, i) => {
    const parsed = parseToolArguments(c.function?.arguments);
    return {
      callId: c.id && String(c.id).trim() ? String(c.id) : `call_${req.runId}_${step}_${i + 1}`,
      name: String(c.function?.name ?? ""),
      argumentsJson: parsed.ok ? parsed.json : invalidMarker(parsed.raw),
      // Chat templates parse replayed arguments, so an invalid one is replayed wrapped in a JSON object.
      replayArgs: parsed.ok ? parsed.json : JSON.stringify({ invalid_arguments: parsed.raw.slice(0, 500) }),
    };
  });
  // Replayed verbatim on the next step: the normalized assistant message, never any reasoning fields.
  const native: Message[] = [{
    role: "assistant",
    content: text || null,
    ...(toolCalls.length ? { tool_calls: toolCalls.map((c) => ({ id: c.callId, type: "function", function: { name: c.name, arguments: c.replayArgs } })) } : {}),
  }];
  if (choice.finish_reason === "length") {
    return { ...base, native, stop: "incomplete", text: "", toolCalls: [], error: { code: "PROVIDER_UNAVAILABLE", message: "incomplete: max_tokens", retryable: true } };
  }
  if (typeof msg.refusal === "string" && msg.refusal) {
    return { ...base, native, stop: "refusal", text: msg.refusal, toolCalls: [], refusal: { text: msg.refusal, category: null } };
  }
  return { ...base, native, stop: toolCalls.length ? "tool_calls" : "final", text, toolCalls: toolCalls.map(({ replayArgs: _r, ...c }) => c) };
}

function errorResult(code: NonNullable<ModelStepResult["error"]>["code"], message: string, retryable: boolean, model: string): ModelStepResult {
  return { stop: "error", text: "", toolCalls: [], native: [], usage: mapLocalUsage(null), servedBy: model, requestId: null, error: { code, message: message.slice(0, 300), retryable } };
}

function httpError(status: number, body: string, model: string): ModelStepResult {
  const msg = `HTTP ${status}: ${body.replace(/\s+/g, " ").slice(0, 200)}`;
  if (status === 400 || status === 422) return errorResult("PROVIDER_REQUEST_INVALID", msg, false, model);
  if (status === 401 || status === 403 || status === 404) return errorResult("PROVIDER_CONFIG", msg, false, model);
  if (status === 408) return errorResult("PROVIDER_TIMEOUT", msg, true, model);
  if (status === 429 || status >= 500) return errorResult("PROVIDER_UNAVAILABLE", msg, true, model);
  return errorResult("PROVIDER_UNAVAILABLE", msg, false, model);
}

export function chatCompletionsProvider(opts: ChatCompletionsProviderOptions): ModelProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = chatCompletionsUrl(opts.config.baseUrl);
  const timeoutMs = opts.timeoutMs ?? LOCAL_FIXED.timeoutMs;
  const model = opts.config.model;
  const label = model === LOCAL_DEFAULT_MODELS[opts.mode] ? LOCAL_LABELS[opts.mode] : `Local ${model}`;
  return {
    id: "openai_compat",
    model,
    label,
    live: false,
    async step(req) {
      const body = buildChatCompletionsRequest(req, { compactDescriptions: opts.compactDescriptions, maxTokens: opts.maxTokens });
      const timer = AbortSignal.timeout(timeoutMs);
      const signal = req.signal ? AbortSignal.any([req.signal, timer]) : timer;
      let res: Response;
      try {
        res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
      } catch (e) {
        if (req.signal?.aborted) return errorResult("PROVIDER_TIMEOUT", "the step was cancelled", false, req.model);
        if (timer.aborted) return errorResult("PROVIDER_TIMEOUT", `no answer from ${url} within ${timeoutMs} ms`, true, req.model);
        return errorResult("PROVIDER_UNAVAILABLE", `cannot reach ${url}: ${e instanceof Error ? e.message : String(e)}`, true, req.model);
      }
      let text: string;
      try {
        text = await res.text();
      } catch (e) {
        const timedOut = timer.aborted && !req.signal?.aborted;
        return errorResult("PROVIDER_TIMEOUT", timedOut ? `the answer from ${url} did not finish within ${timeoutMs} ms` : `reading the answer failed: ${e instanceof Error ? e.message : String(e)}`, timedOut, req.model);
      }
      if (!res.ok) return httpError(res.status, text, req.model);
      let json: RawCompletion;
      try {
        json = JSON.parse(text) as RawCompletion;
      } catch {
        return errorResult("PROVIDER_UNAVAILABLE", "the server answered with a body that is not JSON", false, req.model);
      }
      return handleCompletion(json, req, res.headers.get("x-request-id"));
    },
  };
}
