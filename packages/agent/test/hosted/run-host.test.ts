// RunHost (run-host.ts; docs/cloudflare/design.md 3.3 and 8.1; tracks.md cf3-agent). With a deferring host (the alarm
// host CompanyDO uses), runs start only when it drains, settled waiters and SSE subscribers still fire, and live
// concurrency stays 1: each invocation starts at most one live run and arms again while runs remain. The immediate
// host keeps Node's behavior, and the boot rule is unchanged: a run that never started is lost with the isolate.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProvider, ModelStepResult, RunStepRow, SimClock } from "@weft/contracts";
import type { RunHost, RunHostJob } from "../../../contracts/src/ext/cf-agent";
import { closeDb, migrate, openDb, type Db } from "@weft/db";
import {
  alarmRunHost, bindSpendLedger, createAgentRuntime, createFetchCounter, createHostedSpendLedger, createSqlSpendStore, FetchBudgetExceeded, guardedFetch,
  immediateRunHost, inlineScriptSource, scriptedProvider, type WeftAgentRuntime,
} from "../../src/index";
import { createFakeExecutor } from "../fake-executor";
import { sqliteStorage, type TestStorage } from "./sqlite-storage";

const clock: SimClock = { now: () => "2026-10-26T16:00:00.000Z", rate: () => 0, advance: async () => undefined, set: async () => undefined };
let dataDir: string;
let db: Db;
let storage: TestStorage;
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "weft-runhost-"));
  db = openDb({ dataDir });
  await migrate(db);
  storage = sqliteStorage();
});
afterEach(async () => {
  await closeDb(db);
  storage.close();
  rmSync(dataDir, { recursive: true, force: true });
});

let n = 0;
const handle = () => ({ runId: `run_${String(++n).padStart(4, "0")}`, token: "tok" });
const scripts = inlineScriptSource({ hello: { match: "hello", agents: { main: [{ output: [{ type: "text", text: "Hello from the script." }] }] } } });

function runtime(provider: ModelProvider, runHost?: RunHost): WeftAgentRuntime {
  const hosted = createHostedSpendLedger({ store: createSqlSpendStore(storage) });
  const ledger = bindSpendLedger(hosted, { world: () => "slot-1:gen-1", visitor: () => "vis_a", ipHash: () => "ip_a" });
  return createAgentRuntime({
    db, clock, executor: createFakeExecutor([]), provider, ledger, routinesView: { get: async () => null }, scriptSource: scripts, ...(runHost ? { runHost } : {}),
  });
}

/** A live provider that answers at once and records how many of its calls overlap. */
function fakeLive() {
  const s = { calls: 0, inFlight: 0, maxInFlight: 0 };
  const provider: ModelProvider = {
    id: "openai", model: "gpt-5.6-luna", label: "OpenAI gpt-5.6-luna", live: true,
    async step(): Promise<ModelStepResult> {
      s.calls++;
      s.inFlight++;
      s.maxInFlight = Math.max(s.maxInFlight, s.inFlight);
      await new Promise((r) => setTimeout(r, 5));
      s.inFlight--;
      const text = "Here is the answer from the records.";
      return { stop: "final", text, toolCalls: [], native: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input: 100, cached: 0, cacheWrite: 0, output: 10, reasoning: 0 }, servedBy: "gpt-5.6-luna", requestId: null };
    },
  };
  return { provider, s };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("a deferring RunHost (the alarm host)", () => {
  it("acceptance: a run starts only when the host drains; settled waiters and SSE subscribers still fire", async () => {
    let arms = 0;
    const host = alarmRunHost({ arm: () => { arms++; } });
    const rt = runtime(scriptedProvider({ source: scripts }), host);
    const h = handle();
    const seen: RunStepRow[] = [];
    rt.subscribe(h.runId, (s) => seen.push(s));
    await rt.startChat(h, { text: "hello there", recipe: "chat", pageContext: null });
    let settled = false;
    const done = rt.settled(h.runId).then((row) => { settled = true; return row; });
    await tick();
    expect(settled).toBe(false);
    expect((await rt.store.getRun(h.runId))!.status).toBe("queued");
    expect(host.pending()).toEqual([h.runId]);
    expect(arms).toBe(1);
    expect(rt.queue.position(h.runId)).toBe(1);
    expect(seen.map((s) => s.kind)).toEqual(["context"]);

    expect(await host.drain()).toMatchObject({ started: 1, remaining: 0, liveStarted: 0 });
    const row = await done;
    expect(row).toMatchObject({ status: "done", terminalReason: "DONE", summary: "Hello from the script." });
    expect(seen.map((s) => s.kind)).toEqual(expect.arrayContaining(["context", "verify", "model_call"]));
    expect(seen.at(-1)).toMatchObject({ stage: "terminal" });
    expect(rt.queue.position(h.runId)).toBeNull();
    expect(host.armed).toBe(false);
    expect(arms).toBe(1);
  });

  it("acceptance: live concurrency stays 1: each drain starts one live run and arms again while runs remain", async () => {
    let arms = 0;
    const host = alarmRunHost({ arm: () => { arms++; } });
    const live = fakeLive();
    const rt = runtime(live.provider, host);
    const hs = [handle(), handle(), handle()];
    for (const h of hs) await rt.startChat(h, { text: "hello", recipe: "chat", pageContext: null });
    expect(host.pending()).toEqual(hs.map((h) => h.runId));
    expect(hs.map((h) => rt.queue.position(h.runId))).toEqual([1, 2, 3]);
    expect(arms).toBe(1);

    expect(await host.drain()).toMatchObject({ started: 1, remaining: 2, liveStarted: 1 });
    expect(arms).toBe(2);
    expect((await rt.store.getRun(hs[0]!.runId))!.status).toBe("done");
    expect((await rt.store.getRun(hs[1]!.runId))!.status).toBe("queued");
    expect(await host.drain()).toMatchObject({ started: 1, remaining: 1, liveStarted: 1 });
    expect(await host.drain()).toMatchObject({ started: 1, remaining: 0, liveStarted: 1 });
    expect(arms).toBe(3);
    for (const h of hs) expect((await rt.store.getRun(h.runId))!.status).toBe("done");
    expect(live.s).toMatchObject({ calls: 3, maxInFlight: 1 });
    // Live runs were reserved and settled through the world's ledger.
    expect((await rt.store.getRun(hs[0]!.runId))!.costUsdMicros).toBeGreaterThan(0);
  });

  it("starts every job ahead of the first live job it cannot start (FIFO), and jobs submitted while draining when nothing blocks them", async () => {
    const order: string[] = [];
    const host = alarmRunHost();
    const job = (runId: string, live: boolean, then?: () => void): RunHostJob => ({ runId, live, start: async () => { order.push(runId); then?.(); } });
    host.submit(job("a", false, () => host.submit(job("e", false))));
    host.submit(job("b", true));
    host.submit(job("c", false));
    host.submit(job("d", true));
    expect(await host.drain()).toMatchObject({ started: 3, remaining: 2, liveStarted: 1 });
    expect(order).toEqual(["a", "b", "c"]);
    // e was submitted while draining, so it is behind d: strict FIFO.
    expect(host.pending()).toEqual(["d", "e"]);
    expect(await host.drain()).toMatchObject({ started: 2, remaining: 0, liveStarted: 1 });
    expect(order).toEqual(["a", "b", "c", "d", "e"]);
    // With nothing blocking it, a job submitted while draining (a template fallback) starts in the same invocation.
    const again = alarmRunHost();
    const seen: string[] = [];
    again.submit({ runId: "x", live: true, start: async () => { seen.push("x"); again.submit({ runId: "y", live: false, start: async () => { seen.push("y"); } }); } });
    expect(await again.drain()).toMatchObject({ started: 2, remaining: 0, liveStarted: 1 });
    expect(seen).toEqual(["x", "y"]);
  });

  it("a drain while draining starts nothing, and a failed job never stops the others", async () => {
    const host = alarmRunHost();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    host.submit({ runId: "slow", live: false, start: () => gate });
    host.submit({ runId: "bad", live: false, start: async () => { throw new Error("boom"); } });
    const first = host.drain();
    expect(host.draining).toBe(true);
    expect(await host.drain()).toMatchObject({ started: 0 });
    release();
    expect(await first).toMatchObject({ started: 2, remaining: 0 });
  });

  it("resets the invocation's fetch counter at the start of every drain", async () => {
    const counter = createFetchCounter();
    const f = counter.wrap(async () => new Response("ok"));
    await f("https://example.test/");
    expect(counter.count).toBe(1);
    const host = alarmRunHost({ counter });
    host.submit({ runId: "x", live: true, start: async () => { await f("https://example.test/a"); await f("https://example.test/b"); } });
    expect(await host.drain()).toMatchObject({ fetches: 2 });
    expect(host.last).toMatchObject({ started: 1, fetches: 2 });
  });

  it("cancelling a run the host has not started ends it at once; its later drain runs no model step", async () => {
    const host = alarmRunHost();
    const live = fakeLive();
    const rt = runtime(live.provider, host);
    const h = handle();
    await rt.startChat(h, { text: "hello", recipe: "chat", pageContext: null });
    await rt.cancel(h.runId);
    expect(await rt.settled(h.runId)).toMatchObject({ status: "cancelled", terminalReason: "CANCELLED" });
    await host.drain();
    expect(live.s.calls).toBe(0);
    expect((await rt.store.getRun(h.runId))!.status).toBe("cancelled");
  });

  it("the boot rule is unchanged: a run the host never started is lost with the isolate and fails PROCESS_RESTART", async () => {
    const rt = runtime(fakeLive().provider, alarmRunHost());
    const h = handle();
    await rt.startChat(h, { text: "hello", recipe: "chat", pageContext: null });
    // The isolate is gone (a deploy, an eviction): a new runtime on the same database boots.
    const next = runtime(fakeLive().provider, alarmRunHost());
    await next.boot();
    expect(await next.store.getRun(h.runId)).toMatchObject({ status: "failed", terminalReason: "PROCESS_RESTART" });
  });
});

describe("the immediate host (Node)", () => {
  it("starts a run at once, inside the queue's concurrency, as before", async () => {
    const host = immediateRunHost();
    expect(host.kind).toBe("immediate");
    const rt = runtime(scriptedProvider({ source: scripts }));
    const h = handle();
    await rt.startChat(h, { text: "hello", recipe: "chat", pageContext: null });
    expect((await rt.settled(h.runId)).status).toBe("done");
    expect(host.pending()).toEqual([]);
    expect(await host.drain()).toEqual({ started: 0, remaining: 0 });
    let started = false;
    host.submit({ runId: "now", live: true, start: async () => { started = true; } });
    expect(started).toBe(true);
  });
});

describe("the per-invocation fetch counter and the IO_IN_TX guard", () => {
  it("counts fetches, refuses past its max before sending, and resets", async () => {
    const sent: string[] = [];
    const counter = createFetchCounter({ max: 2 });
    const f = counter.wrap(async (input) => { sent.push(String(input)); return new Response("ok"); });
    await f("https://a.test/1");
    await f("https://a.test/2");
    await expect(f("https://a.test/3")).rejects.toBeInstanceOf(FetchBudgetExceeded);
    expect(sent).toEqual(["https://a.test/1", "https://a.test/2"]);
    expect(counter.count).toBe(2);
    counter.reset();
    await f("https://a.test/4");
    expect(counter.count).toBe(1);
    expect(createFetchCounter().max).toBe(40);
  });

  it("a guarded fetch inside a transaction throws IO_IN_TX, sends nothing and counts nothing", async () => {
    let inTx = true;
    const guard = { assertNotInTx: (what: string) => { if (inTx) throw Object.assign(new Error(`IO_IN_TX: ${what} inside a transaction`), { code: "IO_IN_TX" }); } };
    const counter = createFetchCounter();
    const sent: string[] = [];
    const f = guardedFetch(async (input) => { sent.push(String(input)); return new Response("ok"); }, { what: "model call", guard, counter });
    await expect(f("https://a.test/")).rejects.toMatchObject({ code: "IO_IN_TX" });
    expect(sent).toEqual([]);
    expect(counter.count).toBe(0);
    inTx = false;
    await f("https://a.test/");
    expect(sent).toHaveLength(1);
    expect(counter.count).toBe(1);
  });
});
