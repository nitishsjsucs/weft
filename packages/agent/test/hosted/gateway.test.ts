// The OpenAI provider through AI Gateway (providers/gateway.ts and openai.ts; docs/cloudflare/design.md 5.1, 8.1 and
// 9.3; tracks.md cf3-agent). The SDK is real and the network is a fake fetch, so no call leaves the machine. Pinned:
// the request differs from a direct one only in URL and headers; a gateway cache HIT settles $0; BYOK sends no
// Authorization; a call inside a transaction is IO_IN_TX; and a routine run inside one alarm stays within the
// invocation's fetch budget.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProvider, ModelStepRequest, PrecheckResult, RoutineDef, RoutineRun, SimClock } from "@weft/contracts";
import { MAX_FETCHES_PER_ALARM } from "../../../contracts/src/ext/cf-agent";
import { closeDb, migrate, openDb, type Db } from "@weft/db";
import {
  aiGatewayFromEnv, aigKindOf, aigMetadataHeader, alarmRunHost, bindSpendLedger, createAgentRuntime, createFetchCounter, createHostedSpendLedger, createProvider,
  createSqlSpendStore, gatewayCacheHit, inlineScriptSource, openaiProvider, openAiGatewayTransport, type GatewayTransportOptions, type WeftAgentRuntime,
} from "../../src/index";
import { createFakeExecutor } from "../fake-executor";
import { sqliteStorage, type TestStorage } from "./sqlite-storage";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", `${name}.json`), "utf8")) as Record<string, unknown>;

interface Captured { url: string; method: string; headers: Record<string, string>; body: string }

/** A fake network: records every request and answers with `reply`. */
function network(reply: (n: number) => Response = () => json(fixture("tool-call"))) {
  const seen: Captured[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as never, init);
    seen.push({ url: req.url, method: req.method, headers: Object.fromEntries(req.headers), body: await req.text() });
    return reply(seen.length);
  }) as typeof globalThis.fetch;
  return { seen, fetch };
}
const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": "req_fake", ...headers } });

const req: ModelStepRequest = {
  runId: "run_0001", agentKind: "main", model: "gpt-5.6-luna", frozenPrompt: "FROZEN", toolChoice: { mode: "auto" },
  history: [{ kind: "context", text: "<context n=\"abc\">pack</context>" }],
  tools: [{ name: "notices__get", description: "Read a notice.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } }],
  effort: "low", maxOutputTokens: 8000, cacheKey: "weft:main:rt_agency_notice:cmp_larkspur",
};
const gateway = { accountId: "acct_0123", gateway: "weft-gw", token: "aig_tok_not_real" };
const world = () => ({ slot: "slot-1", gen: 3, visitor: "vis_a" });
const viaGateway = (fetch: typeof globalThis.fetch, o: Partial<GatewayTransportOptions> = {}) =>
  openaiProvider({ apiKey: "sk-test-not-real", model: "gpt-5.6-luna", gateway: openAiGatewayTransport({ gateway, world, fetch, ...o }) });

describe("AI Gateway transport", () => {
  it("acceptance: the request snapshot differs from a direct request only in URL and headers", async () => {
    const direct = network();
    const viaGw = network();
    await openaiProvider({ apiKey: "sk-test-not-real", model: "gpt-5.6-luna", fetch: direct.fetch }).step(req);
    await viaGateway(viaGw.fetch).step(req);
    const [d, g] = [direct.seen[0]!, viaGw.seen[0]!];
    expect(g.body).toBe(d.body);
    expect(g.method).toBe("POST");
    const added = Object.fromEntries(Object.entries(g.headers).filter(([k, v]) => d.headers[k] !== v));
    const removed = Object.keys(d.headers).filter((k) => !(k in g.headers));
    const body = JSON.parse(g.body) as Record<string, unknown>;
    const snapshot = {
      direct: { url: d.url },
      gateway: { url: g.url, addedHeaders: added },
      removedHeaders: removed,
      body: { sha256: createHash("sha256").update(g.body).digest("hex"), keys: Object.keys(body), store: body.store, prompt_cache_key: body.prompt_cache_key },
    };
    await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot("./__snapshots__/openai-gateway-request.json");
    // The load-bearing parts, asserted outright so a careless snapshot update cannot drop them.
    expect(d.url).toBe("https://api.openai.com/v1/responses");
    expect(g.url).toBe("https://gateway.ai.cloudflare.com/v1/acct_0123/weft-gw/openai/responses");
    expect(added).toEqual({
      "cf-aig-metadata": JSON.stringify({ slot: "slot-1", gen: 3, run: "run_0001", kind: "routine", visitor: "vis_a" }),
      "cf-aig-authorization": "Bearer aig_tok_not_real",
    });
    expect(removed).toEqual([]);
    // No overrides of the gateway's own logging and caching.
    expect(Object.keys(g.headers).filter((k) => /cf-aig-(skip-cache|collect-log|cache-ttl)/.test(k))).toEqual([]);
  });

  it("an unauthenticated gateway sends no cf-aig-authorization; metadata leaves out what is unknown", async () => {
    const n = network();
    const p = openaiProvider({ apiKey: "sk-test-not-real", model: "gpt-5.6-luna", gateway: openAiGatewayTransport({ gateway: { accountId: "a", gateway: "g", token: null }, fetch: n.fetch }) });
    await p.step({ ...req, cacheKey: "weft:main:chat:cmp_larkspur" });
    expect(n.seen[0]!.headers["cf-aig-authorization"]).toBeUndefined();
    expect(n.seen[0]!.headers["cf-aig-metadata"]).toBe(JSON.stringify({ run: "run_0001", kind: "chat" }));
    expect(n.seen[0]!.headers.authorization).toBe("Bearer sk-test-not-real");
  });

  it("the aig.collect_log lever: false asks the gateway to keep no log; unset or true sends no override", async () => {
    let lever: boolean | null = null;
    const n = network();
    const p = viaGateway(n.fetch, { collectLog: () => lever });
    await p.step(req);
    lever = true;
    await p.step(req);
    lever = false;
    await p.step(req);
    expect(n.seen.map((r) => r.headers["cf-aig-collect-log"] ?? null)).toEqual([null, null, "false"]);
  });

  it("BYOK: the gateway holds the key, so no Authorization header leaves the Worker; it needs the gateway token", async () => {
    const n = network();
    await openaiProvider({ apiKey: "byok", model: "gpt-5.6-luna", gateway: openAiGatewayTransport({ gateway, byok: true, fetch: n.fetch }) }).step(req);
    expect(n.seen[0]!.headers.authorization).toBeUndefined();
    expect(n.seen[0]!.headers["cf-aig-authorization"]).toBe("Bearer aig_tok_not_real");
    expect(() => openAiGatewayTransport({ gateway: { ...gateway, token: null }, byok: true })).toThrow(/BYOK needs CF_AIG_TOKEN/);
  });

  it("reads the gateway's cache verdict: only cf-aig-cache-status HIT counts", async () => {
    expect(gatewayCacheHit(new Headers({ "cf-aig-cache-status": "HIT" }))).toBe(true);
    expect(gatewayCacheHit(new Headers({ "cf-aig-cache-status": "hit " }))).toBe(true);
    expect(gatewayCacheHit(new Headers({ "cf-aig-cache-status": "MISS" }))).toBe(false);
    expect(gatewayCacheHit(new Headers())).toBe(false);
    expect(gatewayCacheHit(null)).toBe(false);
    const hit = network(() => json(fixture("tool-call"), { "cf-aig-cache-status": "HIT" }));
    expect(await viaGateway(hit.fetch).step(req)).toMatchObject({ stop: "tool_calls", gatewayCacheHit: true, requestId: "req_fake" });
    const miss = network(() => json(fixture("tool-call"), { "cf-aig-cache-status": "MISS" }));
    expect(await viaGateway(miss.fetch).step(req)).not.toHaveProperty("gatewayCacheHit");
  });

  it("a model call inside a database transaction throws IO_IN_TX and sends nothing", async () => {
    const n = network();
    const guard = { assertNotInTx: (what: string) => { throw Object.assign(new Error(`IO_IN_TX: ${what} inside a transaction`), { code: "IO_IN_TX" }); } };
    await expect(viaGateway(n.fetch, { guard }).step(req)).rejects.toMatchObject({ code: "IO_IN_TX" });
    expect(n.seen).toEqual([]);
  });

  it("without a gateway the direct OpenAI call is guarded too: inside a transaction it throws IO_IN_TX and sends nothing", async () => {
    const env = { VITEST: "true", WEFT_LLM: "openai", OPENAI_API_KEY: "sk-test-not-real", WEFT_LIVE_OPENAI: "1" };
    // Scoped to the async context of its transaction, as the facade's guard is (packages/db/src/tx-guard.ts; the brain
    // may not import it, tests/boundaries.test.ts).
    const tx = new AsyncLocalStorage<true>();
    const guard = { assertNotInTx: (what: string) => { if (tx.getStore()) throw Object.assign(new Error(`IO_IN_TX: ${what} inside a transaction`), { code: "IO_IN_TX" }); } };
    const n = network();
    const p = createProvider({ env, ledger: null as never, testMode: true, envOnlySecrets: true, fetch: n.fetch, guard });
    await expect(tx.run(true, () => p.step(req))).rejects.toMatchObject({ code: "IO_IN_TX" });
    expect(n.seen).toEqual([]);
    // Outside the transaction the same provider reaches OpenAI directly, and the fetch budget applies as on the gateway.
    expect(await p.step(req)).toMatchObject({ stop: "tool_calls" });
    expect(n.seen.map((r) => r.url)).toEqual(["https://api.openai.com/v1/responses"]);
    const counted = createProvider({ env, ledger: null as never, testMode: true, envOnlySecrets: true, fetch: n.fetch, counter: createFetchCounter({ max: 0 }) });
    expect((await counted.step(req)).error?.message).toMatch(/FETCH_BUDGET/);
    expect(n.seen).toHaveLength(1);
  });

  it("a fetch past the invocation's budget is refused before it is sent and is not retried", async () => {
    const n = network();
    const counter = createFetchCounter({ max: 0 });
    const r = await viaGateway(n.fetch, { counter }).step(req);
    expect(r).toMatchObject({ stop: "error", error: { code: "PROVIDER_UNAVAILABLE", retryable: false } });
    expect(r.error!.message).toMatch(/FETCH_BUDGET/);
    expect(n.seen).toEqual([]);
  });

  it("gateway settings, call kinds and the metadata header", () => {
    expect(aiGatewayFromEnv({})).toBeNull();
    expect(aiGatewayFromEnv({ WEFT_AIG_ACCOUNT_ID: "a" })).toBeNull();
    expect(aiGatewayFromEnv({ WEFT_AIG_ACCOUNT_ID: " a ", WEFT_AIG_GATEWAY: "g" })).toEqual({ accountId: "a", gateway: "g", token: null });
    expect(aiGatewayFromEnv({ WEFT_AIG_ACCOUNT_ID: "a", WEFT_AIG_GATEWAY: "g", CF_AIG_TOKEN: "t" })).toEqual({ accountId: "a", gateway: "g", token: "t" });
    expect(["weft:main:chat:c", "weft:main:routine_draft:c", "weft:main:rt_agency_notice:c", "weft:main:assist:c"].map(aigKindOf)).toEqual(["chat", "draft", "routine", "assist"]);
    const h = JSON.parse(aigMetadataHeader({ slot: "slot-2", gen: 1, run: null, kind: "embed", visitor: null })) as Record<string, unknown>;
    expect(h).toEqual({ slot: "slot-2", gen: 1, kind: "embed" });
    expect(Object.keys(JSON.parse(aigMetadataHeader({ slot: "s", gen: 1, run: "r", kind: "chat", visitor: "v" })))).toHaveLength(5);
  });

  it("the factory routes OpenAI through the gateway when its account and name are set, and still refuses live providers in tests", async () => {
    const env = { VITEST: "true", WEFT_LLM: "openai", OPENAI_API_KEY: "sk-test-not-real", WEFT_AIG_ACCOUNT_ID: "acct_0123", WEFT_AIG_GATEWAY: "weft-gw" };
    expect(() => createProvider({ env, ledger: null as never, testMode: true })).toThrow(/LIVE_PROVIDER_IN_TEST/);
    const n = network();
    const p = createProvider({ env: { ...env, WEFT_LIVE_OPENAI: "1" }, ledger: null as never, testMode: true, fetch: n.fetch, world });
    await p.step(req);
    expect(n.seen[0]!.url).toBe("https://gateway.ai.cloudflare.com/v1/acct_0123/weft-gw/openai/responses");
    const direct = network();
    await createProvider({ env: { VITEST: "true", WEFT_LLM: "openai", OPENAI_API_KEY: "sk-test-not-real", WEFT_LIVE_OPENAI: "1" }, ledger: null as never, testMode: true, fetch: direct.fetch }).step(req);
    expect(direct.seen[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(() => createProvider({ env: { ...env, WEFT_LIVE_OPENAI: "1", WEFT_AIG_BYOK: "1" }, ledger: null as never, testMode: true })).toThrow(/PROVIDER_CONFIG: WEFT_AIG_BYOK=1 needs CF_AIG_TOKEN/);
  });
});

// Runs through the loop --------------------------------------------------------------------------------------------

const clock: SimClock = { now: () => "2026-10-26T16:00:00.000Z", rate: () => 0, advance: async () => undefined, set: async () => undefined };
let dataDir: string;
let db: Db;
let storage: TestStorage;
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "weft-gateway-"));
  db = openDb({ dataDir });
  await migrate(db);
  storage = sqliteStorage();
});
afterEach(async () => {
  await closeDb(db);
  storage.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function runtimeWith(provider: ModelProvider, extra: { runHost?: ReturnType<typeof alarmRunHost>; routine?: RoutineDef } = {}) {
  const hosted = createHostedSpendLedger({ store: createSqlSpendStore(storage) });
  const ledger = bindSpendLedger(hosted, { world: () => "slot-1:gen-3", visitor: () => "vis_a", ipHash: () => "ip_a" });
  const executor = createFakeExecutor([{ name: "notices.get", effect: "read" }]);
  const rt: WeftAgentRuntime = createAgentRuntime({
    db, clock, executor, provider, ledger, scriptSource: inlineScriptSource({}),
    routinesView: { get: async () => extra.routine ?? null, checklist: async () => [{ id: "send", label: "propose notices.send_response", passed: false }] },
    ...(extra.runHost ? { runHost: extra.runHost } : {}), env: { WEFT_BACKGROUND_LLM: "1" },
  });
  return { rt, hosted, executor };
}

const finalAnswer = (text: string) => ({ ...fixture("tool-call"), output: [{ id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text }] }] });

describe("gateway calls through the agent loop", () => {
  it("acceptance: a gateway cache HIT settles $0 while a MISS is charged", async () => {
    for (const status of ["HIT", "MISS"] as const) {
      const n = network(() => json(finalAnswer("The notice is a rate change."), { "cf-aig-cache-status": status }));
      const { rt, hosted } = runtimeWith(viaGateway(n.fetch));
      const h = { runId: `run_${status}`, token: "tok" };
      await rt.startChat(h, { text: "What is the notice about?", recipe: "chat", pageContext: null });
      const run = await rt.settled(h.runId);
      expect(run.status, status).toBe("done");
      const model = (await rt.store.steps(h.runId)).find((s) => s.kind === "model_call")!;
      expect(model.usage!.input).toBeGreaterThan(0);
      if (status === "HIT") {
        expect(run.costUsdMicros).toBe(0);
        expect(model.costUsdMicros).toBe(0);
        expect(model.result).toMatchObject({ gatewayCache: "HIT" });
        expect(await hosted.spent({ day: new Date().toISOString().slice(0, 10) })).toBe(0);
      } else {
        expect(run.costUsdMicros).toBeGreaterThan(0);
        expect(model.result).not.toHaveProperty("gatewayCache");
        expect(await hosted.spent({ day: new Date().toISOString().slice(0, 10) })).toBe(run.costUsdMicros);
      }
    }
  });

  it("acceptance: a routine run inside one alarm (6 steps, each after two retried 500s) makes 18 counted fetches, under 40", async () => {
    const routine: RoutineDef = {
      id: "rt_agency_notice", name: "Agency notice handling", description: "d", ownerPrincipalId: "usr_0001", enabled: true, autonomy: "approve",
      trigger: { type: "event", event: "notice.received" }, filter: null, instructions: "Handle the notice.", tools: ["notices.get"],
      precheck: "agency_notice", budget: { steps: 6, usd: 0.1, minutes: 10 }, surface: { worthSurfacing: true, channel: null }, source: "prebuilt", taintedBy: null,
      checklist: [{ id: "send", label: "propose notices.send_response", check: "proposal_exists:notices.send_response:{notice_id}" }],
    };
    const routineRun: RoutineRun = { id: "rtr_0001", routineId: routine.id, runKey: "k", triggerRef: "evt_0001", status: "running", agentRunId: null, precheck: null, summary: null, leftForHuman: [], surfaceHash: null, overdue: false, attended: false, startedAt: null, endedAt: null, costUsdMicros: 0 };
    const precheck: PrecheckResult = { action: "run", severity: "interrupt", subjectRefs: ["ntc_0001"], findings: { agency: "ca_edd" }, derivedArgs: null };
    const n = network((k) => (k % 3 === 0
      ? json({ ...fixture("tool-call"), output: [{ id: `fc_${k}`, type: "function_call", status: "completed", arguments: "{\"notice_id\":\"ntc_0001\"}", call_id: `call_${k}`, name: "notices__get" }] })
      : json({ error: { message: "server error", type: "server_error" } }, {}, 500)));
    const counter = createFetchCounter();
    const host = alarmRunHost({ counter });
    const { rt } = runtimeWith(viaGateway(n.fetch, { counter }), { runHost: host, routine });
    const h = { runId: "run_0100", token: "tok" };
    await rt.startRoutineRun(h, { routine, routineRun, trigger: { id: "evt_0001", type: "notice.received", ts: "2026-10-26T16:00:00.000Z", subjectRef: "ntc_0001", payload: { notice_id: "ntc_0001" }, attended: false, requestedBy: null }, precheck });
    expect(n.seen).toHaveLength(0);
    const drained = await host.drain();
    expect(drained).toMatchObject({ started: 1, liveStarted: 1, fetches: 18 });
    expect(drained.fetches!).toBeLessThanOrEqual(MAX_FETCHES_PER_ALARM);
    expect(n.seen).toHaveLength(18);
    const run = (await rt.store.getRun(h.runId))!;
    expect(run).toMatchObject({ status: "escalated", terminalReason: "BUDGET_EXCEEDED", stepsUsed: 6, provider: "openai" });
  });
});
