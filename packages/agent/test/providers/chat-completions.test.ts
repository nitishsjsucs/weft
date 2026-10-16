// The local chat-completions provider against a fake OpenAI-compatible server on an ephemeral port (closed in
// afterAll). Covers the request body, tool calls, strict JSON arguments, an invalid argument answered with an
// INVALID_INPUT tool error inside a real loop run, HTTP errors and a timeout.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HistoryItem, ModelStepRequest, PrecheckResult, RoutineDef, RoutineRun, SimClock, ToolOutcome } from "@weft/contracts";
import { closeDb, migrate, openDb } from "@weft/db";
import { createAgentRuntime, createProvider, createSpendLedger } from "../../src/index";
import {
  buildChatCompletionsRequest, chatCompletionsProvider, chatCompletionsUrl, compactFromDescription, handleCompletion, LOCAL_DEFAULT_MODELS, parseToolArguments, stripThinking,
} from "../../src/providers/chat-completions";
import { createFakeExecutor } from "../fake-executor";

type Reply = { status?: number; body?: unknown; delayMs?: number; raw?: string };
const received: Record<string, unknown>[] = [];
let replies: Reply[] = [];
let server: Server;
let baseUrl = "";
const dir = mkdtempSync(join(tmpdir(), "weft-local-"));

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (req.url !== "/v1/chat/completions" || req.method !== "POST") { res.writeHead(404).end("not found"); return; }
      received.push(JSON.parse(data) as Record<string, unknown>);
      const r = replies.shift() ?? { status: 500, body: { error: "no scripted reply" } };
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(r.status ?? 200, { "content-type": "application/json", "x-request-id": `req_${received.length}` });
        res.end(r.raw ?? JSON.stringify(r.body));
      };
      if (r.delayMs) setTimeout(send, r.delayMs).unref(); else send();
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((ok) => server.close(() => ok()));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { received.length = 0; replies = []; });

const completion = (message: Record<string, unknown>, finish = "stop", usage = { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } }) => ({
  id: "chatcmpl-1", object: "chat.completion", model: "Qwen3-1.7B-Q4_0", choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }], usage,
});
const toolCall = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: args } });

const tools = [
  { name: "people__search", description: "Search people by name, state or department. Returns at most 20 rows with ids. Example: { \"q\": \"Ada\" }", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false } },
  { name: "comms__post_update", description: "Post a one-line progress update.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
];
const req = (history: HistoryItem[], extra: Partial<ModelStepRequest> = {}): ModelStepRequest => ({
  runId: "run_0001", agentKind: "main", model: LOCAL_DEFAULT_MODELS.llama, frozenPrompt: "FROZEN", toolChoice: { mode: "auto" }, history, tools,
  effort: "low", maxOutputTokens: 8000, cacheKey: "weft:main:chat:cmp_larkspur", ...extra,
});
const provider = (timeoutMs?: number) => chatCompletionsProvider({ mode: "llama", config: { baseUrl, model: LOCAL_DEFAULT_MODELS.llama, reasoning: "off", strictJson: true }, timeoutMs });

describe("factory: WEFT_LLM=mlx and llama", () => {
  const ledger = createSpendLedger({ dir: join(dir, "spend") });
  it("acceptance: both build the chat-completions provider from WEFT_LOCAL_BASE_URL", () => {
    const env = { VITEST: "true", WEFT_LIVE_OPENAI: "1", WEFT_LOCAL_BASE_URL: baseUrl };
    expect(createProvider({ env: { ...env, WEFT_LLM: "mlx" }, ledger, testMode: true })).toMatchObject({ id: "openai_compat", model: "mlx-community/Qwen3.6-27B-4bit", label: "Local Qwen3.6-27B", live: false });
    expect(createProvider({ env: { ...env, WEFT_LLM: "llama" }, ledger, testMode: true })).toMatchObject({ id: "openai_compat", model: "Qwen3-1.7B-Q4_0", label: "Local Qwen3-1.7B (smoke)", live: false });
    expect(createProvider({ env: { ...env, WEFT_LLM: "llama", WEFT_LOCAL_MODEL: "qwen3-0.6b" }, ledger, testMode: true })).toMatchObject({ model: "qwen3-0.6b", label: "Local qwen3-0.6b" });
  });
  it("acceptance: LIVE_PROVIDER_IN_TEST still guards tests; PROVIDER_CONFIG names the missing variable", () => {
    for (const w of ["mlx", "llama"]) {
      expect(() => createProvider({ env: { VITEST: "true", WEFT_LLM: w, WEFT_LOCAL_BASE_URL: baseUrl }, ledger, testMode: false })).toThrow(/LIVE_PROVIDER_IN_TEST/);
      expect(() => createProvider({ env: { WEFT_LLM: w }, ledger, testMode: false })).toThrow(/PROVIDER_CONFIG: WEFT_LOCAL_BASE_URL is not set/);
      expect(() => createProvider({ env: { WEFT_LLM: w, WEFT_LOCAL_BASE_URL: "not a url" }, ledger, testMode: false })).toThrow(/PROVIDER_CONFIG: WEFT_LOCAL_BASE_URL is not a valid URL/);
    }
  });
});

describe("request body", () => {
  it("one system message, the pack and notices as user messages, compact sorted tools, reasoning off, 768 tokens", () => {
    const history: HistoryItem[] = [
      { kind: "context", text: "<context n=\"abc\">pack</context>" },
      { kind: "model", provider: "openai_compat", native: [{ role: "assistant", content: null, tool_calls: [toolCall("call_1", "people__search", "{\"q\":\"Ada\"}")] }] },
      { kind: "tool_outputs", outputs: [{ callId: "call_1", name: "people__search", output: "{\"ok\":true}" }] },
      { kind: "notice", notice: "budget", attrs: { n: "abc" }, text: "2 steps left" },
    ];
    const body = buildChatCompletionsRequest(req(history), { compactDescriptions: (w) => (w === "comms__post_update" ? "Post a progress line to the run feed." : "") });
    expect(body).toEqual({
      model: "Qwen3-1.7B-Q4_0",
      messages: [
        { role: "system", content: "FROZEN" },
        { role: "user", content: "<context n=\"abc\">pack</context>" },
        { role: "assistant", content: null, tool_calls: [toolCall("call_1", "people__search", "{\"q\":\"Ada\"}")] },
        { role: "tool", tool_call_id: "call_1", content: "{\"ok\":true}" },
        { role: "user", content: "<weft_notice kind=\"budget\" n=\"abc\">2 steps left</weft_notice>" },
      ],
      tools: [
        { type: "function", function: { name: "comms__post_update", description: "Post a progress line to the run feed.", parameters: tools[1]!.parameters } },
        { type: "function", function: { name: "people__search", description: "Search people by name, state or department.", parameters: tools[0]!.parameters } },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
      max_tokens: 768,
      temperature: 0,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(() => buildChatCompletionsRequest(req([{ kind: "model", provider: "openai", native: [] }]))).toThrow(/pinned to one provider/);
  });

  it("helpers: compact descriptions, URL joining, strict argument parsing, thinking stripped", () => {
    expect(compactFromDescription("x".repeat(300))).toHaveLength(200);
    expect(chatCompletionsUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(chatCompletionsUrl("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(parseToolArguments("{\"q\": \"Ada\"}")).toEqual({ ok: true, json: "{\"q\":\"Ada\"}" });
    expect(parseToolArguments({ q: "Ada" })).toEqual({ ok: true, json: "{\"q\":\"Ada\"}" });
    expect(parseToolArguments("")).toEqual({ ok: true, json: "{}" });
    for (const bad of ["{'q': 'Ada'}", "{\"q\": \"Ada\",}", "{\"q\":\"Ada\"} trailing", "[1]", "\"Ada\"", "null"]) expect(parseToolArguments(bad).ok).toBe(false);
    expect(stripThinking("<think>plan</think>\nAnswer.")).toBe("Answer.");
  });
});

describe("against a fake server", () => {
  it("acceptance: a tool call comes back with strict JSON arguments, usage and the request id", async () => {
    replies.push({ body: completion({ content: "<think></think>", tool_calls: [toolCall("call_a", "people__search", "{\"q\": \"Ada\"}"), toolCall("", "comms__post_update", { text: "Searching." })] }, "tool_calls") });
    const res = await provider().step(req([{ kind: "context", text: "pack" }, { kind: "user", text: "Find Ada" }]));
    expect(res.stop).toBe("tool_calls");
    expect(res.toolCalls).toEqual([
      { callId: "call_a", name: "people__search", argumentsJson: "{\"q\":\"Ada\"}" },
      { callId: "call_run_0001_1_2", name: "comms__post_update", argumentsJson: "{\"text\":\"Searching.\"}" },
    ]);
    expect(res.usage).toEqual({ input: 120, cached: 100, cacheWrite: 0, output: 30, reasoning: 0 });
    expect(res.requestId).toBe("req_1");
    expect(res.native).toEqual([{ role: "assistant", content: null, tool_calls: [toolCall("call_a", "people__search", "{\"q\":\"Ada\"}"), toolCall("call_run_0001_1_2", "comms__post_update", "{\"text\":\"Searching.\"}")] }]);
    expect(received[0]).toMatchObject({ chat_template_kwargs: { enable_thinking: false }, max_tokens: 768 });
  });

  it("final text, a cut-off answer and HTTP errors map to the contract", async () => {
    replies.push({ body: completion({ content: "Ada works in CA." }) });
    expect(await provider().step(req([{ kind: "user", text: "q" }]))).toMatchObject({ stop: "final", text: "Ada works in CA.", toolCalls: [] });
    replies.push({ body: completion({ content: "", tool_calls: [toolCall("call_x", "people__search", "{\"q\":")] }, "length") });
    expect(await provider().step(req([{ kind: "user", text: "q" }]))).toMatchObject({ stop: "incomplete", toolCalls: [], error: { code: "PROVIDER_UNAVAILABLE", retryable: true } });
    replies.push({ status: 500, body: { error: "boom" } });
    expect(await provider().step(req([{ kind: "user", text: "q" }]))).toMatchObject({ stop: "error", error: { code: "PROVIDER_UNAVAILABLE", retryable: true } });
    replies.push({ status: 400, body: { error: "bad tools" } });
    expect(await provider().step(req([{ kind: "user", text: "q" }]))).toMatchObject({ stop: "error", error: { code: "PROVIDER_REQUEST_INVALID", retryable: false } });
    replies.push({ raw: "<html>not json</html>" });
    expect(await provider().step(req([{ kind: "user", text: "q" }]))).toMatchObject({ stop: "error", error: { code: "PROVIDER_UNAVAILABLE" } });
    const down = chatCompletionsProvider({ mode: "llama", config: { baseUrl: "http://127.0.0.1:9/v1", model: "m", reasoning: "off", strictJson: true } });
    expect(await down.step(req([{ kind: "user", text: "q" }]))).toMatchObject({ stop: "error", error: { code: "PROVIDER_UNAVAILABLE", retryable: true } });
  });

  it("acceptance: a slow server gives PROVIDER_TIMEOUT (retryable); a cancelled step is not retryable", async () => {
    replies.push({ body: completion({ content: "late" }), delayMs: 2_000 });
    const t0 = Date.now();
    const res = await provider(150).step(req([{ kind: "user", text: "q" }]));
    expect(res).toMatchObject({ stop: "error", error: { code: "PROVIDER_TIMEOUT", retryable: true } });
    expect(Date.now() - t0).toBeLessThan(1_500);
    replies.push({ body: completion({ content: "late" }), delayMs: 2_000 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    expect(await provider().step(req([{ kind: "user", text: "q" }], { signal: ac.signal }))).toMatchObject({ error: { code: "PROVIDER_TIMEOUT", retryable: false } });
  });

  it("parses a recorded llama-server body (string arguments, empty content)", () => {
    const res = handleCompletion(completion({ content: "", tool_calls: [toolCall("abc", "people__search", "{\"q\":\"Ada\"}")] }, "tool_calls") as never, req([]));
    expect(res).toMatchObject({ stop: "tool_calls", text: "", toolCalls: [{ callId: "abc", name: "people__search", argumentsJson: "{\"q\":\"Ada\"}" }] });
  });
});

describe("acceptance: an invalid JSON argument is an INVALID_INPUT tool error inside a loop run, not a crash", () => {
  it("the run continues, the server sees the tool error, and the run ends done at zero cost", async () => {
    const dataDir = mkdtempSync(join(dir, "loop-"));
    const db = openDb({ dataDir });
    await migrate(db);
    try {
      const done = (data: unknown, summary: string): ToolOutcome => ({ ok: true, status: "done", resultId: "res_0100", data, summary, actionSeq: null, artifactRef: null, tainted: false, label: "synthetic" });
      const fake = createFakeExecutor([{ name: "people.search", effect: "read", handler: () => done({ people: [] }, "0 people") }]);
      const clock: SimClock = { now: () => "2026-10-26T16:00:00.000Z", rate: () => 0, advance: async () => undefined, set: async () => undefined };
      const routine: RoutineDef = {
        id: "rt_local_smoke", name: "Local smoke", description: "d", ownerPrincipalId: "usr_0001", enabled: true, autonomy: "approve",
        trigger: { type: "event", event: "notice.received" }, filter: null, instructions: "Look someone up.", tools: ["people.search"], precheck: null,
        budget: { steps: 4, usd: 0.1, minutes: 10 }, surface: { worthSurfacing: false, channel: null }, source: "prebuilt", taintedBy: null, checklist: [],
      };
      const routineRun: RoutineRun = { id: "rtr_0001", routineId: routine.id, runKey: "k", triggerRef: "evt_0001", status: "running", agentRunId: null, precheck: null, summary: null, leftForHuman: [], surfaceHash: null, overdue: false, attended: true, startedAt: null, endedAt: null, costUsdMicros: 0 };
      const precheck: PrecheckResult = { action: "run", severity: "interrupt", subjectRefs: [], findings: {}, derivedArgs: {} };
      const trigger = { id: "evt_0001", type: "notice.received", ts: "2026-10-26T16:00:00.000Z", subjectRef: "evt_0001", payload: {}, attended: true, requestedBy: "usr_0001" };
      const ledger = createSpendLedger({ dir: join(dataDir, "spend"), caps: { runUsd: 0.1, dayUsd: 2, liveUsd: 0.5 } });
      const rt = createAgentRuntime({ db, clock, executor: fake, provider: provider(), ledger, routinesView: { get: async () => routine } });

      replies.push({ body: completion({ content: null, tool_calls: [toolCall("call_bad", "people__search", "{'q': 'Ada'}")] }, "tool_calls") });
      replies.push({ body: completion({ content: null, tool_calls: [toolCall("call_good", "people__search", "{\"q\":\"Ada\"}")] }, "tool_calls") });
      replies.push({ body: completion({ content: "Nobody named Ada is on file." }) });
      const h = { runId: "run_0042", token: "tok" };
      await rt.startRoutineRun(h, { routine, routineRun, trigger, precheck });
      const run = await rt.settled(h.runId);
      expect(run.status).toBe("done");
      expect(run.costUsdMicros).toBe(0);
      expect(fake.calls.map((c) => c.callId)).toEqual(["call_good"]);
      const toolSteps = (await rt.store.steps(h.runId)).filter((s) => s.kind === "tool_call");
      expect(toolSteps.map((s) => s.outcome)).toEqual(["refused:INVALID_INPUT", "ok"]);
      // The second request replays the bad call as JSON (templates parse arguments) and carries the INVALID_INPUT error.
      const second = received[1]!.messages as Record<string, unknown>[];
      const toolMsg = second.find((m) => m.role === "tool" && m.tool_call_id === "call_bad")!;
      expect(JSON.parse(String(toolMsg.content))).toMatchObject({ ok: false, refusal: { code: "INVALID_INPUT" } });
      const replayed = second.find((m) => m.role === "assistant") as { tool_calls: { function: { arguments: string } }[] };
      expect(JSON.parse(replayed.tool_calls[0]!.function.arguments)).toEqual({ invalid_arguments: "{'q': 'Ada'}" });
      await rt.idle();
    } finally {
      await closeDb(db);
    }
  });
});
