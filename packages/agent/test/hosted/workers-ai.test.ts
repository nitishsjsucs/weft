// The Workers AI switch (providers/workers-ai.ts; docs/cloudflare/design.md 5.2; tracks.md cf3-agent). A fake AI
// binding stands in for env.AI: a tool round trip through the agent loop prices in USD equivalents of neurons and
// counts its neurons in the hosted ledger, the request is the OpenAI builder's minus the OpenAI-only fields, and the
// factory refuses workers_ai in tests (LIVE_PROVIDER_IN_TEST) like every live provider.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelStepRequest, SimClock, ToolOutcome } from "@weft/contracts";
import { WORKERS_AI_LABEL, WORKERS_AI_MODEL, type WorkersAiBindingLike } from "../../../contracts/src/ext/cf-agent";
import { closeDb, migrate, openDb, type Db } from "@weft/db";
import {
  asModelProvider, bindSpendLedger, createAgentRuntime, createHostedSpendLedger, createProvider, createSqlSpendStore, inlineScriptSource, normalizeWorkersAiOutput,
  pricesFor, stepCostUsd, stepNeurons, usdToMicros, WORKERS_AI_GPT_OSS, workersAiBindingTransport, workersAiBody, workersAiProvider, workersAiRestTransport,
} from "../../src/index";
import { createFakeExecutor } from "../fake-executor";
import { sqliteStorage, type TestStorage } from "./sqlite-storage";

interface Call { model: string; inputs: Record<string, unknown>; options: unknown }

/** env.AI: answers each run from `replies` in order and records what it was asked. */
function fakeAi(replies: unknown[]): WorkersAiBindingLike & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(model, inputs, options) {
      calls.push({ model, inputs: JSON.parse(JSON.stringify(inputs)) as Record<string, unknown>, options });
      const r = replies[calls.length - 1];
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

const usage1 = { input_tokens: 1200, output_tokens: 80, total_tokens: 1280 };
const usage2 = { input_tokens: 1400, output_tokens: 40, total_tokens: 1440 };
const toolCallReply = {
  id: "resp_wai_1", object: "response", status: "completed", model: WORKERS_AI_MODEL, usage: usage1,
  output: [
    { id: "rs_1", type: "reasoning", content: [{ type: "reasoning_text", text: "Look the person up." }] },
    { id: "fc_1", type: "function_call", call_id: "call_wai_a", name: "people__search", arguments: "{\"query\":\"Lena\"}", status: "completed" },
  ],
};
const finalReply = { id: "resp_wai_2", object: "response", model: WORKERS_AI_MODEL, usage: usage2, output: [{ id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "Lena Brooks is on the people list (res_0007)." }] }] };

const clock: SimClock = { now: () => "2026-10-26T16:00:00.000Z", rate: () => 0, advance: async () => undefined, set: async () => undefined };
let dataDir: string;
let db: Db;
let storage: TestStorage;
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "weft-wai-"));
  db = openDb({ dataDir });
  await migrate(db);
  storage = sqliteStorage();
});
afterEach(async () => {
  await closeDb(db);
  storage.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const found: ToolOutcome = { ok: true, status: "done", resultId: "res_0007", data: { people: [{ id: "wrk_0026", name: "Lena Brooks" }] }, summary: "1 person", actionSeq: null, artifactRef: null, tainted: false, label: "synthetic" };

describe("the workers_ai provider", () => {
  it("acceptance: a fake-binding tool round trip prices in neurons' USD equivalents and counts its neurons", async () => {
    const ai = fakeAi([toolCallReply, finalReply]);
    const provider = asModelProvider(workersAiProvider({ transport: workersAiBindingTransport(ai, { gateway: "weft-gw", world: () => ({ slot: "slot-2", gen: 7, visitor: "vis_w" }) }) }));
    expect(provider).toMatchObject({ id: "workers_ai", model: WORKERS_AI_MODEL, label: WORKERS_AI_LABEL, live: true });
    const hosted = createHostedSpendLedger({ store: createSqlSpendStore(storage) });
    const ledger = bindSpendLedger(hosted, { world: () => "slot-2:gen-7", visitor: () => "vis_w", ipHash: () => "ip_w" });
    const executor = createFakeExecutor([{ name: "people.search", effect: "read", handler: () => found }]);
    const rt = createAgentRuntime({ db, clock, executor, provider, ledger, routinesView: { get: async () => null }, scriptSource: inlineScriptSource({}) });
    const h = { runId: "run_0001", token: "tok" };
    await rt.startChat(h, { text: "Is Lena on the people list?", recipe: "chat", pageContext: null });
    const run = await rt.settled(h.runId);
    expect(run).toMatchObject({ status: "done", provider: "workers_ai", model: WORKERS_AI_MODEL, stepsUsed: 2 });
    expect(executor.calls.map((c) => c.command)).toEqual(["people.search"]);

    // Priced from cost.ts's neuron rows: about $0.35 in and $0.75 out per million tokens, no cached discount.
    const u = (x: typeof usage1) => ({ input: x.input_tokens, cached: 0, cacheWrite: 0, output: x.output_tokens, reasoning: 0 });
    const expected = usdToMicros(stepCostUsd(u(usage1), WORKERS_AI_GPT_OSS)) + usdToMicros(stepCostUsd(u(usage2), WORKERS_AI_GPT_OSS));
    expect(run.costUsdMicros).toBe(expected);
    expect(pricesFor("workers_ai", {})).toEqual(WORKERS_AI_GPT_OSS);
    expect(WORKERS_AI_GPT_OSS.inPerM).toBeCloseTo(0.349998, 9);
    expect(WORKERS_AI_GPT_OSS.outPerM).toBeCloseTo(0.750002, 9);
    // The ledger has the dollars and the neurons the account is charged, within a neuron of the token count.
    const status = await ledger.status();
    expect(status.spentMicros.day).toBe(expected);
    expect(Math.abs(status.neurons.used - (stepNeurons(u(usage1)) + stepNeurons(u(usage2))))).toBeLessThanOrEqual(2);
    expect(status.neurons.byProduct.agent).toBe(status.neurons.used);
    expect(status.openReservations).toBe(0);

    // Each call went through the gateway with the run's metadata, and the body is the OpenAI builder's minus the
    // OpenAI-only fields.
    expect(ai.calls).toHaveLength(2);
    for (const c of ai.calls) {
      expect(c.model).toBe(WORKERS_AI_MODEL);
      expect(c.options).toEqual({ gateway: { id: "weft-gw", metadata: { slot: "slot-2", gen: 7, run: "run_0001", kind: "chat", visitor: "vis_w" } } });
      expect(Object.keys(c.inputs).sort()).toEqual(["input", "max_output_tokens", "parallel_tool_calls", "reasoning", "tool_choice", "tools"]);
      expect((c.inputs.tools as { strict: boolean }[]).every((t) => t.strict)).toBe(true);
    }
    // The second call replays the model's own items without ids, then the tool output.
    const input = ai.calls[1]!.inputs.input as Record<string, unknown>[];
    expect(input[0]).toMatchObject({ role: "developer" });
    expect(input.slice(2, 4)).toEqual([
      { type: "reasoning", content: [{ type: "reasoning_text", text: "Look the person up." }] },
      { type: "function_call", call_id: "call_wai_a", name: "people__search", arguments: "{\"query\":\"Lena\"}", status: "completed" },
    ]);
    expect(input[4]).toMatchObject({ type: "function_call_output", call_id: "call_wai_a" });
  });

  it("acceptance: the factory refuses workers_ai in tests unless WEFT_LIVE_OPENAI=1, and builds it on the binding then", () => {
    const ai = fakeAi([]);
    expect(() => createProvider({ env: { VITEST: "true", WEFT_LLM: "workers_ai" }, ledger: null as never, testMode: false, ai })).toThrow(/LIVE_PROVIDER_IN_TEST: WEFT_LLM=workers_ai/);
    expect(() => createProvider({ env: { WEFT_LLM: "workers_ai" }, ledger: null as never, testMode: true, ai })).toThrow(/LIVE_PROVIDER_IN_TEST/);
    const p = createProvider({ env: { VITEST: "true", WEFT_LLM: "workers_ai", WEFT_LIVE_OPENAI: "1", WEFT_AIG_GATEWAY: "weft-gw" }, ledger: null as never, testMode: true, ai });
    expect(p).toMatchObject({ id: "workers_ai", live: true, label: WORKERS_AI_LABEL });
    // On Node (no binding) it needs the gateway's Workers AI REST path and a narrow token.
    expect(() => createProvider({ env: { WEFT_LLM: "workers_ai" }, ledger: null as never, testMode: false })).toThrow(/PROVIDER_CONFIG: WEFT_LLM=workers_ai on Node needs WEFT_AIG_ACCOUNT_ID/);
    expect(() => createProvider({ env: { WEFT_LLM: "workers_ai", WEFT_AIG_ACCOUNT_ID: "a", WEFT_AIG_GATEWAY: "g" }, ledger: null as never, testMode: false })).toThrow(/PROVIDER_CONFIG: WEFT_WORKERS_AI_TOKEN/);
    expect(() => createProvider({ env: { WEFT_LLM: "nope" }, ledger: null as never, testMode: false })).toThrow(/use scripted, openai, claude, mlx, llama or workers_ai/);
  });

  it("the Node REST transport posts to the gateway's Workers AI path with the token and unwraps { result }", async () => {
    const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = new Request(input as never, init);
      seen.push({ url: r.url, headers: Object.fromEntries(r.headers), body: JSON.parse(await r.text()) as Record<string, unknown> });
      return Response.json({ result: finalReply, success: true, errors: [], messages: [] });
    }) as typeof globalThis.fetch;
    const p = createProvider({ env: { WEFT_LLM: "workers_ai", WEFT_AIG_ACCOUNT_ID: "acct", WEFT_AIG_GATEWAY: "gw", WEFT_WORKERS_AI_TOKEN: "wai_tok_not_real", CF_AIG_TOKEN: "aig_tok" }, ledger: null as never, testMode: false, fetch });
    const req: ModelStepRequest = { runId: "run_0009", agentKind: "main", model: WORKERS_AI_MODEL, frozenPrompt: "F", tools: [], toolChoice: { mode: "auto" }, history: [{ kind: "context", text: "x" }], effort: "low", maxOutputTokens: 8000, cacheKey: "weft:main:chat:cmp_larkspur" };
    const r = await p.step(req);
    expect(r).toMatchObject({ stop: "final", text: "Lena Brooks is on the people list (res_0007).", usage: { input: 1400, output: 40 } });
    expect(seen[0]!.url).toBe(`https://gateway.ai.cloudflare.com/v1/acct/gw/workers-ai/${WORKERS_AI_MODEL}`);
    expect(seen[0]!.headers).toMatchObject({ authorization: "Bearer wai_tok_not_real", "cf-aig-authorization": "Bearer aig_tok", "cf-aig-metadata": JSON.stringify({ run: "run_0009", kind: "chat" }) });
    expect(seen[0]!.body).toEqual(workersAiBody(req));
    // A failed answer is an error result, never a thrown request.
    const failing = workersAiProvider({ transport: workersAiRestTransport({ accountId: "a", gateway: "g", token: "t", fetch: (async () => new Response("rate limited", { status: 429 })) as typeof globalThis.fetch }) });
    expect(await failing.step(req)).toMatchObject({ stop: "error", error: { code: "PROVIDER_UNAVAILABLE", retryable: true } });
  });

  it("maps binding errors: the daily allocation is not retried, capacity is, a bad request is invalid, an abort is a timeout", async () => {
    const req: ModelStepRequest = { runId: "run_0001", agentKind: "main", model: WORKERS_AI_MODEL, frozenPrompt: "F", tools: [], toolChoice: { mode: "auto" }, history: [{ kind: "context", text: "x" }], effort: "low", maxOutputTokens: 8000, cacheKey: "weft:main:chat:c" };
    const step = (e: Error) => workersAiProvider({ transport: workersAiBindingTransport(fakeAi([e])) }).step(req);
    expect((await step(new Error("4006: you have used up your daily free allocation of 10,000 neurons"))).error).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: false });
    expect((await step(new Error("3040: Capacity temporarily exceeded"))).error).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    expect((await step(new Error("5006: Invalid input: required properties"))).error).toMatchObject({ code: "PROVIDER_REQUEST_INVALID", retryable: false });
    const hang: WorkersAiBindingLike = { run: () => new Promise(() => undefined) };
    const ctl = new AbortController();
    const pending = workersAiProvider({ transport: workersAiBindingTransport(hang) }).step({ ...req, signal: ctl.signal });
    ctl.abort();
    expect((await pending).error).toMatchObject({ code: "PROVIDER_TIMEOUT" });
    // Inside a database transaction the binding is never called.
    const guard = { assertNotInTx: () => { throw Object.assign(new Error("IO_IN_TX: workers_ai binding call"), { code: "IO_IN_TX" }); } };
    const ai = fakeAi([finalReply]);
    await expect(workersAiProvider({ transport: workersAiBindingTransport(ai, { guard }) }).step(req)).rejects.toMatchObject({ code: "IO_IN_TX" });
    expect(ai.calls).toHaveLength(0);
  });

  it("reads Responses-shaped output, the older { response, tool_calls } shape, and a REST envelope", () => {
    expect(normalizeWorkersAiOutput(finalReply)).toMatchObject({ status: "completed", usage: { input_tokens: 1400, output_tokens: 40 } });
    expect(normalizeWorkersAiOutput({ response: "Hi", tool_calls: [{ name: "people__search", arguments: { query: "x" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } })).toEqual({
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi" }] },
        { type: "function_call", call_id: "call_wai_1", name: "people__search", arguments: "{\"query\":\"x\"}" },
      ],
      usage: { input_tokens: 3, output_tokens: 2, input_tokens_details: null, output_tokens_details: null },
    });
    expect(normalizeWorkersAiOutput({ result: { output: [], status: "completed" }, success: true })).toMatchObject({ status: "completed", output: [] });
    expect(normalizeWorkersAiOutput(null)).toEqual({ status: "failed", output: [] });
  });
});
