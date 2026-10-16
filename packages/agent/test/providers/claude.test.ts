// The Claude provider without a key: the request body built from a fixed run is compared with the committed
// snapshot (__snapshots__/claude-request.json), and recorded response fixtures (fixtures/claude-*.json, hand-built
// in the documented shape) parse into tool calls, final text, a refusal and a cut-off turn.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { HistoryItem, ModelStepRequest } from "@weft/contracts";
import { createProvider, createSpendLedger } from "../../src/index";
import { buildClaudeRequest, CLAUDE_ERRORS, CLAUDE_MODEL, claudeErrorResult, claudeProvider, handleClaudeMessage, mapClaudeUsage } from "../../src/providers/claude";

const dir = mkdtempSync(join(tmpdir(), "weft-claude-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", `${name}.json`), "utf8")) as Record<string, unknown>;

const toolUse = fixture("claude-tool-use");
const fixedHistory: HistoryItem[] = [
  { kind: "context", text: "<context n=\"abc\">pack: CA notice ntc_0001</context>" },
  { kind: "model", provider: "claude", native: toolUse.content },
  { kind: "tool_outputs", outputs: [
    { callId: "toolu_01FIXTUREA", name: "notices__get", output: "{\"ok\":true,\"data\":{\"rate_new\":\"0.015\"}}" },
    { callId: "toolu_01FIXTUREB", name: "tax__get_rates", output: "{\"ok\":true,\"data\":{\"rate\":\"0.034\"},\"_weft_plan\":\"steps 1/6\"}" },
  ] },
  { kind: "notice", notice: "decision", attrs: { n: "abc", proposal_id: "prp_0001", status: "approved" }, text: "Approved <x>" },
];
const fixedRun: ModelStepRequest = {
  runId: "run_0001", agentKind: "main", model: CLAUDE_MODEL, frozenPrompt: "FROZEN PROMPT", toolChoice: { mode: "auto" }, history: fixedHistory,
  tools: [
    { name: "tax__update_rate", description: "Propose a rate.", parameters: { additionalProperties: false, properties: { rate: { type: "string" } }, required: ["rate"], type: "object" } },
    { name: "notices__get", description: "Read a notice.", parameters: { additionalProperties: false, properties: { notice_id: { type: "string" } }, required: ["notice_id"], type: "object" } },
  ],
  effort: "low", maxOutputTokens: 8000, cacheKey: "weft:main:rt_agency_notice:cmp_larkspur",
};

describe("claude request builder", () => {
  it("acceptance: the body for a fixed run matches the committed snapshot", async () => {
    const body = buildClaudeRequest(fixedRun);
    await expect(`${JSON.stringify(body, null, 2)}\n`).toMatchFileSnapshot("./__snapshots__/claude-request.json");
    // The load-bearing settings, asserted outright so a careless snapshot update cannot drop them.
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "low" },
      tool_choice: { type: "auto" },
      system: [{ type: "text", text: "FROZEN PROMPT", cache_control: { type: "ephemeral" } }],
      max_tokens: 16000,
    });
    expect((body.tools as { name: string; strict: boolean }[]).map((t) => [t.name, t.strict])).toEqual([["notices__get", true], ["tax__update_rate", true]]);
    const messages = body.messages as { role: string; content: unknown }[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "user"]);
    expect(messages[1]!.content).toEqual(toolUse.content);   // thinking block and signature replayed unchanged
    expect(messages[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_01FIXTUREA", content: "{\"ok\":true,\"data\":{\"rate_new\":\"0.015\"}}" },
      { type: "tool_result", tool_use_id: "toolu_01FIXTUREB", content: "{\"ok\":true,\"data\":{\"rate\":\"0.034\"},\"_weft_plan\":\"steps 1/6\"}" },
    ]);
  });

  it("effort is always explicit; none maps to low; a run is pinned to one provider", () => {
    expect(buildClaudeRequest({ ...fixedRun, effort: "none" }).output_config).toEqual({ effort: "low" });
    expect(buildClaudeRequest({ ...fixedRun, effort: "high" }).output_config).toEqual({ effort: "high" });
    expect(buildClaudeRequest({ ...fixedRun, maxOutputTokens: 32000 }).max_tokens).toBe(32000);
    expect(() => buildClaudeRequest({ ...fixedRun, history: [{ kind: "model", provider: "openai", native: [] }] })).toThrow(/pinned to one provider/);
  });
});

describe("recorded responses", () => {
  it("acceptance: tool_use blocks become tool calls; thinking and text stay in native for replay", () => {
    const res = handleClaudeMessage(toolUse as never, CLAUDE_MODEL, "req_fixture");
    expect(res.stop).toBe("tool_calls");
    expect(res.toolCalls).toEqual([
      { callId: "toolu_01FIXTUREA", name: "notices__get", argumentsJson: "{\"notice_id\":\"ntc_0001\"}" },
      { callId: "toolu_01FIXTUREB", name: "tax__get_rates", argumentsJson: "{\"state\":\"CA\"}" },
    ]);
    expect(res.text).toBe("Reading the notice and the current rates.");
    expect(res.native).toEqual(toolUse.content);
    expect(res.usage).toEqual({ input: 2360, cached: 2048, cacheWrite: 0, output: 210, reasoning: 0 });
    expect(res).toMatchObject({ servedBy: "claude-opus-5-5", requestId: "req_fixture" });
  });

  it("a mid-stream fallback: declined tool_use and thinking before the boundary are neither run nor echoed", () => {
    const msg = {
      model: "claude-opus-4-8", stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 20 },
      content: [
        { type: "thinking", thinking: "declined partial", signature: "sig_a" },
        { type: "text", text: "Reading the notice" },
        { type: "tool_use", id: "toolu_DECLINED", name: "tax__update_rate", input: { rate: "9.9" } },
        { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } },
        { type: "text", text: " and the rates." },
        { type: "tool_use", id: "toolu_SERVED", name: "notices__get", input: { notice_id: "ntc_0001" } },
      ],
    };
    const res = handleClaudeMessage(msg as never, CLAUDE_MODEL);
    expect(res.toolCalls.map((c) => c.callId)).toEqual(["toolu_SERVED"]);
    expect((res.native as { type: string }[]).map((b) => b.type)).toEqual(["text", "text", "tool_use"]);
    expect(res.servedBy).toBe("claude-opus-4-8");
  });

  it("final text, a refusal with its category and a max_tokens cut-off", () => {
    expect(handleClaudeMessage(fixture("claude-final") as never, CLAUDE_MODEL)).toMatchObject({
      stop: "final", text: "Proposed the CA SUI rate change from 3.4% to 1.5%; it waits for approval.", toolCalls: [], usage: { input: 1590, cached: 0, cacheWrite: 1500, output: 44 },
    });
    expect(handleClaudeMessage(fixture("claude-refusal") as never, CLAUDE_MODEL)).toMatchObject({
      stop: "refusal", toolCalls: [], refusal: { category: "cyber", text: "The request was declined by a safety classifier." },
    });
    expect(handleClaudeMessage(fixture("claude-max-tokens") as never, CLAUDE_MODEL)).toMatchObject({
      stop: "incomplete", toolCalls: [], error: { code: "PROVIDER_UNAVAILABLE", retryable: true },
    });
    expect(mapClaudeUsage(null)).toEqual({ input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 });
  });

  it("step streams the built body with the signal and collects finalMessage(); SDK errors map to provider codes", async () => {
    const seen: { body: unknown; signal?: AbortSignal }[] = [];
    const client = { beta: { messages: { stream: (body: never, o?: { signal?: AbortSignal }) => { seen.push({ body, signal: o?.signal }); return { request_id: "req_stream", finalMessage: async () => toolUse }; } } } };
    const p = claudeProvider({ apiKey: "sk-ant-test-not-real", client });
    expect(p).toMatchObject({ id: "claude", model: "claude-opus-5-5", label: "Claude Opus 5.5", live: true });
    const ac = new AbortController();
    const res = await p.step({ ...fixedRun, signal: ac.signal });
    expect(seen[0]!.body).toEqual(buildClaudeRequest(fixedRun));
    expect(seen[0]!.signal).toBe(ac.signal);
    expect(res).toMatchObject({ stop: "tool_calls", requestId: "req_stream" });

    const failing = (e: unknown) => claudeProvider({ apiKey: "x", client: { beta: { messages: { stream: () => ({ finalMessage: async () => { throw e; } }) } } } });
    const headers = new Headers();
    expect((await failing(new CLAUDE_ERRORS.RateLimitError(429, { type: "error" }, "rate limited", headers)).step(fixedRun)).error).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    expect((await failing(new CLAUDE_ERRORS.BadRequestError(400, { type: "error" }, "bad", headers)).step(fixedRun)).error).toMatchObject({ code: "PROVIDER_REQUEST_INVALID", retryable: false });
    expect((await failing(new CLAUDE_ERRORS.AuthenticationError(401, { type: "error" }, "no key", headers)).step(fixedRun)).error).toMatchObject({ code: "PROVIDER_CONFIG" });
    expect((await failing(new CLAUDE_ERRORS.APIUserAbortError()).step(fixedRun)).error).toMatchObject({ code: "PROVIDER_TIMEOUT", retryable: false });
    expect((await failing(new CLAUDE_ERRORS.APIConnectionTimeoutError()).step(fixedRun)).error).toMatchObject({ code: "PROVIDER_TIMEOUT", retryable: true });
    expect(claudeErrorResult(new Error("other"), CLAUDE_MODEL).error).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: false });
  });
});

describe("factory: WEFT_LLM=claude", () => {
  const ledger = createSpendLedger({ dir: join(dir, "spend") });
  it("acceptance: builds from ANTHROPIC_API_KEY in WEFT_SECRETS_FILE; LIVE_PROVIDER_IN_TEST guards tests; a missing key names the variable", () => {
    const file = join(dir, "k.env");
    writeFileSync(file, "ANTHROPIC_API_KEY=sk-ant-test-not-real\n");
    expect(() => createProvider({ env: { VITEST: "true", WEFT_LLM: "claude", WEFT_SECRETS_FILE: file }, ledger, testMode: false })).toThrow(/LIVE_PROVIDER_IN_TEST/);
    expect(() => createProvider({ env: { WEFT_LLM: "claude" }, ledger, testMode: false })).toThrow(/PROVIDER_CONFIG: ANTHROPIC_API_KEY is not set/);
    const p = createProvider({ env: { VITEST: "true", WEFT_LLM: "claude", WEFT_LIVE_OPENAI: "1", WEFT_SECRETS_FILE: file }, ledger, testMode: true });
    expect(p).toMatchObject({ id: "claude", model: "claude-opus-5-5", label: "Claude Opus 5.5", live: true });
    expect(process.env.ANTHROPIC_API_KEY === "sk-ant-test-not-real").toBe(false);
  });
});
