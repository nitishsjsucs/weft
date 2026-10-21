// The Workers AI switch (docs/cloudflare/design.md 5.2): provider id `workers_ai`, model `@cf/openai/gpt-oss-120b`,
// badge "Workers AI gpt-oss-120b". The same Responses request builder and parser as the OpenAI provider, over a
// transport that calls `env.AI.run(model, body, { gateway: { id, metadata } })` (non-streaming; Weft does not stream),
// or, for the offline side by side on Node, the gateway's Workers AI REST path with a narrow Workers AI token.
// `live: true`, so the run and day caps apply; the ledger prices it in USD equivalents of neurons (cost.ts) and the
// hosted ledger also counts the neurons against the neuron day cap and the agent's share. Portable.
//
// The body drops what only OpenAI's hosted Responses API accepts (`store`, `include` for encrypted reasoning and
// `prompt_cache_key`) and carries the model as the run's first argument. Replayed items carry no ids: nothing is
// stored server side, so an id would name nothing. Both choices are checked by the first deployed Workers AI run
// (cf7 step 8); the request builder is otherwise the OpenAI one, byte for byte.
import type { HistoryItem, ModelStepRequest, ModelStepResult } from "@weft/contracts";
import {
  WORKERS_AI_LABEL, WORKERS_AI_MODEL, WORKERS_AI_PROVIDER_ID, type FetchCounter, type HostedModelProvider, type WorkersAiBindingLike,
} from "../../../contracts/src/ext/cf-agent";
import { guardedFetch, type TxGuardLike } from "../run-host";
import { aigKindOf, aigMetadataHeader, type AigWorld } from "./gateway";
import { buildResponsesRequest, handleResponse, mapUsage } from "./openai";

/** One model call: the run's model, the Responses-shaped body, and who it is for (gateway metadata). */
export interface WorkersAiTransport {
  readonly kind: "binding" | "rest";
  run(model: string, body: Record<string, unknown>, meta: { runId: string; cacheKey: string }, signal?: AbortSignal): Promise<unknown>;
}

/** Drops replayed item ids (nothing is stored server side) and keeps everything else as the model returned it. */
function withoutIds(history: HistoryItem[]): HistoryItem[] {
  return history.map((h) => {
    if (h.kind !== "model" || !Array.isArray(h.native)) return h;
    return { ...h, native: (h.native as Record<string, unknown>[]).map((it) => { const { id: _id, ...rest } = it; return rest; }) };
  });
}

/** The body env.AI.run receives: the OpenAI builder's request without `model`, `store`, `include` and `prompt_cache_key`. */
export function workersAiBody(req: ModelStepRequest): Record<string, unknown> {
  const full = buildResponsesRequest({ ...req, history: withoutIds(req.history) }, { provider: WORKERS_AI_PROVIDER_ID });
  const { model: _model, store: _store, include: _include, prompt_cache_key: _key, ...body } = full;
  return body;
}

interface RawLegacy { response?: unknown; tool_calls?: { id?: string; name?: string; arguments?: unknown }[]; usage?: Record<string, number> | null }

/**
 * The binding's output as the OpenAI parser reads it. Responses-shaped output (what the probe measured) passes
 * through, with `status` taken as completed when the binding leaves it out; the older `{ response, tool_calls, usage }`
 * shape is mapped onto output items. A REST answer arrives in `{ result, success }` and is unwrapped first.
 */
export function normalizeWorkersAiOutput(raw: unknown): Record<string, unknown> {
  let r = raw as Record<string, unknown> | null;
  if (r && typeof r === "object" && "result" in r && ("success" in r || "errors" in r)) r = (r.result ?? null) as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return { status: "failed", output: [] };
  const usage = (r.usage ?? null) as Record<string, number> | null;
  const u = usage ? { input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0, output_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
    input_tokens_details: (usage as { input_tokens_details?: unknown }).input_tokens_details ?? null, output_tokens_details: (usage as { output_tokens_details?: unknown }).output_tokens_details ?? null } : null;
  if (Array.isArray(r.output)) return { ...r, status: typeof r.status === "string" ? r.status : "completed", usage: u };
  const legacy = r as RawLegacy;
  const output: Record<string, unknown>[] = [];
  if (typeof legacy.response === "string" && legacy.response) output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: legacy.response }] });
  for (const [i, c] of (legacy.tool_calls ?? []).entries()) {
    output.push({ type: "function_call", call_id: c.id ?? `call_wai_${i + 1}`, name: String(c.name ?? ""), arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}) });
  }
  return { status: "completed", output, usage: u };
}

function errorOf(e: unknown, model: string, timedOut: boolean): ModelStepResult {
  const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  const base = { stop: "error" as const, text: "", toolCalls: [], native: [], usage: mapUsage(null), servedBy: model, requestId: null };
  // As the OpenAI provider maps an aborted request; the loop marks it retryable when its own step timer fired.
  if (timedOut || (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError"))) return { ...base, error: { code: "PROVIDER_TIMEOUT", message: msg, retryable: false } };
  if ((e as { code?: unknown } | null)?.code === "FETCH_BUDGET") return { ...base, error: { code: "PROVIDER_UNAVAILABLE", message: msg, retryable: false } };
  // The account's daily free allocation is spent (Workers AI error 4006): retrying the same day cannot help.
  if (/\b4006\b|daily free allocation|neurons/i.test(msg)) return { ...base, error: { code: "PROVIDER_UNAVAILABLE", message: msg, retryable: false } };
  if (/\b(429|3040|3036)\b|rate limit|capacity|temporar|overloaded|\b5\d\d\b/i.test(msg)) return { ...base, error: { code: "PROVIDER_UNAVAILABLE", message: msg, retryable: true } };
  if (/\b(400|5006|5007)\b|invalid|schema|required properties/i.test(msg)) return { ...base, error: { code: "PROVIDER_REQUEST_INVALID", message: msg, retryable: false } };
  if (/\b(401|403|10000)\b|unauthori[sz]ed|forbidden|authentication/i.test(msg)) return { ...base, error: { code: "PROVIDER_CONFIG", message: msg, retryable: false } };
  return { ...base, error: { code: "PROVIDER_UNAVAILABLE", message: msg, retryable: false } };
}

/** Resolves with fn's value, or rejects when the step's signal fires first (the binding takes no signal). */
function raced<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return fn();
  if (signal.aborted) return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error("aborted before Workers AI answered"), { name: "AbortError" }));
    signal.addEventListener("abort", onAbort, { once: true });
    fn().then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); }, (e: unknown) => { signal.removeEventListener("abort", onAbort); reject(e); });
  });
}

export interface WorkersAiProviderOptions {
  transport: WorkersAiTransport;
  model?: string;
}

export function workersAiProvider(opts: WorkersAiProviderOptions): HostedModelProvider {
  const model = opts.model ?? WORKERS_AI_MODEL;
  return {
    id: WORKERS_AI_PROVIDER_ID,
    model,
    label: model === WORKERS_AI_MODEL ? WORKERS_AI_LABEL : `Workers AI ${model}`,
    live: true,
    async step(req): Promise<ModelStepResult> {
      const body = workersAiBody(req);
      try {
        const raw = await raced(() => opts.transport.run(model, body, { runId: req.runId, cacheKey: req.cacheKey }, req.signal), req.signal);
        return handleResponse(normalizeWorkersAiOutput(raw) as never, model);
      } catch (e) {
        // A model call inside a database transaction is a programming error (IO_IN_TX): it surfaces, never retried.
        if ((e as { code?: unknown } | null)?.code === "IO_IN_TX") throw e;
        return errorOf(e, model, req.signal?.aborted === true);
      }
    },
  };
}

// Transports -------------------------------------------------------------------------------------------------------

export interface BindingTransportOptions {
  /** The AI Gateway the call goes through (its name: the secret WEFT_AIG_GATEWAY); absent, the call goes direct. */
  gateway?: string | null;
  world?: () => AigWorld | null;
  guard?: TxGuardLike | null;
}

/** `env.AI.run(model, body, { gateway: { id, metadata } })`. It counts against the 1,000 Cloudflare-service
 * subrequests, not the 50 external ones, so it is not counted as a fetch; it still refuses inside a transaction. */
export function workersAiBindingTransport(ai: WorkersAiBindingLike, o: BindingTransportOptions = {}): WorkersAiTransport {
  return {
    kind: "binding",
    async run(model, body, meta) {
      o.guard?.assertNotInTx("workers_ai binding call");
      const w = o.world?.() ?? null;
      const metadata = JSON.parse(aigMetadataHeader({ ...(w ? { slot: w.slot, gen: w.gen, visitor: w.visitor } : {}), run: meta.runId || null, kind: aigKindOf(meta.cacheKey) })) as Record<string, string | number>;
      return ai.run(model, body, o.gateway ? { gateway: { id: o.gateway, metadata } } : undefined);
    },
  };
}

export interface RestTransportOptions {
  accountId: string;
  gateway: string;
  /** A narrow Workers AI token Nitish creates (WEFT_WORKERS_AI_TOKEN); never logged. */
  token: string;
  /** Sent as cf-aig-authorization when the gateway is authenticated. */
  gatewayToken?: string | null;
  fetch?: typeof fetch;
  counter?: FetchCounter | null;
  guard?: TxGuardLike | null;
}

/** The gateway's Workers AI REST path, for evals on Node: POST /v1/<account>/<gateway>/workers-ai/<model>. */
export function workersAiRestTransport(o: RestTransportOptions): WorkersAiTransport {
  const base = o.fetch ?? ((input, init) => fetch(input, init));
  const f = guardedFetch(base, { what: "workers_ai REST fetch", guard: o.guard, counter: o.counter });
  return {
    kind: "rest",
    async run(model, body, meta, signal) {
      const url = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(o.accountId)}/${encodeURIComponent(o.gateway)}/workers-ai/${model}`;
      const headers: Record<string, string> = {
        authorization: `Bearer ${o.token}`, "content-type": "application/json",
        "cf-aig-metadata": aigMetadataHeader({ run: meta.runId || null, kind: aigKindOf(meta.cacheKey) }),
        ...(o.gatewayToken ? { "cf-aig-authorization": `Bearer ${o.gatewayToken}` } : {}),
      };
      const res = await f(url, { method: "POST", headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
      const text = await res.text();
      if (!res.ok) throw new Error(`Workers AI answered HTTP ${res.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text) as unknown;
    },
  };
}
