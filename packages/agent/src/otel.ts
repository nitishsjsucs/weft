// Telemetry (wave 4, docs/wave4.md section 3, research/wave4/phoenix.md). Owner: w4-telemetry.
// OpenTelemetry spans with OpenInference conventions, as a second projection of the facts the loop already writes to
// run_steps. The brain depends only on @opentelemetry/api and the OpenInference packages: no exporter, no URL, no
// process lifecycle (apps/api/src/telemetry.ts owns those). With no provider registered the API hands out no-op
// spans, so tests and ordinary runs pay nothing and send nothing; heavy attributes are built only while recording.
//
// Secrets: layer 1 is here. Every attribute value is built from Weft's redacted copies and passes through the injected
// redactor (apps/api/src/compose.ts passes the executor's Redactor.value), strings and JSON alike. Never captured:
// headers, client config, the prompt_cache_key value (only that it was set), encrypted reasoning, raw exceptions and
// stacks. The tracer is looked up per span because Phoenix's runExperiment swaps the global provider during a task.
import { context, ROOT_CONTEXT, trace, SpanStatusCode, type Attributes, type AttributeValue, type Context, type Span } from "@opentelemetry/api";
import { clearSession, clearUser, OITracer, setMetadata, setSession, setTags, setUser } from "@arizeai/openinference-core";
import { MimeType, OpenInferenceSpanKind, SemanticConventions as SC } from "@arizeai/openinference-semantic-conventions";
import {
  CHAT_TOOLS, SPAN_NAMES, traceSessionId, toolOutcomeCode, WEFT_ATTR,
  type AgentRunRow, type EvalTraceTags, type HistoryItem, type ModelStepRequest, type ModelStepResult, type RunStepRow, type RunTraceTags,
  type ToolOutcome, type TraceRedact, type TraceRunMeta, type WeftSpanKind,
} from "@weft/contracts";
import { escapeTagText, sha256 } from "./canonical";
import { stepCostUsd, type Prices } from "./cost";

let redact: TraceRedact = (v) => v;
/** Tokens the redactor removed (see learn below); a new redactor starts a new memory. */
const learned = new Set<string>();
/** apps/api/src/compose.ts injects the executor's Redactor (value redaction) here; the brain never imports the vault. */
export function setTraceRedactor(r: TraceRedact): void { redact = r; learned.clear(); }
/** Every span attribute value passes through this before it is set. */
export function traceRedact<T>(value: T): T { return redact(value); }

let tags: Partial<EvalTraceTags> | null = null;
/** Process-wide eval tags: the eval runner sets them before a trial and clears them after (trials run one at a time). */
export const runTraceTags: RunTraceTags = {
  set(next) { tags = next ? { ...next } : null; },
  current() { return tags ? { ...tags } : null; },
};

export const TRACER_NAME = "weft-agent";
export const AGENT_NAME = "weft-agent";

// ---------------------------------------------------------------------------------------------------- primitives

/**
 * Redaction memory. A pattern redaction keeps its context ("routing number [redacted]"), but code can later quote the
 * bare value without it: the grounding check lists unmatched numbers and the repair notice repeats them. So every
 * token the redactor removed is remembered (bounded) and removed wherever it shows up again in this process.
 */
const LEARN_MAX = 2000;
function learn(before: string, after: string): void {
  if (before === after || learned.size >= LEARN_MAX) return;
  for (const tok of before.match(/[A-Za-z0-9+/=_-]{6,}/g) ?? []) if (!after.includes(tok) && learned.size < LEARN_MAX) learned.add(tok);
}
function forget(s: string): string {
  let out = s;
  for (const t of learned) if (out.includes(t)) out = out.split(t).join("[redacted]");
  return out;
}

/** Redacted text. Values are redacted twice where JSON is involved: each string, then the serialized whole. */
const text = (s: string): string => {
  const r = redact(s);
  learn(s, r);
  return forget(r);
};
const json = (v: unknown): string => {
  let raw: string;
  let red: string;
  try {
    raw = JSON.stringify(v ?? null) ?? "null";
    red = redact(JSON.stringify(redact(v) ?? null) ?? "null");
  } catch { return "\"[unserializable]\""; }
  learn(raw, red);
  return forget(red);
};

/** The tracer, looked up on every span (never cached: runExperiment swaps the global provider). */
const tracer = () => new OITracer({ tracer: trace.getTracer(TRACER_NAME) });

function kindAttr(kind: WeftSpanKind): Attributes {
  return { [SC.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind[kind] };
}

/** Attributes with every string (and string array) value redacted; null and undefined values are dropped. */
function clean(a: Record<string, AttributeValue | null | undefined>): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(a)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") out[k] = text(v);
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === "string" ? text(x) : x)) as AttributeValue;
    else out[k] = v;
  }
  return out;
}

function inputAttrs(value: unknown): Attributes {
  return typeof value === "string" ? { [SC.INPUT_VALUE]: text(value), [SC.INPUT_MIME_TYPE]: MimeType.TEXT } : { [SC.INPUT_VALUE]: json(value), [SC.INPUT_MIME_TYPE]: MimeType.JSON };
}
function outputAttrs(value: unknown): Attributes {
  return typeof value === "string" ? { [SC.OUTPUT_VALUE]: text(value), [SC.OUTPUT_MIME_TYPE]: MimeType.TEXT } : { [SC.OUTPUT_VALUE]: json(value), [SC.OUTPUT_MIME_TYPE]: MimeType.JSON };
}

/** A redacted exception event: name and message only, never the stack (stacks can carry config). */
function recordError(span: Span, e: unknown): void {
  const name = e instanceof Error ? e.name : "Error";
  const message = text((e instanceof Error ? e.message : String(e)).slice(0, 500));
  span.addEvent("exception", { "exception.type": text(name), "exception.message": message });
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

function startSpan(name: string, kind: WeftSpanKind, attrs: Attributes, opts: { ctx?: Context; startTime?: number } = {}): Span {
  return tracer().startSpan(name, { attributes: { ...kindAttr(kind), ...attrs }, ...(opts.startTime === undefined ? {} : { startTime: opts.startTime }) }, opts.ctx ?? context.active());
}

/** Runs fn with a new span active (children nest under it); exceptions are recorded redacted and rethrown. */
async function active<T>(name: string, kind: WeftSpanKind, attrs: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  const span = startSpan(name, kind, attrs);
  try {
    return await context.with(trace.setSpan(context.active(), span), () => fn(span));
  } catch (e) {
    recordError(span, e);
    throw e;
  } finally {
    span.end();
  }
}

// ---------------------------------------------------------------------------------------------------- run metadata

export interface RunTraceInput {
  run: AgentRunRow;
  promptKind: "chat" | "routine" | "routine_draft";
  allowlist: readonly string[];
  routineId: string | null;
  /** The acting principal (the person for chat and attended runs); unattended routine runs use routine:<id>. */
  principal: string | null;
  /** The chat turn or the routine task the run was given (input.value of the AGENT span). */
  input: string;
  /** The frozen prompt, hashed into metadata.prompt_version. */
  prompt: string;
}

/** chat_can_propose: the labeled eval variant, or a chat run offered any tool beyond the read-only chat list. */
function chatCanPropose(i: RunTraceInput, t: Partial<EvalTraceTags> | null): boolean {
  if (t?.eval_variant === "chat_can_propose") return true;
  const reads = new Set<string>(CHAT_TOOLS);
  return i.promptKind === "chat" && i.allowlist.some((n) => !reads.has(n));
}

export function runMeta(i: RunTraceInput, t: Partial<EvalTraceTags> | null = runTraceTags.current()): TraceRunMeta {
  return {
    run_id: i.run.id, company_id: i.run.companyId, kind: i.promptKind, trigger: i.run.trigger, attended: i.run.attended,
    provider: i.run.provider, model: i.run.model, prompt_version: i.prompt ? sha256(i.prompt).slice(0, 12) : null, harness_sha: t?.harness_sha ?? null,
    routine_id: i.routineId, routine_run_id: i.run.routineRunId, golden_path: t?.golden_path ?? null,
    eval_task_id: t?.eval_task_id ?? null, eval_split: t?.eval_split ?? null, eval_variant: t?.eval_variant ?? null, eval_trial: t?.eval_trial ?? null,
    chat_can_propose: chatCanPropose(i, t),
  };
}

export function runTags(meta: TraceRunMeta): string[] {
  const out: string[] = [meta.kind === "routine" ? "routine" : meta.kind === "routine_draft" ? "routine_draft" : "chat"];
  if (meta.routine_id) out.push(meta.routine_id);
  if (!meta.attended) out.push("unattended");
  if (meta.eval_task_id) out.push("eval", meta.eval_task_id);
  if (meta.golden_path) out.push(meta.golden_path);
  if (meta.eval_variant) out.push(`variant:${meta.eval_variant}`);
  return out;
}

export function runUserId(i: RunTraceInput): string | null {
  if (!i.run.attended && i.routineId) return `routine:${i.routineId}`;
  return i.principal ?? (i.routineId ? `routine:${i.routineId}` : null);
}

// ---------------------------------------------------------------------------------------------------- LLM attributes

interface Msg { role: string; content?: string; name?: string; toolCallId?: string; toolCalls?: { id: string; name: string; arguments: string }[] }

function noticeText(h: Extract<HistoryItem, { kind: "notice" }>): string {
  const attrs = Object.keys(h.attrs).sort().map((k) => ` ${k}="${escapeTagText(h.attrs[k] ?? "")}"`).join("");
  return `<weft_notice kind="${h.notice}"${attrs}>${escapeTagText(h.text)}</weft_notice>`;
}

/**
 * One assistant message from a provider's stored output items: OpenAI Responses items, Claude content blocks, chat
 * completions messages or the scripted provider's record. Reasoning keeps only its summary text; encrypted reasoning
 * and signatures are never copied.
 */
export function nativeToMessage(native: unknown): Msg {
  const msg: Msg = { role: "assistant" };
  const texts: string[] = [];
  const calls: NonNullable<Msg["toolCalls"]> = [];
  const add = (it: Record<string, unknown>) => {
    switch (it.type) {
      case "message":
        for (const p of (Array.isArray(it.content) ? it.content : []) as Record<string, unknown>[]) {
          if (p.type === "output_text" && typeof p.text === "string") texts.push(p.text);
          if (p.type === "refusal" && typeof p.refusal === "string") texts.push(p.refusal);
        }
        return;
      case "function_call": calls.push({ id: String(it.call_id ?? ""), name: String(it.name ?? ""), arguments: String(it.arguments ?? "{}") }); return;
      case "reasoning": {
        const s = (Array.isArray(it.summary) ? it.summary : []) as { text?: string }[];
        const t = s.map((x) => x.text ?? "").filter(Boolean).join("\n");
        if (t) texts.push(`[reasoning] ${t}`);
        return;
      }
      case "text": if (typeof it.text === "string") texts.push(it.text); return;
      case "tool_use": calls.push({ id: String(it.id ?? ""), name: String(it.name ?? ""), arguments: JSON.stringify(it.input ?? {}) }); return;
      case "thinking": if (typeof it.thinking === "string" && it.thinking) texts.push(`[reasoning] ${it.thinking}`); return;
      default:
        if (it.role === "assistant") {
          if (typeof it.content === "string") texts.push(it.content);
          for (const c of (Array.isArray(it.tool_calls) ? it.tool_calls : []) as { id?: string; function?: { name?: string; arguments?: string } }[]) {
            calls.push({ id: String(c.id ?? ""), name: String(c.function?.name ?? ""), arguments: String(c.function?.arguments ?? "{}") });
          }
        }
    }
  };
  if (Array.isArray(native)) for (const it of native) { if (it && typeof it === "object") add(it as Record<string, unknown>); }
  else if (native && typeof native === "object") {
    const n = native as { scripted?: boolean; text?: string; toolCalls?: { callId: string; name: string; argumentsJson: string }[]; output?: unknown[] };
    if (n.scripted) {
      if (n.text) texts.push(n.text);
      for (const c of n.toolCalls ?? []) calls.push({ id: c.callId, name: c.name, arguments: c.argumentsJson });
      for (const o of (n.output ?? []) as Record<string, unknown>[]) if (o.type === "text" && typeof o.text === "string" && o.text !== n.text) texts.push(o.text);
    } else add(native as Record<string, unknown>);
  }
  if (texts.length) msg.content = texts.join("\n");
  if (calls.length) msg.toolCalls = calls;
  return msg;
}

/** The request as messages: the frozen prompt, then the history the provider replays, in order. */
export function requestMessages(req: Pick<ModelStepRequest, "frozenPrompt" | "history">): Msg[] {
  const out: Msg[] = [{ role: "system", content: req.frozenPrompt }];
  for (const h of req.history) {
    switch (h.kind) {
      case "context": case "user": out.push({ role: "user", content: h.text }); break;
      case "notice": out.push({ role: "user", content: noticeText(h) }); break;
      case "model": out.push(nativeToMessage(h.native)); break;
      case "tool_outputs": for (const o of h.outputs) out.push({ role: "tool", toolCallId: o.callId, name: o.name, content: o.output }); break;
    }
  }
  return out;
}

function messageAttrs(prefix: string, msgs: Msg[]): Attributes {
  const a: Attributes = {};
  msgs.forEach((m, i) => {
    const p = `${prefix}.${i}.`;
    a[p + SC.MESSAGE_ROLE] = m.role;
    if (m.content !== undefined) a[p + SC.MESSAGE_CONTENT] = text(m.content);
    if (m.name) a[p + SC.MESSAGE_NAME] = m.name;
    if (m.toolCallId) a[p + SC.MESSAGE_TOOL_CALL_ID] = m.toolCallId;
    (m.toolCalls ?? []).forEach((c, j) => {
      const q = `${p}${SC.MESSAGE_TOOL_CALLS}.${j}.`;
      a[q + SC.TOOL_CALL_ID] = c.id;
      a[q + SC.TOOL_CALL_FUNCTION_NAME] = c.name;
      a[q + SC.TOOL_CALL_FUNCTION_ARGUMENTS_JSON] = text(c.arguments);
    });
  });
  return a;
}

const LLM_PROVIDER: Record<string, string> = { openai: "openai", claude: "anthropic", openai_compat: "openai_compat", scripted: "weft_scripted" };

/** Request side of an LLM span: model, invocation parameters (never the key, headers or the cache key value), tools, messages. */
export function llmRequestAttrs(req: ModelStepRequest, providerId: string): Attributes {
  const provider = LLM_PROVIDER[providerId] ?? providerId;
  const a: Attributes = {
    [SC.LLM_PROVIDER]: provider, [SC.LLM_SYSTEM]: provider, [SC.LLM_MODEL_NAME]: req.model, [SC.LLM_REQUEST_MODEL_NAME]: req.model,
    [SC.LLM_INVOCATION_PARAMETERS]: json({
      model: req.model, reasoning: { effort: req.effort }, max_output_tokens: req.maxOutputTokens, tool_choice: req.toolChoice.mode,
      parallel_tool_calls: true, store: false, prompt_cache_key_set: Boolean(req.cacheKey), tools: req.tools.length,
    }),
    ...messageAttrs(SC.LLM_INPUT_MESSAGES, requestMessages(req)),
    ...inputAttrs({ messages: req.history.length + 1, tools: req.tools.map((t) => t.name) }),
  };
  req.tools.forEach((t, i) => {
    a[`${SC.LLM_TOOLS}.${i}.${SC.TOOL_JSON_SCHEMA}`] = json({ type: "function", name: t.name, description: t.description, parameters: t.parameters });
  });
  return a;
}

/** Cost split the way cost.ts prices a step; the total is the ledger's own figure (micros), so the two always agree. */
export function llmCostAttrs(u: ModelStepResult["usage"], prices: Prices, costUsdMicros: number): Attributes {
  if (costUsdMicros === 0) return { [SC.LLM_COST_TOTAL]: 0, [SC.LLM_COST_PROMPT]: 0, [SC.LLM_COST_COMPLETION]: 0 };
  const writes = prices.cacheWritePerM === undefined ? 0 : Math.min(u.cacheWrite, Math.max(0, u.input - u.cached));
  const fresh = ((u.input - u.cached - writes) * prices.inPerM) / 1e6;
  const write = (writes * (prices.cacheWritePerM ?? prices.inPerM)) / 1e6;
  const read = (u.cached * prices.cachedPerM) / 1e6;
  const completion = (u.output * prices.outPerM) / 1e6;
  return {
    [SC.LLM_COST_TOTAL]: costUsdMicros / 1e6, [SC.LLM_COST_PROMPT]: fresh + write + read, [SC.LLM_COST_COMPLETION]: completion,
    [SC.LLM_COST_INPUT]: fresh, [SC.LLM_COST_PROMPT_DETAILS_CACHE_READ]: read, [SC.LLM_COST_PROMPT_DETAILS_CACHE_WRITE]: write,
    [SC.LLM_COST_COMPLETION_DETAILS_REASONING]: (u.reasoning * prices.outPerM) / 1e6,
    "weft.cost.formula_usd": stepCostUsd(u, prices),
  };
}

/** Response side of an LLM span: output message, finish reason, tokens including cached and reasoning, cost, ids. */
export function llmResultAttrs(res: ModelStepResult, prices: Prices, costUsdMicros: number): Attributes {
  const u = res.usage;
  const out: Msg = { role: "assistant", ...(res.text ? { content: res.text } : {}), ...(res.toolCalls.length ? { toolCalls: res.toolCalls.map((c) => ({ id: c.callId, name: c.name, arguments: c.argumentsJson })) } : {}) };
  return {
    [SC.LLM_RESPONSE_MODEL_NAME]: res.servedBy, [SC.LLM_FINISH_REASON]: res.stop,
    [SC.LLM_TOKEN_COUNT_PROMPT]: u.input, [SC.LLM_TOKEN_COUNT_COMPLETION]: u.output, [SC.LLM_TOKEN_COUNT_TOTAL]: u.input + u.output,
    [SC.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ]: u.cached, [SC.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE]: u.cacheWrite,
    [SC.LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING]: u.reasoning,
    ...llmCostAttrs(u, prices, costUsdMicros),
    ...messageAttrs(SC.LLM_OUTPUT_MESSAGES, [out]),
    ...outputAttrs(res.toolCalls.length ? { text: res.text, toolCalls: res.toolCalls.map((c) => c.name) } : res.text),
    ...clean({ [WEFT_ATTR.requestId]: res.requestId, "weft.error_code": res.error?.code ?? null, "weft.error_message": res.error?.message ?? null }),
  };
}

// ---------------------------------------------------------------------------------------------------- the loop's tracer

/** A TOOL span: active while the executor runs (child runs nest under it), ended once its run_steps row exists. */
export interface ToolSpanHandle {
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** The outcome as the model sees it (already redacted by the executor); `threw` marks an executor exception. */
  outcome(outcome: ToolOutcome, args: unknown, threw?: boolean): void;
  end(row: Pick<RunStepRow, "n"> | null): void;
}

/** A CHAIN span the loop opens and closes itself (model, dispatch), so its control flow stays as it was. */
export interface StageHandle {
  readonly ctx: Context;
  set(attrs: Record<string, AttributeValue | null | undefined>): void;
  /** Marks the stage failed (a provider error); a refusal never does. */
  fail(message: string): void;
  end(): void;
}

export interface LoopTrace {
  readonly recording: boolean;
  /** A CHAIN span for a stage with no single row (model attempt, dispatch batch). */
  begin(name: string, attrs: Record<string, AttributeValue | null | undefined>): StageHandle;
  /** A CHAIN span that is active around fn (terminal, the post check of a chat answer). */
  stage<T>(name: string, attrs: Record<string, AttributeValue | null | undefined>, fn: (s: StageHandle) => Promise<T>): Promise<T>;
  /** A CHAIN span for a row written after the fact (admission, assemble, post notices and recitation). */
  row(row: RunStepRow): void;
  /** An LLM span around one provider call, under the model stage. */
  llm(parent: StageHandle, req: ModelStepRequest, providerId: string, fn: () => Promise<ModelStepResult>): Promise<ModelStepResult>;
  /** Usage, cost and output on the LLM span of the last call, which then ends. */
  llmSettled(res: ModelStepResult, prices: Prices, costUsdMicros: number): void;
  tool(parent: StageHandle, name: string, callId: string): ToolSpanHandle;
  /** A GUARDRAIL span (grounding or taint) under the active stage. */
  guard<T>(kind: "grounding" | "taint", input: unknown, fn: () => T | Promise<T>, describe: (r: T) => Record<string, AttributeValue | null | undefined>): Promise<T>;
}

/** Wall-clock span start for a row: now minus the stage's own measured time. */
function rowStart(ms: number): number {
  return Date.now() - Math.max(0, Math.round(ms));
}

function rowMs(s: RunStepRow): number {
  const t = s.timings;
  const r = (s.result ?? {}) as { ms?: number };
  switch (s.stage) {
    case "admission": return t?.admissionMs ?? 0;
    case "assemble": return t?.assembleMs ?? 0;
    default: return r.ms ?? 0;
  }
}

function rowAttrs(s: RunStepRow): Attributes {
  const r = (s.result ?? {}) as Record<string, unknown>;
  const base = clean({ [WEFT_ATTR.stepN]: s.n, [WEFT_ATTR.attempt]: s.attempt, "weft.kind": s.kind, "weft.row_outcome": s.outcome, [WEFT_ATTR.prefixHash]: s.prefixHash });
  if (s.stage === "admission") {
    return { ...base, ...outputAttrs(r), ...clean({ [WEFT_ATTR.outcome]: s.outcome, [WEFT_ATTR.refusalCode]: s.outcome?.startsWith("refused:") ? s.outcome.slice(8) : null, "weft.reserve_micros": typeof r.reserveMicros === "number" ? r.reserveMicros : null }) };
  }
  if (s.stage === "assemble") return { ...base, ...outputAttrs(r), ...clean({ "weft.items": typeof r.items === "number" ? r.items : null, "weft.est_input_tokens": typeof r.estInputTokens === "number" ? r.estInputTokens : null }) };
  if (s.kind === "notice") return { ...base, ...outputAttrs(r), ...clean({ "weft.notice": String(r.notice ?? ""), "weft.notice_code": String((r.attrs as { code?: string } | undefined)?.code ?? "") }) };
  if (s.kind === "recite") return { ...base, ...outputAttrs(String(r.plan ?? "")), ...clean({ "weft.batch_dispatch_ms": typeof r.batchDispatchMs === "number" ? r.batchDispatchMs : null }) };
  return { ...base, ...outputAttrs(r) };
}

const NOOP_SPAN = trace.wrapSpanContext({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 });

function handleOf(span: Span): StageHandle {
  return {
    ctx: trace.setSpan(context.active(), span),
    set(attrs) { if (span.isRecording()) span.setAttributes(clean(attrs)); },
    fail(message) { span.setStatus({ code: SpanStatusCode.ERROR, message: text(message.slice(0, 300)) }); },
    end() { span.end(); },
  };
}

function makeLoopTrace(agent: Span): LoopTrace {
  let lastLlm: Span = NOOP_SPAN;
  const recording = agent.isRecording();
  return {
    recording,
    begin: (name, attrs) => handleOf(startSpan(name, "CHAIN", clean(attrs))),
    async stage(name, attrs, fn) {
      const span = startSpan(name, "CHAIN", clean(attrs));
      const h = handleOf(span);
      try {
        return await context.with(h.ctx, () => fn(h));
      } catch (e) {
        recordError(span, e);
        throw e;
      } finally {
        span.end();
      }
    },
    row(row) {
      if (!recording) return;
      const name = row.stage === "post" ? SPAN_NAMES.post : row.stage === "admission" ? SPAN_NAMES.admission : row.stage === "assemble" ? SPAN_NAMES.assemble : row.stage;
      const span = startSpan(name, "CHAIN", rowAttrs(row), { startTime: rowStart(rowMs(row)) });
      if (row.outcome === "error" || row.kind === "error") span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    },
    async llm(parent, req, providerId, fn) {
      const span = startSpan(SPAN_NAMES.llm, "LLM", {}, { ctx: parent.ctx });
      lastLlm = span;
      if (span.isRecording()) span.setAttributes(llmRequestAttrs(req, providerId));
      try {
        const res = await context.with(trace.setSpan(parent.ctx, span), fn);
        if (res.stop === "error") span.setStatus({ code: SpanStatusCode.ERROR, message: text(`${res.error?.code ?? "error"}: ${res.error?.message ?? ""}`.slice(0, 300)) });
        return res;
      } catch (e) {
        recordError(span, e);
        span.end();
        lastLlm = NOOP_SPAN;
        throw e;
      }
    },
    llmSettled(res, prices, costUsdMicros) {
      const span = lastLlm;
      lastLlm = NOOP_SPAN;
      if (span.isRecording()) span.setAttributes(llmResultAttrs(res, prices, costUsdMicros));
      span.end();
    },
    tool(parent, name, callId) {
      const span = startSpan(name, "TOOL", { [SC.TOOL_NAME]: name, [SC.TOOL_ID]: callId }, { ctx: parent.ctx });
      let ended: number | null = null;
      return {
        run: (fn) => context.with(trace.setSpan(parent.ctx, span), fn),
        outcome(o, args, threw = false) {
          ended = Date.now();
          if (!span.isRecording()) return;
          const code = threw ? "error" : toolOutcomeCode(o.ok ? (o.status === "pending_approval" ? { ok: true, proposalId: o.proposalId } : { ok: true, status: o.status }) : { ok: false, refusal: o.refusal });
          span.setAttributes({
            [SC.TOOL_PARAMETERS]: json(args ?? {}), ...inputAttrs(args ?? {}), ...outputAttrs(o),
            ...clean({
              [WEFT_ATTR.outcome]: code, [WEFT_ATTR.refusalCode]: o.ok ? null : o.refusal.code,
              [WEFT_ATTR.proposalId]: o.ok && o.status === "pending_approval" ? o.proposalId : null, [WEFT_ATTR.tainted]: o.tainted,
            }),
          });
          // A refusal is the harness working: status stays UNSET. ERROR is for exceptions only.
          if (threw) span.setStatus({ code: SpanStatusCode.ERROR, message: o.ok ? "error" : text(o.refusal.message.slice(0, 300)) });
          else if (o.ok) span.setStatus({ code: SpanStatusCode.OK });
        },
        end(row) {
          if (row) span.setAttribute(WEFT_ATTR.stepN, row.n);
          span.end(ended ?? undefined);
        },
      };
    },
    async guard(kind, input, fn, describe) {
      const span = startSpan(kind === "grounding" ? SPAN_NAMES.grounding : SPAN_NAMES.taint, "GUARDRAIL", { [WEFT_ATTR.guardrail]: kind, ...inputAttrs(input) });
      try {
        const r = await context.with(trace.setSpan(context.active(), span), fn);
        if (span.isRecording()) span.setAttributes({ ...outputAttrs(r), ...clean(describe(r)) });
        return r;
      } catch (e) {
        recordError(span, e);
        throw e;
      } finally {
        span.end();
      }
    },
  };
}

/** The no-op loop tracer for runs that are not traced at all (a missing run or context step: the loop throws first). */
export const NOOP_LOOP_TRACE: LoopTrace = makeLoopTrace(NOOP_SPAN);

/**
 * One AGENT span per runLoop call (a run woken after an approval is a second segment, joined on weft.run_id and
 * session.id). session.id, user.id, metadata and tags are set in context once, so every child span carries them.
 */
export async function traceRun(i: RunTraceInput, fn: (t: LoopTrace) => Promise<AgentRunRow>): Promise<AgentRunRow> {
  const meta = runMeta(i);
  // A child run (task agent) nests under the dispatching TOOL span; every other run is its own trace, even when an
  // event from another run's tool call started it.
  let ctx = i.run.parentRunId ? clearUser(clearSession(context.active())) : ROOT_CONTEXT;
  const session = traceSessionId({ threadId: i.run.threadId, routineRunId: i.run.routineRunId }, meta.eval_task_id);
  if (session) ctx = setSession(ctx, { sessionId: text(session) });
  const user = runUserId(i);
  if (user) ctx = setUser(ctx, { userId: text(user) });
  ctx = setTags(setMetadata(ctx, redact(meta) as unknown as Record<string, unknown>), runTags(meta).map(text));
  return context.with(ctx, async () => {
    const span = startSpan(SPAN_NAMES.run, "AGENT", { [SC.AGENT_NAME]: AGENT_NAME, [WEFT_ATTR.runId]: i.run.id, ...inputAttrs(i.input) });
    try {
      const row = await context.with(trace.setSpan(context.active(), span), () => fn(makeLoopTrace(span)));
      if (span.isRecording()) {
        span.setAttributes({
          ...outputAttrs(row.summary ?? ""),
          ...clean({
            "weft.status": row.status, [WEFT_ATTR.terminalReason]: row.terminalReason, [WEFT_ATTR.tainted]: row.tainted, "weft.tainted_by": row.taintedBy,
            "weft.steps_used": row.stepsUsed, "weft.cost_usd": row.costUsdMicros / 1e6,
            [SC.LLM_TOKEN_COUNT_PROMPT]: row.tokens.input, [SC.LLM_TOKEN_COUNT_COMPLETION]: row.tokens.output,
          }),
        });
        if (row.status === "failed") span.setStatus({ code: SpanStatusCode.ERROR, message: row.terminalReason ?? "failed" });
        else if (row.status === "done" || row.status === "waiting") span.setStatus({ code: SpanStatusCode.OK });
      }
      return row;
    } catch (e) {
      recordError(span, e);
      throw e;
    } finally {
      span.end();
    }
  });
}

/** The request a run was given: the <request> of a chat pack, else the routine's name and trigger, else the pack. */
export function runInputOf(packText: string): string {
  const req = /<request>([\s\S]*?)<\/request>/.exec(packText);
  if (req) return req[1]!;
  const routine = /^routine: .*$/m.exec(packText);
  const trig = /<trigger>[\s\S]*?<\/trigger>/.exec(packText);
  if (routine || trig) return [routine?.[0], trig?.[0]].filter(Boolean).join("\n");
  return packText.slice(0, 4000);
}
