// Provider choice on hosted (providers/hosted.ts; docs/cloudflare/design.md 5.2, 5.3, 6.3 and 6.5). KV model.provider
// is the default and the world setting overrides it; the provider is chosen once at run creation and pinned on the
// run row; the scripted provider with its honest badge takes over when the kill switch is on, the budget is nearly
// spent or the neurons are; and the factory's test guard still refuses the live providers.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProvider, ModelStepResult, PrecheckResult, RoutineDef, RoutineRun, SimClock } from "@weft/contracts";
import { HOSTED_CAP_DEFAULTS, type HostedProviderId, type HostedSpendStatus } from "../../../contracts/src/ext/cf-agent";
import { HOSTED_CONFIG_KEYS } from "../../../contracts/src/ext/cf-hosted";
import { closeDb, migrate, openDb, type Db } from "@weft/db";
import {
  bindSpendLedger, chooseHostedProvider, createAgentRuntime, createHostedProviderPool, createHostedSpendLedger, createSqlSpendStore, hostedProviderSet, inlineScriptSource,
  hostedProviderSelector, kvModelConfig, MIN_NEURONS_FOR_RUN, nodeProviderPorts, parseHostedProviderId, scriptedProvider, type HostedProviderChoice,
} from "../../src/index";
import { createFakeExecutor } from "../fake-executor";
import { sqliteStorage, type TestStorage } from "./sqlite-storage";

const status = (o: { day?: number; visitor?: number | null; ip?: number | null; live?: number; liveUsd?: number | null; neurons?: number; agent?: number } = {}): HostedSpendStatus => ({
  day: "2026-10-26",
  caps: { ...HOSTED_CAP_DEFAULTS, ...(o.liveUsd !== undefined ? { liveUsd: o.liveUsd } : {}) },
  spentMicros: { day: o.day ?? 0, visitor: o.visitor === undefined ? 0 : o.visitor, ip: o.ip === undefined ? 0 : o.ip, live: o.live ?? 0 },
  neurons: { used: o.neurons ?? 0, byProduct: { agent: o.agent ?? 0, ocr: 0, embeddings: 0, dictation: 0, speech: 0 } },
  openReservations: 0,
});
const all = new Set<HostedProviderId>(["openai", "workers_ai", "scripted"]);
const choose = (o: Partial<Parameters<typeof chooseHostedProvider>[0]>) => chooseHostedProvider({ agentEnabled: true, configured: null, world: null, available: all, status: status(), ...o });

describe("chooseHostedProvider", () => {
  it("defaults to OpenAI; KV model.provider sets the default; the world's setting overrides it; junk is ignored", () => {
    expect(choose({})).toEqual({ id: "openai", reason: "default" });
    expect(choose({ configured: "workers_ai" })).toEqual({ id: "workers_ai", reason: "default" });
    expect(choose({ configured: "workers_ai", world: "openai" })).toEqual({ id: "openai", reason: "world" });
    expect(choose({ configured: "scripted" })).toEqual({ id: "scripted", reason: "default" });
    expect(choose({ configured: "claude", world: "gpt-9" })).toEqual({ id: "openai", reason: "default" });
    expect(parseHostedProviderId(" workers_ai ")).toBe("workers_ai");
    expect(parseHostedProviderId("openai_compat")).toBeNull();
  });

  it("the kill switch, the budget and the neurons each fall back to scripted with the reason the banner shows", () => {
    expect(choose({ agentEnabled: false })).toEqual({ id: "scripted", reason: "paused" });
    // Less than $0.01 left for the day, the visitor or the IP hash.
    expect(choose({ status: status({ day: 1_990_001 }) })).toEqual({ id: "scripted", reason: "budget" });
    expect(choose({ status: status({ day: 1_990_000 }) })).toEqual({ id: "openai", reason: "default" });
    expect(choose({ status: status({ visitor: 1_995_000 }) })).toEqual({ id: "scripted", reason: "budget" });
    expect(choose({ status: status({ ip: 1_999_999 }) })).toEqual({ id: "scripted", reason: "budget" });
    // No live cap by default; when one is set, it counts too.
    expect(choose({ status: status({ live: 99_000_000 }) })).toEqual({ id: "openai", reason: "default" });
    expect(choose({ status: status({ live: 499_000, liveUsd: 0.5 }) })).toEqual({ id: "scripted", reason: "budget" });
    // Neurons matter only to Workers AI.
    expect(choose({ world: "workers_ai", status: status({ neurons: HOSTED_CAP_DEFAULTS.neuronsDay - MIN_NEURONS_FOR_RUN + 1 }) })).toEqual({ id: "scripted", reason: "neurons" });
    expect(choose({ world: "workers_ai", status: status({ agent: 4000 - MIN_NEURONS_FOR_RUN + 1 }) })).toEqual({ id: "scripted", reason: "neurons" });
    expect(choose({ world: "workers_ai", status: status({ neurons: 1000, agent: 1000 }) })).toEqual({ id: "workers_ai", reason: "world" });
    expect(choose({ status: status({ neurons: 5000 }) })).toEqual({ id: "openai", reason: "default" });
    // A provider this world cannot build, and slot-smoke, are scripted.
    expect(choose({ world: "workers_ai", available: new Set(["openai", "scripted"]) })).toEqual({ id: "scripted", reason: "world" });
    expect(choose({ forced: "scripted", configured: "openai" })).toEqual({ id: "scripted", reason: "default" });
    // An unreadable status applies no budget fallback here (the reservation still enforces every cap).
    expect(choose({ status: null })).toEqual({ id: "openai", reason: "default" });
  });

  it("KV agent.enabled, model.provider and aig.collect_log are read at most once per 60 s; a KV error keeps the last values", async () => {
    const values: Record<string, string> = { [HOSTED_CONFIG_KEYS.modelProvider]: "workers_ai" };
    let t = 0;
    let fail = false;
    const cfg = kvModelConfig({ get: async (k) => { if (fail) throw new Error("kv down"); return values[k] ?? null; } }, { now: () => t });
    expect(cfg.last()).toBeNull();
    expect(await cfg()).toEqual({ agentEnabled: true, provider: "workers_ai", collectLog: null });
    values[HOSTED_CONFIG_KEYS.agentEnabled] = "false";
    values[HOSTED_CONFIG_KEYS.aigCollectLog] = "false";
    expect(await cfg()).toEqual({ agentEnabled: true, provider: "workers_ai", collectLog: null });
    t = 60_000;
    expect(await cfg()).toEqual({ agentEnabled: false, provider: "workers_ai", collectLog: false });
    expect(cfg.last()).toEqual({ agentEnabled: false, provider: "workers_ai", collectLog: false });
    fail = true;
    t = 999_999;
    expect(await cfg()).toEqual({ agentEnabled: false, provider: "workers_ai", collectLog: false });
    expect(await kvModelConfig({ get: async () => { throw new Error("down"); } })()).toEqual({ agentEnabled: true, provider: null, collectLog: null });
  });

  it("the selector reads KV, the world setting and the lease's status per run; a failing source is read as absent", async () => {
    const sel = (o: Partial<Parameters<typeof hostedProviderSelector>[0]>) => hostedProviderSelector({
      config: async () => ({ agentEnabled: true, provider: "workers_ai", collectLog: null }), worldSetting: () => null, status: async () => status(), ...o,
    })(all);
    expect(await sel({})).toEqual({ id: "workers_ai", reason: "default" });
    expect(await sel({ worldSetting: async () => "openai" })).toEqual({ id: "openai", reason: "world" });
    expect(await sel({ config: async () => ({ agentEnabled: false, provider: "openai", collectLog: null }) })).toEqual({ id: "scripted", reason: "paused" });
    expect(await sel({ status: async () => status({ day: 2_000_000 }) })).toEqual({ id: "scripted", reason: "budget" });
    expect(await sel({ status: async () => { throw new Error("SpendDO unreachable"); }, worldSetting: () => { throw new Error("no row"); } })).toEqual({ id: "workers_ai", reason: "default" });
    expect(await sel({ config: async () => { throw new Error("kv"); } })).toEqual({ id: "openai", reason: "default" });
    expect(await sel({ forced: "scripted", status: async () => { throw new Error("never read"); } })).toEqual({ id: "scripted", reason: "default" });
  });

  it("the hosted provider set builds each provider through the factory: in tests the live ones are refused", () => {
    const env = { VITEST: "true", OPENAI_API_KEY: "sk-test-not-real" };
    const scripts = inlineScriptSource({});
    const set = hostedProviderSet({ env, ledger: null as never, testMode: true, scriptSource: scripts, ai: { run: async () => ({}) } }, nodeProviderPorts({ env, scriptSource: scripts }));
    expect(Object.keys(set.providers)).toEqual(["scripted"]);
    expect(set.refused.openai).toMatch(/LIVE_PROVIDER_IN_TEST/);
    expect(set.refused.workers_ai).toMatch(/LIVE_PROVIDER_IN_TEST/);
    const live = hostedProviderSet({ env: { ...env, WEFT_LIVE_OPENAI: "1" }, ledger: null as never, testMode: true, scriptSource: scripts, ai: { run: async () => ({}) } }, nodeProviderPorts({ env: { ...env, WEFT_LIVE_OPENAI: "1" }, scriptSource: scripts }));
    expect(Object.keys(live.providers).sort()).toEqual(["openai", "scripted", "workers_ai"]);
    expect(live.refused).toEqual({});
  });
});

// The pool in the runtime -------------------------------------------------------------------------------------------

const clock: SimClock = { now: () => "2026-10-26T16:00:00.000Z", rate: () => 0, advance: async () => undefined, set: async () => undefined };
let dataDir: string;
let db: Db;
let storage: TestStorage;
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "weft-pool-"));
  db = openDb({ dataDir });
  await migrate(db);
  storage = sqliteStorage();
});
afterEach(async () => {
  await closeDb(db);
  storage.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A live stand-in for a provider id: it records the requests it served. */
function liveFake(id: "openai" | "workers_ai", model: string) {
  const served: string[] = [];
  const p = {
    id, model, label: `${id} fake`, live: true,
    async step(req): Promise<ModelStepResult> {
      served.push(req.runId);
      const text = `Answered by ${id}.`;
      return { stop: "final", text, toolCalls: [], native: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input: 50, cached: 0, cacheWrite: 0, output: 5, reasoning: 0 }, servedBy: model, requestId: null };
    },
  } as ModelProvider;
  return { p, served };
}

describe("the provider pool in the runtime", () => {
  it("acceptance: the provider is chosen once at run creation and pinned: a requeued run stays on it after the default changes", async () => {
    const openai = liveFake("openai", "gpt-5.6-luna");
    const wai = liveFake("workers_ai", "@cf/openai/gpt-oss-120b");
    const scripted = scriptedProvider({ source: inlineScriptSource({}) });
    let want: HostedProviderChoice = { id: "workers_ai", reason: "world" };
    const pool = createHostedProviderPool({ set: { providers: { openai: openai.p, workers_ai: wai.p, scripted }, refused: {} }, select: async () => want });
    const hosted = createHostedSpendLedger({ store: createSqlSpendStore(storage) });
    const ledger = bindSpendLedger(hosted, { world: () => "slot-1:gen-1", visitor: () => "vis_a", ipHash: () => "ip_a" });
    const fake = createFakeExecutor([{ name: "tax.update_rate", effect: "write", gated: true }]);
    const routine: RoutineDef = {
      id: "rt_demo", name: "Demo", description: "d", ownerPrincipalId: "usr_0001", enabled: true, autonomy: "approve", trigger: { type: "event", event: "notice.received" }, filter: null,
      instructions: "Do it.", tools: ["tax.update_rate"], precheck: "agency_notice", budget: { steps: 6, usd: 0.1, minutes: 10 }, surface: { worthSurfacing: true, channel: null }, source: "prebuilt", taintedBy: null,
      checklist: [{ id: "rate", label: "propose tax.update_rate", check: "x" }],
    };
    const rt = createAgentRuntime({
      db, clock, executor: fake, provider: openai.p, ledger, providers: pool, scriptSource: inlineScriptSource({}), env: { WEFT_BACKGROUND_LLM: "1" },
      routinesView: { get: async () => routine, checklist: async () => [{ id: "rate", label: "propose tax.update_rate", passed: false }] },
    });
    const chat = { runId: "run_0001", token: "tok" };
    await rt.startChat(chat, { text: "Hello", recipe: "chat", pageContext: null });
    expect(await rt.settled(chat.runId)).toMatchObject({ status: "done", provider: "workers_ai", model: "@cf/openai/gpt-oss-120b", summary: "Answered by workers_ai." });
    expect(pool.last).toEqual({ id: "workers_ai", reason: "world" });

    // A routine run on Workers AI waits for approval; then the default flips to OpenAI; the woken run stays put.
    const h = { runId: "run_0002", token: "tok" };
    const routineRun: RoutineRun = { id: "rtr_0001", routineId: routine.id, runKey: "k", triggerRef: "evt_0001", status: "running", agentRunId: null, precheck: null, summary: null, leftForHuman: [], surfaceHash: null, overdue: false, attended: false, startedAt: null, endedAt: null, costUsdMicros: 0 };
    const precheck: PrecheckResult = { action: "run", severity: "interrupt", subjectRefs: [], findings: {}, derivedArgs: null };
    await rt.startRoutineRun(h, { routine, routineRun, trigger: null, precheck });
    // An unattended routine under WEFT_BACKGROUND_LLM=1 runs on the live provider, not the templates.
    const first = await rt.settled(h.runId);
    expect(first.provider).toBe("workers_ai");
    want = { id: "openai", reason: "default" };
    await rt.store.updateRun(h.runId, { status: "waiting" });
    await rt.requeue(h.runId, { kind: "decision", attrs: {}, text: "approved" });
    const after = await rt.settled(h.runId);
    expect(after.provider).toBe("workers_ai");
    expect(wai.served.filter((r) => r === h.runId).length).toBeGreaterThanOrEqual(2);
    expect(openai.served).not.toContain(h.runId);

    // A new run takes the new default.
    const next = { runId: "run_0003", token: "tok" };
    await rt.startChat(next, { text: "Hello again", recipe: "chat", pageContext: null });
    expect(await rt.settled(next.runId)).toMatchObject({ provider: "openai", summary: "Answered by openai." });
  });

  it("a budget fallback creates the run on the scripted provider with its honest badge", async () => {
    const openai = liveFake("openai", "gpt-5.6-luna");
    const scripted = scriptedProvider({ source: inlineScriptSource({ hi: { match: "Hello", agents: { main: [{ output: [{ type: "text", text: "Scripted answer." }] }] } } }) });
    const hosted = createHostedSpendLedger({ store: createSqlSpendStore(storage) });
    const ledger = bindSpendLedger(hosted, { world: () => "slot-1:gen-1", visitor: () => "vis_a", ipHash: () => "ip_a" });
    const pool = createHostedProviderPool({
      set: { providers: { openai: openai.p, scripted }, refused: {} },
      select: async (available) => chooseHostedProvider({ agentEnabled: true, configured: "openai", world: null, available, status: status({ visitor: 1_995_000 }) }),
    });
    const rt = createAgentRuntime({ db, clock, executor: createFakeExecutor([]), provider: openai.p, ledger, providers: pool, scriptSource: inlineScriptSource({}), routinesView: { get: async () => null } });
    const h = { runId: "run_0010", token: "tok" };
    await rt.startChat(h, { text: "Hello", recipe: "chat", pageContext: null });
    expect(await rt.settled(h.runId)).toMatchObject({ status: "done", provider: "scripted", model: "scripted", summary: "Scripted answer.", costUsdMicros: 0 });
    expect(pool.last).toEqual({ id: "scripted", reason: "budget" });
    expect(openai.served).toEqual([]);
  });

  it("without WEFT_BACKGROUND_LLM=1 an unattended routine run under a live default uses the templates, as on Node", async () => {
    const openai = liveFake("openai", "gpt-5.6-luna");
    const scripted = scriptedProvider({ source: inlineScriptSource({}) });
    const pool = createHostedProviderPool({ set: { providers: { openai: openai.p, scripted }, refused: {} }, select: async () => ({ id: "openai", reason: "default" }) });
    const hosted = createHostedSpendLedger({ store: createSqlSpendStore(storage) });
    const ledger = bindSpendLedger(hosted, { world: () => "slot-1:gen-1", visitor: () => null, ipHash: () => null });
    const routine = { id: "rt_x", name: "X", tools: [], checklist: [], budget: { steps: 6, usd: 0.1, minutes: 10 }, instructions: "x", ownerPrincipalId: "usr_0001" } as unknown as RoutineDef;
    const rt = createAgentRuntime({ db, clock, executor: createFakeExecutor([]), provider: openai.p, ledger, providers: pool, scriptSource: inlineScriptSource({}), env: {}, routinesView: { get: async () => routine } });
    const h = { runId: "run_0020", token: "tok" };
    await rt.startRoutineRun(h, { routine, routineRun: { id: "rtr_9", routineId: "rt_x", runKey: "k", triggerRef: "t", status: "running", agentRunId: null, precheck: null, summary: null, leftForHuman: [], surfaceHash: null, overdue: false, attended: false, startedAt: null, endedAt: null, costUsdMicros: 0 }, trigger: null, precheck: { action: "run", severity: "digest", subjectRefs: [], findings: {}, derivedArgs: null } });
    expect(await rt.settled(h.runId)).toMatchObject({ provider: "scripted", model: "template" });
    expect(openai.served).toEqual([]);
  });
});
