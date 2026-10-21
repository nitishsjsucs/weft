// OpenAI Responses provider (harness 11.2, SPEC 9.1). Stateless replay from Weft's own step log: store false,
// encrypted reasoning carried in every request, strict function tools, reasoning effort low, a prompt_cache_key per
// agent kind and routine, maxRetries 0 (the loop retries and reserves every attempt). Never /v1/chat/completions.
// Through AI Gateway (docs/cloudflare/design.md 5.1) only the base URL and headers change (gateway.ts); the response
// is read with .withResponse(), and a gateway cache HIT is reported so the loop settles that call at $0.
import OpenAI from "openai";
import type { Effort, HistoryItem, ModelProvider, ModelStepRequest, ModelStepResult, SpendLedger, Usage } from "@weft/contracts";
import { escapeTagText } from "../canonical";
import { gatewayCacheHit, type GatewayStepResult, type GatewayTransport } from "./gateway";

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Accepted for the frozen factory signature; the loop reserves and settles every attempt. */
  ledger?: SpendLedger;
  /** Strip ids from replayed non-reasoning items (smoke call 2 decides whether store:false needs it). */
  stripReplayIds?: boolean;
  /** For tests: a client with the same responses.create shape. */
  client?: Pick<OpenAI, "responses">;
  /** Experiment-only override (WEFT_EFFORT): when set, every request of this provider sends this effort instead of the
   * per-stage effort the caller asked for. Unset keeps today's per-stage defaults. */
  effort?: Effort;
  /** AI Gateway (gateway.ts openAiGatewayTransport): base URL, fetch and headers; the body is unchanged. */
  gateway?: GatewayTransport;
  /** The fetch the SDK uses without a gateway (tests; default the global fetch). */
  fetch?: typeof fetch;
}


export const OPENAI_FIXED = {
  tool_choice: "auto",
  parallel_tool_calls: true,
  store: false,
  include: ["reasoning.encrypted_content"],
  max_output_tokens: 8_000,
} as const;

type InputItem = Record<string, unknown>;

/** Render a notice with the run nonce (attrs.n) and sorted attributes. Its text is escaped so it cannot close itself. */
export function renderNotice(item: Extract<HistoryItem, { kind: "notice" }>): string {
  const attrs = Object.keys(item.attrs).sort().map((k) => ` ${k}="${escapeTagText(item.attrs[k] ?? "")}"`).join("");
  return `<weft_notice kind="${item.notice}"${attrs}>${escapeTagText(item.text)}</weft_notice>`;
}

function replayItems(native: unknown, stripIds: boolean): InputItem[] {
  const items = Array.isArray(native) ? (native as InputItem[]) : [];
  if (!stripIds) return items;
  return items.map((it) => {
    if (it.type === "reasoning") return it;
    const { id: _id, ...rest } = it;
    return rest;
  });
}

/** `provider`: whose replayed model items this request carries (a run is pinned to one provider). Workers AI runs
 * use the same builder with "workers_ai". */
export function historyToInput(history: HistoryItem[], stripIds = false, provider: string = "openai"): InputItem[] {
  const out: InputItem[] = [];
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
        if (h.provider !== provider) throw new Error(`a run is pinned to one provider; found ${h.provider} items in an ${provider} run`);
        out.push(...replayItems(h.native, stripIds));
        break;
      case "tool_outputs":
        for (const o of h.outputs) out.push({ type: "function_call_output", call_id: o.callId, output: o.output });
        break;
    }
  }
  return out;
}

/** The exact request body of harness 11.2. Snapshot-tested. */
export function buildResponsesRequest(req: ModelStepRequest, opts: { stripReplayIds?: boolean; effort?: Effort; provider?: string } = {}): Record<string, unknown> {
  const effort = opts.effort ?? req.effort;
  const tools = [...req.tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: true }));
  return {
    model: req.model,
    input: [{ role: "developer", content: req.frozenPrompt }, ...historyToInput(req.history, opts.stripReplayIds ?? false, opts.provider ?? "openai")],
    tools,
    tool_choice: OPENAI_FIXED.tool_choice,
    parallel_tool_calls: OPENAI_FIXED.parallel_tool_calls,
    reasoning: { effort },
    store: OPENAI_FIXED.store,
    include: [...OPENAI_FIXED.include],
    prompt_cache_key: req.cacheKey,
    max_output_tokens: req.maxOutputTokens,
  };
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
  output_tokens_details?: { reasoning_tokens?: number } | null;
}

export function mapUsage(u: RawUsage | null | undefined): Usage {
  return {
    input: u?.input_tokens ?? 0,
    cached: u?.input_tokens_details?.cached_tokens ?? 0,
    cacheWrite: u?.input_tokens_details?.cache_write_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    reasoning: u?.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

interface RawResponse {
  id?: string;
  status?: string;
  model?: string;
  incomplete_details?: { reason?: string } | null;
  output?: Record<string, unknown>[];
  usage?: RawUsage | null;
  _request_id?: string | null;
}

/** Response handling in the order of harness 11.2. A function call from a non-completed response never runs. */
export function handleResponse(res: RawResponse, model: string): ModelStepResult {
  const usage = mapUsage(res.usage);
  const output = Array.isArray(res.output) ? res.output : [];
  const base = { usage, servedBy: res.model ?? model, requestId: res._request_id ?? null, native: output };
  if (res.status === "incomplete") {
    return { ...base, stop: "incomplete", text: "", toolCalls: [], error: { code: "PROVIDER_UNAVAILABLE", message: `incomplete: ${res.incomplete_details?.reason ?? "unknown"}`, retryable: res.incomplete_details?.reason === "max_output_tokens" } };
  }
  if (res.status !== "completed") {
    return { ...base, stop: "error", text: "", toolCalls: [], error: { code: "PROVIDER_UNAVAILABLE", message: `response status ${res.status ?? "missing"}`, retryable: false } };
  }
  let text = "";
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content as Record<string, unknown>[]) {
      if (part.type === "refusal") {
        return { ...base, stop: "refusal", text: String(part.refusal ?? ""), toolCalls: [], refusal: { text: String(part.refusal ?? ""), category: null } };
      }
      if (part.type === "output_text") text += String(part.text ?? "");
    }
  }
  const toolCalls = output
    .filter((i) => i.type === "function_call")
    .map((i) => ({ callId: String(i.call_id), name: String(i.name), argumentsJson: String(i.arguments ?? "{}") }));
  return { ...base, stop: toolCalls.length ? "tool_calls" : "final", text, toolCalls };
}

/** The SDK error classes errorResult maps, for tests (boundary rule: only this file imports openai). */
export const OPENAI_ERRORS = {
  APIError: OpenAI.APIError, APIConnectionError: OpenAI.APIConnectionError, APIConnectionTimeoutError: OpenAI.APIConnectionTimeoutError,
  APIUserAbortError: OpenAI.APIUserAbortError,
} as const;

/** The error in `e`'s cause chain whose code is `code` (the SDK wraps a failed fetch in APIConnectionError), or null. */
function causeWith(e: unknown, code: string): Error | null {
  for (let cur: unknown = e, depth = 0; cur && depth < 6; depth++) {
    if ((cur as { code?: unknown }).code === code) return cur as Error;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

function errorResult(e: unknown, model: string): ModelStepResult {
  const empty = { stop: "error" as const, text: "", toolCalls: [], native: [], usage: mapUsage(null), servedBy: model, requestId: null };
  // A model call inside a database transaction is a programming error (docs/cloudflare/design.md 4.2): it surfaces
  // as IO_IN_TX instead of passing for a network error. A fetch past the invocation's budget is not retried.
  const inTx = causeWith(e, "IO_IN_TX");
  if (inTx) throw inTx;
  const budget = causeWith(e, "FETCH_BUDGET");
  if (budget) return { ...empty, error: { code: "PROVIDER_UNAVAILABLE", message: budget.message.slice(0, 300), retryable: false } };
  const msg = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
  const requestId = (e as { requestID?: string | null })?.requestID ?? null;
  const err = (code: NonNullable<ModelStepResult["error"]>["code"], retryable: boolean): ModelStepResult => ({ ...empty, requestId, error: { code, message: msg, retryable } });
  if (e instanceof OpenAI.APIUserAbortError) return err("PROVIDER_TIMEOUT", false);
  if (e instanceof OpenAI.APIConnectionTimeoutError) return err("PROVIDER_TIMEOUT", true);
  if (e instanceof OpenAI.APIConnectionError) return err("PROVIDER_UNAVAILABLE", true);
  if (e instanceof OpenAI.BadRequestError) return err("PROVIDER_REQUEST_INVALID", false);
  if (e instanceof OpenAI.AuthenticationError || e instanceof OpenAI.PermissionDeniedError || e instanceof OpenAI.NotFoundError) return err("PROVIDER_CONFIG", false);
  if (e instanceof OpenAI.RateLimitError || e instanceof OpenAI.InternalServerError) return err("PROVIDER_UNAVAILABLE", true);
  return err("PROVIDER_UNAVAILABLE", false);
}

/** The SDK client with harness settings: maxRetries 0 (the loop retries and reserves each attempt), 120 s timeout.
 * `transport`: the AI Gateway base URL, fetch and headers, or a plain fetch (tests). */
export function createOpenAIClient(apiKey: string, timeoutMs = 120_000, transport: { gateway?: GatewayTransport; fetch?: typeof fetch } = {}): OpenAI {
  const g = transport.gateway;
  return new OpenAI({
    apiKey, maxRetries: 0, timeout: timeoutMs,
    ...(g ? { baseURL: g.baseURL, fetch: g.fetch, defaultHeaders: g.defaultHeaders } : transport.fetch ? { fetch: transport.fetch } : {}),
  });
}

/** The response body and its HTTP headers: .withResponse() when the client has it (the SDK), the body alone otherwise. */
async function created(call: unknown): Promise<{ data: RawResponse; headers: Headers | null; requestId: string | null }> {
  const p = call as Promise<unknown> & { withResponse?: () => Promise<{ data: unknown; response: Response; request_id?: string | null }> };
  if (typeof p.withResponse === "function") {
    const r = await p.withResponse();
    const data = r.data as RawResponse;
    return { data, headers: r.response?.headers ?? null, requestId: r.request_id ?? data._request_id ?? null };
  }
  const data = (await p) as RawResponse;
  return { data, headers: null, requestId: data._request_id ?? null };
}

export function openaiProvider(opts: OpenAIProviderOptions): ModelProvider {
  const client = opts.client ?? createOpenAIClient(opts.apiKey, opts.timeoutMs, { gateway: opts.gateway, fetch: opts.fetch });
  return {
    id: "openai",
    model: opts.model,
    label: `OpenAI ${opts.model}`,
    live: true,
    async step(req): Promise<GatewayStepResult> {
      const body = buildResponsesRequest(req, { stripReplayIds: opts.stripReplayIds, effort: opts.effort });
      try {
        const headers = opts.gateway?.headersFor(req);
        const { data, headers: got, requestId } = await created(client.responses.create(body as never, { signal: req.signal, ...(headers ? { headers } : {}) }));
        const res = handleResponse({ ...data, _request_id: requestId }, req.model);
        return gatewayCacheHit(got) ? { ...res, gatewayCacheHit: true } : res;
      } catch (e) {
        return errorResult(e, req.model);
      }
    },
  };
}
