import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { HistoryItem, ModelStepRequest } from "@weft/contracts";
import { buildResponsesRequest, createProvider, createSpendLedger, handleResponse, loadSecret, openaiProvider, parseSecretsFile, scriptedProvider, SCRIPTED_LABEL } from "../src/index";

const dir = mkdtempSync(join(tmpdir(), "weft-prov-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ledger = createSpendLedger({ dir: join(dir, "spend") });
const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", `${name}.json`), "utf8"));

describe("secrets", () => {
  it("reads the environment first, then WEFT_SECRETS_FILE, and never sets process.env", () => {
    const file = join(dir, "secrets.env");
    writeFileSync(file, "# comment\nexport OPENAI_API_KEY=\"sk-test-not-real\"\nOTHER=1 # trailing\n");
    expect(parseSecretsFile(readFileSync(file, "utf8")).get("OTHER")).toBe("1");
    expect(loadSecret("OPENAI_API_KEY", { WEFT_SECRETS_FILE: file })).toBe("sk-test-not-real");
    expect(loadSecret("OPENAI_API_KEY", { OPENAI_API_KEY: "sk-env", WEFT_SECRETS_FILE: file })).toBe("sk-env");
    expect(loadSecret("OPENAI_API_KEY", {})).toBeNull();
    expect(loadSecret("OPENAI_API_KEY", { WEFT_SECRETS_FILE: join(dir, "missing.env") })).toBeNull();
    expect(process.env.OPENAI_API_KEY === "sk-test-not-real").toBe(false);
  });
});

describe("provider factory", () => {
  it("acceptance: WEFT_LLM unset resolves to scripted", () => {
    const p = createProvider({ env: { VITEST: "true" }, ledger, testMode: true });
    expect(p.id).toBe("scripted");
    expect(p.live).toBe(false);
    expect(p.label).toBe(SCRIPTED_LABEL);
  });

  it("acceptance: throws LIVE_PROVIDER_IN_TEST under vitest unless WEFT_LIVE_OPENAI=1", () => {
    expect(() => createProvider({ env: { VITEST: "true", WEFT_LLM: "openai" }, ledger, testMode: false })).toThrow(/LIVE_PROVIDER_IN_TEST/);
    expect(() => createProvider({ env: { NODE_ENV: "test", WEFT_LLM: "openai" }, ledger, testMode: false })).toThrow(/LIVE_PROVIDER_IN_TEST/);
    expect(() => createProvider({ env: { WEFT_LLM: "openai" }, ledger, testMode: true })).toThrow(/LIVE_PROVIDER_IN_TEST/);
    expect(() => createProvider({ env: { ...process.env, WEFT_LLM: "openai", WEFT_LIVE_OPENAI: undefined }, ledger, testMode: false })).toThrow(/LIVE_PROVIDER_IN_TEST/);
    const file = join(dir, "k.env");
    writeFileSync(file, "OPENAI_API_KEY=sk-test-not-real\n");
    const p = createProvider({ env: { VITEST: "true", WEFT_LLM: "openai", WEFT_LIVE_OPENAI: "1", WEFT_SECRETS_FILE: file }, ledger, testMode: true });
    expect(p).toMatchObject({ id: "openai", model: "gpt-5.6-luna", live: true, label: "OpenAI gpt-5.6-luna" });
  });

  it("claude and the local providers throw PROVIDER_CONFIG; a missing key throws PROVIDER_CONFIG", () => {
    for (const w of ["claude", "mlx", "llama"]) {
      expect(() => createProvider({ env: { WEFT_LLM: w }, ledger, testMode: false })).toThrow(/PROVIDER_CONFIG: not built in P0/);
    }
    expect(() => createProvider({ env: { WEFT_LLM: "openai" }, ledger, testMode: false })).toThrow(/PROVIDER_CONFIG/);
  });
});

const baseReq = (history: HistoryItem[]): ModelStepRequest => ({
  runId: "run_0001", agentKind: "main", model: "gpt-5.6-luna", frozenPrompt: "FROZEN", toolChoice: { mode: "auto" }, history,
  tools: [
    { name: "tax__update_rate", description: "Propose a rate.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } },
    { name: "notices__get", description: "Read a notice.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } },
  ],
  effort: "low", maxOutputTokens: 8000, cacheKey: "weft:main:rt_agency_notice:cmp_larkspur",
});

describe("openai request builder", () => {
  it("acceptance: matches harness 11.2 exactly", () => {
    const history: HistoryItem[] = [
      { kind: "context", text: "<context n=\"abc\">pack</context>" },
      { kind: "model", provider: "openai", native: [{ type: "reasoning", id: "rs_1", encrypted_content: "enc", summary: [] }, { type: "function_call", id: "fc_1", call_id: "call_1", name: "notices__get", arguments: "{}" }] },
      { kind: "tool_outputs", outputs: [{ callId: "call_1", name: "notices__get", output: "{\"ok\":true,\"_weft_plan\":\"steps 1/6\"}" }] },
      { kind: "notice", notice: "decision", attrs: { n: "abc", proposal_id: "prp_0001", status: "approved" }, text: "Approved <x>" },
    ];
    expect(buildResponsesRequest(baseReq(history))).toEqual({
      model: "gpt-5.6-luna",
      input: [
        { role: "developer", content: "FROZEN" },
        { role: "user", content: "<context n=\"abc\">pack</context>" },
        { type: "reasoning", id: "rs_1", encrypted_content: "enc", summary: [] },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "notices__get", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "{\"ok\":true,\"_weft_plan\":\"steps 1/6\"}" },
        { role: "user", content: "<weft_notice kind=\"decision\" n=\"abc\" proposal_id=\"prp_0001\" status=\"approved\">Approved &lt;x&gt;</weft_notice>" },
      ],
      tools: [
        { type: "function", name: "notices__get", description: "Read a notice.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, strict: true },
        { type: "function", name: "tax__update_rate", description: "Propose a rate.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, strict: true },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: "low" },
      store: false,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "weft:main:rt_agency_notice:cmp_larkspur",
      max_output_tokens: 8000,
    });
  });

  it("strips ids from replayed non-reasoning items when asked", () => {
    const history: HistoryItem[] = [{ kind: "model", provider: "openai", native: [{ type: "reasoning", id: "rs_1", encrypted_content: "e" }, { type: "message", id: "msg_1", role: "assistant", content: [] }] }];
    const input = buildResponsesRequest(baseReq(history), { stripReplayIds: true }).input as Record<string, unknown>[];
    expect(input[1]).toMatchObject({ id: "rs_1" });
    expect(input[2]).not.toHaveProperty("id");
  });

  it("passes maxRetries 0 and the request body to the SDK", async () => {
    let seen: Record<string, unknown> | null = null;
    const client = { responses: { create: async (body: Record<string, unknown>) => { seen = body; return fixture("tool-call"); } } };
    const p = openaiProvider({ apiKey: "sk-test-not-real", model: "gpt-5.6-luna", client: client as never });
    const res = await p.step(baseReq([{ kind: "context", text: "x" }]));
    expect(res.stop).toBe("tool_calls");
    expect(seen).toMatchObject({ store: false, parallel_tool_calls: true, max_output_tokens: 8000 });
  });
});

describe("openai response handlers on recorded fixtures", () => {
  it("tool call: maps usage and one call", () => {
    const r = handleResponse(fixture("tool-call"), "gpt-5.6-luna");
    expect(r.stop).toBe("tool_calls");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toMatchObject({ name: expect.any(String), callId: expect.stringMatching(/^call_/) });
    expect(r.usage.input).toBeGreaterThan(0);
    expect(Array.isArray(r.native)).toBe(true);
  });

  it("parallel calls: every function_call becomes a tool call in emitted order", () => {
    const r = handleResponse(fixture("parallel-calls"), "gpt-5.6-luna");
    expect(r.stop).toBe("tool_calls");
    expect(r.toolCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("refusal: ends with refused and runs no tool", () => {
    const r = handleResponse(fixture("refusal"), "gpt-5.6-luna");
    expect(r.stop).toBe("refusal");
    expect(r.toolCalls).toEqual([]);
    expect(r.refusal?.text).toBeTruthy();
  });

  it("incomplete: runs no tool even when a function call is present", () => {
    const r = handleResponse(fixture("incomplete"), "gpt-5.6-luna");
    expect(r.stop).toBe("incomplete");
    expect(r.toolCalls).toEqual([]);
    expect(r.error?.retryable).toBe(true);
  });
});

describe("scripted provider", () => {
  const scripts = {
    rt_demo: {
      agents: {
        main: [
          { output: [{ type: "function_call" as const, name: "tax__update_rate", arguments: "{{derived.tax.update_rate}}" }, { type: "function_call" as const, name: "notices__get", arguments: { notice_id: "{{trigger.notice_id}}" } }] },
          { expect: { lastResults: [{ tool: "tax__update_rate", status: "pending_approval" }] }, output: [{ type: "text" as const, text: "Proposed {{last.tax__update_rate.proposalId}}." }] },
        ],
      },
    },
    chat_ny: { match: "NY raise", agents: { main: [{ output: [{ type: "text" as const, text: "Answer." }] }] } },
  };
  const ctx = (extra: string) => ({ kind: "context" as const, text: `<context n="n1">\n<trigger>{"notice_id":"ntc_0001"}</trigger>\n<derived>{"tax.update_rate":{"rate":"0.015"}}</derived>\n${extra}</context>` });
  const req = (cacheKey: string, history: HistoryItem[]): ModelStepRequest => ({ ...baseReq(history), cacheKey });

  it("templates trigger, derived and last, with call ids call_<scenario>_<agent>_<n> and synthetic usage", async () => {
    const p = scriptedProvider({ scriptsDir: join(dir, "none"), scripts });
    const h: HistoryItem[] = [ctx("")];
    const s1 = await p.step(req("weft:main:rt_demo:cmp_larkspur", h));
    expect(s1.toolCalls).toEqual([
      { callId: "call_rt_demo_main_1", name: "tax__update_rate", argumentsJson: "{\"rate\":\"0.015\"}" },
      { callId: "call_rt_demo_main_2", name: "notices__get", argumentsJson: "{\"notice_id\":\"ntc_0001\"}" },
    ]);
    expect(s1.usage.input).toBeGreaterThan(0);
    expect(s1.usage.cached).toBe(0);
    h.push({ kind: "model", provider: "scripted", native: s1.native }, { kind: "tool_outputs", outputs: [{ callId: "call_rt_demo_main_1", name: "tax__update_rate", output: JSON.stringify({ ok: true, status: "pending_approval", proposalId: "prp_0007" }) }] });
    const s2 = await p.step(req("weft:main:rt_demo:cmp_larkspur", h));
    expect(s2).toMatchObject({ stop: "final", text: "Proposed prp_0007." });
    expect(s2.usage.cached).toBeGreaterThan(0);
  });

  it("a failed expect throws a readable diff", async () => {
    const p = scriptedProvider({ scriptsDir: join(dir, "none"), scripts });
    const h: HistoryItem[] = [ctx(""), { kind: "model", provider: "scripted", native: { calls: 2 } }, { kind: "tool_outputs", outputs: [{ callId: "c", name: "tax__update_rate", output: JSON.stringify({ ok: false, refusal: { code: "INVALID_INPUT" } }) }] }];
    await expect(p.step(req("weft:main:rt_demo:cmp_larkspur", h))).rejects.toThrow(/want \{"tool":"tax__update_rate","status":"pending_approval"\}/);
  });

  it("chat picks the first script whose match fits, else a labeled stub", async () => {
    const p = scriptedProvider({ scriptsDir: join(dir, "none"), scripts });
    expect((await p.step(req("weft:main:chat:cmp_larkspur", [ctx("<request>Why is the NY raise flagged?</request>")]))).text).toBe("Answer.");
    const stub = await p.step(req("weft:main:chat:cmp_larkspur", [ctx("<request>hello</request>")]));
    expect(stub.stop).toBe("final");
    expect(stub.text).toContain(SCRIPTED_LABEL);
  });
});
