// The experiment-only model and effort overrides (the gpt-5.6-terra comparison): WEFT_EFFORT reaches every OpenAI
// request and the run rows the runtime opens with that provider, unset keeps the per-stage defaults, and a model priced
// above Luna is priced from its own table with a scaled run cap.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProvider, ModelStepRequest, ModelStepResult, SimClock } from "@weft/contracts";
import { closeDb, migrate, openDb, type Db } from "@weft/db";
import {
  CHAT_TOOLS, createAgentRuntime, createProvider, createSpendLedger, effortOverrideFromEnv, LUNA, openaiProvider, openaiSettingsFromEnv,
  pricesFor, runCapScaleFor, stepCostUsd, TERRA, usdToMicros,
} from "../src/index";
import { createFakeExecutor } from "./fake-executor";

const req = (effort: ModelStepRequest["effort"] = "low"): ModelStepRequest => ({
  runId: "run_0001", agentKind: "main", model: "gpt-5.6-terra", frozenPrompt: "FROZEN", tools: [], toolChoice: { mode: "auto" },
  history: [{ kind: "context", text: "x" }], effort, maxOutputTokens: 8000, cacheKey: "weft:main:chat:cmp_larkspur",
});
const finalResult = (text: string): ModelStepResult => ({
  stop: "final", text, toolCalls: [], native: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  usage: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 }, servedBy: "gpt-5.6-terra", requestId: null,
});

describe("WEFT_EFFORT override", () => {
  it("is null when unset or empty, accepts low, medium and high, and refuses anything else with PROVIDER_CONFIG", () => {
    expect(effortOverrideFromEnv({})).toBeNull();
    expect(effortOverrideFromEnv({ WEFT_EFFORT: "  " })).toBeNull();
    for (const e of ["low", "medium", "high"] as const) expect(effortOverrideFromEnv({ WEFT_EFFORT: e })).toBe(e);
    for (const bad of ["MEDIUM", "xhigh", "none", "max", "fast"]) expect(() => effortOverrideFromEnv({ WEFT_EFFORT: bad })).toThrow(/PROVIDER_CONFIG: WEFT_EFFORT/);
  });

  it("WEFT_MODEL and WEFT_EFFORT pick the OpenAI provider's model and effort; unset gives Luna with no override", () => {
    expect(openaiSettingsFromEnv({})).toEqual({ model: "gpt-5.6-luna", stripReplayIds: false });
    expect(openaiSettingsFromEnv({ WEFT_MODEL: "gpt-5.6-terra", WEFT_EFFORT: "high" })).toEqual({ model: "gpt-5.6-terra", effort: "high", stripReplayIds: false });
    const ledger = createSpendLedger({ dir: join(mkdtempSync(join(tmpdir(), "weft-mc-")), "spend") });
    const env = { VITEST: "true", WEFT_LLM: "openai", WEFT_LIVE_OPENAI: "1", OPENAI_API_KEY: "sk-test-not-real" };
    expect(createProvider({ env: { ...env, WEFT_MODEL: "gpt-5.6-terra", WEFT_EFFORT: "medium" }, ledger, testMode: true }).model).toBe("gpt-5.6-terra");
    expect(() => createProvider({ env: { ...env, WEFT_EFFORT: "turbo" }, ledger, testMode: true })).toThrow(/PROVIDER_CONFIG: WEFT_EFFORT/);
  });

  it("set, every request sends it whatever effort the stage asked for; unset, the stage's effort goes through unchanged", async () => {
    const sent: unknown[] = [];
    const client = { responses: { create: async (body: Record<string, unknown>) => { sent.push(body.reasoning); return { status: "completed", output: [], usage: null }; } } };
    const over = openaiProvider({ apiKey: "sk-test-not-real", model: "gpt-5.6-terra", client: client as never, effort: "medium" });
    await over.step(req("low"));
    await over.step(req("high"));
    const plain = openaiProvider({ apiKey: "sk-test-not-real", model: "gpt-5.6-luna", client: client as never });
    await plain.step(req("low"));
    expect(sent).toEqual([{ effort: "medium" }, { effort: "medium" }, { effort: "low" }]);
  });
});

describe("the runtime records the override on the runs it opens", () => {
  const clock: SimClock = { now: () => "2026-10-26T16:00:00.000Z", rate: () => 0, advance: async () => undefined, set: async () => undefined };
  let dataDir: string;
  let db: Db;
  beforeEach(async () => { dataDir = mkdtempSync(join(tmpdir(), "weft-mc-rt-")); db = openDb({ dataDir }); await migrate(db); });
  afterEach(async () => { await closeDb(db); rmSync(dataDir, { recursive: true, force: true }); });

  async function chatRun(env: Record<string, string>): Promise<{ effort: string; asked: string[] }> {
    const asked: string[] = [];
    // An OpenAI-shaped provider that is not live (no spend) and records the effort each step asks for.
    const p: ModelProvider = { id: "openai", model: "gpt-5.6-terra", label: "OpenAI gpt-5.6-terra", live: false, step: async (r) => { asked.push(r.effort); return finalResult("Nothing to change today."); } };
    const executor = createFakeExecutor(CHAT_TOOLS.map((name) => ({ name, effect: "read" as const })));
    const rt = createAgentRuntime({
      db, clock, executor, provider: p, env, ledger: createSpendLedger({ dir: join(dataDir, "spend"), caps: { runUsd: 0.1, dayUsd: 2, liveUsd: 0.5 } }),
      routinesView: { get: async () => null, checklist: async () => [] },
      contextSource: { chat: async () => ({ actingFor: "Dana Reyes (demo) (usr_0001), role admin", grants: {}, companySummary: "Larkspur Robotics (demo).", openLoops: [] }) },
    });
    const h = { runId: "run_0001", token: "tok" };
    await rt.startChat(h, { text: "Anything to do today?", recipe: "chat", pageContext: null });
    const run = await rt.settled(h.runId);
    await rt.drain(5_000);
    return { effort: run.effort, asked };
  }

  it("WEFT_EFFORT=high: the run row and every model step say high", async () => {
    const r = await chatRun({ WEFT_EFFORT: "high" });
    expect(r.effort).toBe("high");
    expect(r.asked.length).toBeGreaterThan(0);
    expect(new Set(r.asked)).toEqual(new Set(["high"]));
  });

  it("unset: the per-stage default (low) is unchanged", async () => {
    const r = await chatRun({});
    expect(r.effort).toBe("low");
    expect(new Set(r.asked)).toEqual(new Set(["low"]));
  });
});

describe("gpt-5.6-terra prices", () => {
  it("prices Terra at $2.00 input, $0.20 cached and $12.00 output per million; Luna and the provider tables are unchanged", () => {
    expect(TERRA).toEqual({ inPerM: 2, cachedPerM: 0.2, outPerM: 12 });
    expect(pricesFor("openai", {}, "gpt-5.6-terra")).toEqual(TERRA);
    expect(pricesFor("openai", {}, "gpt-5.6-luna")).toEqual(LUNA);
    expect(pricesFor("openai", {})).toEqual(LUNA);
    expect(pricesFor("openai", {}, "toString")).toEqual(LUNA);
    // 10,000 input (8,000 cached) and 500 output (300 of them reasoning): 2,000 * 2 + 8,000 * 0.2 + 500 * 12 = 11,600 micro dollars.
    expect(usdToMicros(stepCostUsd({ input: 10_000, cached: 8_000, cacheWrite: 0, output: 500, reasoning: 300 }, pricesFor("openai", {}, "gpt-5.6-terra")))).toBe(11_600);
    // The same usage on Luna is a tenth of it.
    expect(usdToMicros(stepCostUsd({ input: 10_000, cached: 8_000, cacheWrite: 0, output: 500, reasoning: 300 }, LUNA))).toBe(1_160);
    // WEFT_PRICES_JSON still overrides any field.
    expect(pricesFor("openai", { WEFT_PRICES_JSON: JSON.stringify({ outPerM: 10 }) }, "gpt-5.6-terra")).toEqual({ inPerM: 2, cachedPerM: 0.2, outPerM: 10 });
  });

  it("scales the run cap 10x for Terra so its first step fits, and keeps Luna and Claude as they were", () => {
    expect(runCapScaleFor("openai", "gpt-5.6-terra")).toBe(10);
    expect(runCapScaleFor("openai", "gpt-5.6-luna")).toBe(1);
    expect(runCapScaleFor("openai")).toBe(1);
    expect(runCapScaleFor("claude", "claude-opus-5-5")).toBe(6);
  });
});
