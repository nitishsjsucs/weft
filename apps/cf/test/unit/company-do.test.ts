// CompanyDO's own plumbing on Node over a fake ctx and env, with a small fake engine behind the EngineModule seam
// (design 3.3, 4.6, 6.3): the MCP key's lease check, the minted key's expiry, the alarm's retry, the boot that two
// callers share, the outbox flush under the world's write lock, and the I/O guards. The clock here is Date only (fake
// timers for Date), so a lease's 30 days pass at once. The Miniflare suite runs the same class in workerd.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOSTED_SETTINGS, type HostedJob, type TxGuard } from "../../src/shared/contracts";
import { setEngineLoader, type EngineModule, type WorldBootInput, type WorldEngine } from "../../src/core/company/engine";
import type { WorldStamp } from "../../src/core/company/rpc";
import { addLeaseKey, readStamp, writeStamp } from "../../src/core/company/world-state";
import { WORLD_BUDGET } from "../../src/core/company/budget";
import { signCtx } from "../../src/shared/tokens";
import { memorySql } from "./sqlite";

(globalThis as { WebSocketRequestResponsePair?: unknown }).WebSocketRequestResponsePair ??= class { constructor(readonly request: string, readonly response: string) {} };
const { CompanyDO, OUTBOX_DEAD_AFTER, OUTBOX_DEAD_AFTER_MS } = await import("../../src/core/company/company-do");

const CTX = "c".repeat(64);
const VISITOR = "vis_" + "a".repeat(32);
const T0 = Date.parse("2026-10-26T15:00:00.000Z");
const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the fake engine does; each case sets what it needs. */
interface FakeWorld {
  boots: number;
  bootDelayMs: number;
  failBoots: number;
  inTx: boolean;
  /** Runs inside engine.inScope (an alarm's work); throws to fail the alarm. */
  scoped: (() => Promise<void>) | null;
  /** The world's write lock: writeLocked runs behind it. */
  lockTail: Promise<unknown>;
  input: WorldBootInput | null;
  engine: WorldEngine | null;
  /** How long engine.close() takes (a real close drains runs, up to 5 s each). */
  closeDelayMs: number;
  /** The generation each boot was asked for, in order, and each engine closed. */
  bootGens: number[];
  closedGens: number[];
  /** Hidden write-backs that reached a world's extras port, with the generation of the engine that ran them. */
  writeBacks: { gen: number; jobId: unknown }[];
  /** The generation of the engine each alarm's work (engine.inScope) ran on. */
  scopedGens: number[];
  /** How long each KV config read takes (envConfig, which the alarm and the boot await). */
  configDelayMs: number;
  /** Boots whose engine fails right after CompanyDO installs it (its change-feed subscription throws). */
  failAfterInstall: number;
  /** What each metered call (a request, an alarm's work) reads and writes, by method. */
  rows: (method: string) => { rowsRead: number; rowsWritten: number };
}
let world: FakeWorld;
const fresh = (): FakeWorld => ({ boots: 0, bootDelayMs: 0, failBoots: 0, inTx: false, scoped: null, lockTail: Promise.resolve(), input: null, engine: null, closeDelayMs: 0, bootGens: [], closedGens: [], writeBacks: [], scopedGens: [], configDelayMs: 0, failAfterInstall: 0, rows: () => ({ rowsRead: 0, rowsWritten: 0 }) });
/** The method of the request a fake engine call is serving (set by its fetch), for world.rows. */
let servingMethod = "GET";

function engineFor(input: WorldBootInput, sql: { exec(q: string, ...b: unknown[]): { toArray(): Record<string, unknown>[] } }): WorldEngine {
  const guard: TxGuard = {
    inTx: () => world.inTx,
    assertNotInTx(what) { if (world.inTx) throw Object.assign(new Error(`IO_IN_TX: ${what}`), { code: "IO_IN_TX" }); },
  };
  const writeLocked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = world.lockTail.then(fn, fn);
    world.lockTail = run.catch(() => undefined);
    return run;
  };
  return {
    meter: {
      measure: async (fn) => { servingMethod = "ALARM"; const value = await fn(); return { value, usage: { statements: 0, ...world.rows(servingMethod), tablesRead: [], tablesWritten: [] } }; },
      totals: () => ({ statements: 0, rowsRead: 0, rowsWritten: 0, tablesRead: [], tablesWritten: [] }),
      reset() {}, version: () => 0, versions: () => ({}),
      onCommit: () => { if (world.failAfterInstall > 0) { world.failAfterInstall -= 1; throw new Error("fake subscription failure"); } return () => undefined; },
    },
    guard,
    fetch: async (req) => { servingMethod = req.method; return new Response(JSON.stringify({ path: new URL(req.url).pathname }), { headers: { "content-type": "application/json" } }); },
    mcp: async () => new Response(JSON.stringify({ mcp: true }), { headers: { "content-type": "application/json" } }),
    inScope: async (fn) => { world.scopedGens.push(input.world.gen); if (world.scoped) await world.scoped(); return fn(); },
    clockRate: () => 0,
    mintMcpKey: async (m) => ({ key: `wk_mcp_${m.slot}_${m.gen}_${"k".repeat(24)}`, url: m.publicUrl, expiresAt: m.expiresAt }),
    setWorldProvider: async () => undefined,
    addSecret: () => undefined,
    writeLocked,
    outboxPending: () => writeLocked(async () => sql.exec(`SELECT id, kind, body FROM outbox ORDER BY created_at, id`).toArray()
      .map((r) => { try { return { id: String(r.id), kind: String(r.kind), job: JSON.parse(String(r.body)) as HostedJob }; } catch { return { id: String(r.id), kind: String(r.kind), job: null }; } })),
    outboxAck: (id: string) => writeLocked(async () => { sql.exec(`DELETE FROM outbox WHERE id = ?`, id); }),
    catalogRow: async (runId: string) => (runId === "run_0002" ? null : { runId, slot: input.world.slot, gen: input.world.gen, provider: "scripted", model: "fake", trigger: "chat", steps: 1, grounded: null, costUsdMicros: 0, neurons: 0, latencyMs: 0, status: "cancelled", terminalReason: "CANCELLED", endedAt: new Date().toISOString() }),
    pdf: async (_req: Request, p: { browserMsUsed: () => Promise<number> }) => new Response(String(await p.browserMsUsed())),
    extras: ({
      extrasWorld: async () => ({ slot: input.world.slot, gen: input.world.gen, mode: input.world.mode, snapshot: "fake", lease: null }),
      extrasBlob: async () => null,
      extrasWriteBack: async (w: { args: { job_id?: unknown } }) => { world.writeBacks.push({ gen: input.world.gen, jobId: w.args.job_id }); return { ok: true, status: "attached", reason: null }; },
      extrasMemoryText: async () => null,
      extrasExport: async () => ({ bytes: new TextEncoder().encode(`world gen ${input.world.gen}`), contentType: "application/json" }),
    }) as unknown as WorldEngine["extras"],
    close: async () => { if (world.closeDelayMs) await sleep(world.closeDelayMs); world.closedGens.push(input.world.gen); },
  } as WorldEngine;
}

let currentSql: ReturnType<typeof memorySql> | null = null;
const fakeModule: EngineModule = {
  async boot(input) {
    world.boots += 1;
    world.bootGens.push(input.world.gen);
    if (world.bootDelayMs) await sleep(world.bootDelayMs);
    if (world.failBoots > 0) { world.failBoots -= 1; throw new Error("fake boot failure"); }
    world.input = input;
    world.engine = engineFor(input, currentSql!.sql);
    return world.engine;
  },
  store: { isClean: () => true, deltaReset: () => ({ ok: true, rowsWritten: 0, mismatches: [] }) } as unknown as EngineModule["store"],
  artifacts: async () => ({ version: "fake", manifest: { journalHash: "x", digest: "x", chunks: 0, rows: 0 }, snapshot: {} }),
};
setEngineLoader(async () => fakeModule);

type LobbyStatusFn = (input: { visitor: string | null; slot?: string | null; gen?: number | null }) => unknown;

/** The MCP key the lease minted (the fake engine's mintMcpKey makes the same one); company() stores it unless told not to. */
const MINTED_KEY = `wk_mcp_slot-1_3_${"k".repeat(24)}`;

function company(o: { stamp?: Partial<WorldStamp> | null; lobbyStatus?: LobbyStatusFn; failSetAlarms?: number; failSend?: (body: unknown) => boolean; mintedKeys?: string[] } = {}) {
  const m = memorySql();
  currentSql = m;
  m.sql.exec(`CREATE TABLE kv_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  m.sql.exec(`CREATE TABLE outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`);
  const stamp: WorldStamp | null = o.stamp === null ? null : { slot: "slot-1", gen: 3, mode: "slot", visitor: VISITOR, ipHash: "i".repeat(32), leaseStartedAt: T0, ...o.stamp };
  if (stamp) m.transactionSync(() => { writeStamp(m.sql, stamp); for (const k of o.mintedKeys ?? [MINTED_KEY]) addLeaseKey(m.sql, k); });
  const kv = new Map<string, unknown>();
  const kvPuts: string[] = [];
  const failing = { n: o.failSetAlarms ?? 0 };
  const waits: Promise<unknown>[] = [];
  const recorded: unknown[][] = [];
  /** Every D1 statement run, with its bindings. */
  const ops: { sql: string; binds: unknown[] }[] = [];
  const alarms: number[] = [];
  let alarm: number | null = null;
  let ready: Promise<unknown> = Promise.resolve();
  const lobbyCalls: { method: string; input: unknown }[] = [];
  const sent: { queue: string; body: unknown }[] = [];
  const ctx = {
    id: { name: stamp?.slot ?? "slot-1" },
    storage: {
      sql: m.sql, transactionSync: <T>(fn: () => T) => m.transactionSync(fn),
      kv: { get: (k: string) => kv.get(k), put: (k: string, v: unknown) => { kvPuts.push(k); kv.set(k, structuredClone(v)); }, delete: (k: string) => kv.delete(k) },
      setAlarm: (t: number) => {
        if (failing.n > 0) { failing.n -= 1; throw new Error("storage busy"); }
        alarms.push(t); alarm = t;
      },
      getAlarm: () => alarm, deleteAll: async () => undefined,
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => (ready = fn()),
    setWebSocketAutoResponse: () => undefined, acceptWebSocket: () => undefined, getWebSockets: () => [], getTags: () => [],
    waitUntil: (p: Promise<unknown>) => { waits.push(p); }, abort: () => undefined,
  };
  const noLease = { level: 0, pool: { size: 2, free: 1, waitlist: 0 }, lease: null, waitlistPosition: null, worldProvider: null };
  const lobbyStub = {
    status: async (input: unknown) => { lobbyCalls.push({ method: "status", input }); return o.lobbyStatus?.(input as never) ?? noLease; },
    take: async (input: unknown) => { lobbyCalls.push({ method: "take", input }); return { ok: true, used: 1, left: 4 }; },
    reportUsage: async (input: unknown) => { lobbyCalls.push({ method: "reportUsage", input }); },
    extrasCounterPeek: async (name: string) => { lobbyCalls.push({ method: "extrasCounterPeek", input: name }); return 0; },
  };
  const env = {
    WEFT_CTX_SECRET: CTX, WEFT_PUBLIC_ORIGIN: "https://weft.test", WEFT_CONFIG_MEMO_MS: "0",
    CONFIG: { get: async (keys: string[] | string) => { if (world.configDelayMs) await sleep(world.configDelayMs); return Array.isArray(keys) ? new Map(keys.map((k) => [k, null])) : null; } },
    LOBBY: { idFromName: (n: string) => n, get: () => lobbyStub },
    SPEND: { idFromName: (n: string) => n, get: () => ({}) },
    COMPANY: { idFromName: (n: string) => n, get: () => ({}) },
    JOBS: { send: async (body: unknown) => { if (o.failSend?.(body)) throw new Error("Queue.send refused the message"); sent.push({ queue: "jobs", body }); } },
    RENDER: { send: async (body: unknown) => { sent.push({ queue: "render", body }); } },
    RL_RUN: { limit: async () => ({ success: true }) },
    OPS: { prepare: (q: string) => ({ bind: (...b: unknown[]) => ({ run: async () => { recorded.push(b); ops.push({ sql: q, binds: b }); return {}; } }) }) },
  };
  const co = new CompanyDO(ctx as never, env as never);
  /** The same object started again (an eviction or a deploy): a new instance over the same storage. */
  const restart = () => { const again = new CompanyDO(ctx as never, env as never); return { co: again, ready: () => ready }; };
  return { co, ready: () => ready, m, alarms, failing, lobbyCalls, sent, stamp, waits, recorded, ops, kv, kvPuts, restart };
}

async function req(path: string, o: { method?: string; visitor?: string | null; slot?: string; gen?: number; body?: string; headers?: Record<string, string> } = {}): Promise<Request> {
  const ctx = await signCtx(CTX, { slot: o.slot ?? "slot-1", gen: o.gen ?? 3, visitor: o.visitor === undefined ? VISITOR : o.visitor, ipHash: "i".repeat(32), human: true, smoke: false, iat: Math.floor(Date.now() / 1000) });
  return new Request(`https://weft.test${path}`, { method: o.method ?? "GET", headers: { "x-weft-ctx": ctx, ...o.headers }, ...(o.body !== undefined ? { body: o.body } : {}) });
}
const mcp = (o: { gen?: number; key?: string } = {}) => req("/mcp", { method: "POST", visitor: null, gen: o.gen, body: "{}", headers: { authorization: `Bearer ${o.key ?? MINTED_KEY}` } });
const at = (ms: number) => vi.setSystemTime(ms);

beforeEach(() => {
  world = fresh();
  vi.useFakeTimers({ toFake: ["Date"] });
  at(T0);
});
afterEach(() => { vi.useRealTimers(); });

describe("the MCP key's lease", () => {
  it("stops at the lease's total time, though the stamp still names the visitor (the Lobby has not swept yet)", async () => {
    const c = company();
    await c.ready();
    at(T0 + 2 * MIN);
    expect((await c.co.fetch(await req("/v1/workers"))).status).toBe(200);
    expect((await c.co.fetch(await mcp())).status).toBe(200);
    // Busy all along (a request just inside each idle time), so never idle; the total time still ends it.
    const idle = HOSTED_SETTINGS.leaseIdleMinutes, total = HOSTED_SETTINGS.leaseTotalMinutes;
    for (let t = idle - 1; t < total; t += idle - 1) { at(T0 + t * MIN); await c.co.fetch(await req("/v1/workers")); }
    at(T0 + (total - 1) * MIN);
    expect((await c.co.fetch(await mcp())).status).toBe(200);
    at(T0 + HOSTED_SETTINGS.leaseTotalMinutes * MIN + 1);
    const r = await c.co.fetch(await mcp());
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: "LEASE_ENDED" });
    expect(c.lobbyCalls.filter((x) => x.method === "status")).toEqual([]);
  });

  it("stops once the lease's visitor has been idle for the idle time, by this object's own last activity", async () => {
    const c = company();
    await c.ready();
    at(T0 + MIN);
    await c.co.fetch(await req("/v1/workers"));
    at(T0 + 20 * MIN);
    expect((await c.co.fetch(await mcp())).status).toBe(200);
    at(T0 + MIN + HOSTED_SETTINGS.leaseIdleMinutes * MIN);
    expect((await c.co.fetch(await mcp())).status).toBe(409);
    expect(c.lobbyCalls.filter((x) => x.method === "status")).toEqual([]);
  });

  it("asks the Lobby once when this instance has seen no activity (a restart), and fails closed on no lease", async () => {
    const lease = () => ({ slot: "slot-1", gen: 3, expiresAt: new Date(T0 + HOSTED_SETTINGS.leaseTotalMinutes * MIN).toISOString(), idleExpiresAt: new Date(T0 + (10 + HOSTED_SETTINGS.leaseIdleMinutes) * MIN).toISOString(), resetsLeft: HOSTED_SETTINGS.resetsPerLease });
    const c = company({ lobbyStatus: () => ({ level: 0, pool: { size: 2, free: 0, waitlist: 0 }, lease: lease(), waitlistPosition: null, worldProvider: null }) });
    await c.ready();
    at(T0 + 15 * MIN);
    expect((await c.co.fetch(await mcp())).status).toBe(200);
    expect((await c.co.fetch(await mcp())).status).toBe(200);
    expect(c.lobbyCalls.filter((x) => x.method === "status")).toEqual([{ method: "status", input: { visitor: VISITOR, slot: "slot-1", gen: 3, now: T0 + 15 * MIN } }]);
    // The Lobby's last-seen time (10 minutes in) is now this instance's: idle the idle time after it.
    at(T0 + (11 + HOSTED_SETTINGS.leaseIdleMinutes) * MIN);
    expect((await c.co.fetch(await mcp())).status).toBe(409);

    const gone = company();
    await gone.ready();
    at(T0 + 5 * MIN);
    expect((await gone.co.fetch(await mcp())).status).toBe(409);
  });

  it("refuses a key this generation never minted from the slot's stored keys, without asking the Lobby, even on an instance that has seen no activity", async () => {
    const lease = () => ({ slot: "slot-1", gen: 3, expiresAt: new Date(T0 + HOSTED_SETTINGS.leaseTotalMinutes * MIN).toISOString(), idleExpiresAt: new Date(T0 + (10 + HOSTED_SETTINGS.leaseIdleMinutes) * MIN).toISOString(), resetsLeft: HOSTED_SETTINGS.resetsPerLease });
    const c = company({ lobbyStatus: () => ({ level: 0, pool: { size: 2, free: 0, waitlist: 0 }, lease: lease(), waitlistPosition: null, worldProvider: null }) });
    await c.ready();
    at(T0 + 15 * MIN);
    // Well-formed keys for this slot and generation, as anyone can write them (the front routes by the prefix only).
    for (let i = 0; i < 20; i++) {
      const forged = `wk_mcp_slot-1_3_${String(i).padStart(24, "f")}`;
      const r = await c.co.fetch(await mcp({ key: forged }));
      expect(r.status).toBe(401);
      expect(await r.json()).toMatchObject({ code: "MCP_KEY_INVALID" });
    }
    const viaApiKey = await c.co.fetch(await req("/mcp", { method: "POST", visitor: null, body: "{}", headers: { "x-api-key": `wk_mcp_slot-1_3_${"x".repeat(24)}` } }));
    expect(viaApiKey.status).toBe(401);
    expect(c.lobbyCalls).toEqual([]);
    // The minted key still asks the Lobby once, as before.
    expect((await c.co.fetch(await mcp())).status).toBe(200);
    expect(c.lobbyCalls.map((x) => x.method)).toEqual(["status"]);
    // A world with no minted key refuses every key.
    const none = company({ mintedKeys: [] });
    await none.ready();
    expect((await none.co.fetch(await mcp())).status).toBe(401);
    expect(none.lobbyCalls).toEqual([]);
  });

  it("keeps the lease's start with the stamp, and drops it when the lease ends", async () => {
    const c = company();
    await c.ready();
    expect(readStamp(c.m.sql)).toMatchObject({ visitor: VISITOR, leaseStartedAt: T0 });
    await c.co.endLease({ gen: 3, reason: "test" });
    expect(readStamp(c.m.sql)).toMatchObject({ visitor: null, leaseStartedAt: null });
    expect((await c.co.fetch(await mcp())).status).toBe(409);
  });

  it("mints the lease's key with the lease's own expiry, not the minute it was minted plus a lease", async () => {
    const c = company();
    await c.ready();
    at(T0 + 47 * MIN);
    const r = await c.co.fetch(await req("/_hosted/mcp-key", { method: "POST", body: "{}" }));
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ expiresAt: new Date(T0 + HOSTED_SETTINGS.leaseTotalMinutes * MIN).toISOString() });
  });
});

describe("the alarm", () => {
  it("backs off when its work keeps throwing (2 s, 4 s, 8 s ... at most 5 minutes), and starts again at 2 s after a success", async () => {
    const c = company();
    await c.ready();
    world.scoped = async () => { throw new Error("the world is broken"); };
    let now = T0 + MIN;
    at(now);
    await c.co.runAlarmNow();
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      delays.push(c.alarms.at(-1)! - now);
      now = c.alarms.at(-1)!;
      at(now);
      await c.co.alarm();
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000]);
    world.scoped = null;
    now = c.alarms.at(-1)!;
    at(now);
    await c.co.alarm();
    world.scoped = async () => { throw new Error("broken again"); };
    await c.co.runAlarmNow();
    expect(c.alarms.at(-1)! - now).toBe(2_000);
  });

  it("is asked for again from the Lobby's heartbeat when the last ask failed and jobs wait, with no request coming", async () => {
    const c = company();
    await c.ready();
    c.failing.n = 1;
    let started = 0;
    world.input!.runHost.submit({ runId: "run_0001", live: false, start: async () => { started += 1; } });
    await sleep(5);
    expect(c.alarms).toEqual([]);
    await c.co.heartbeat();
    await sleep(5);
    expect(c.alarms).toHaveLength(1);
    await c.co.alarm();
    expect(started).toBe(1);
  });
});

describe("the Lobby's heartbeat", () => {
  it("asks whether the world is clean only when the reset path asks, never on a lease holder's session read or the sweep", async () => {
    const c = company();
    await c.ready();
    const store = fakeModule.store as unknown as { isClean: () => boolean };
    const was = store.isClean;
    let checks = 0;
    store.isClean = () => { checks += 1; return false; };
    try {
      // GET /api/_session from the lease holder (the provider too) and the sweep's reclaim.
      expect((await c.co.heartbeat({ provider: true })).clean).toBeNull();
      expect((await c.co.heartbeat()).clean).toBeNull();
      expect(checks).toBe(0);
      // The reset's own heartbeat.
      expect((await c.co.heartbeat({ clean: true })).clean).toBe(false);
      expect(checks).toBe(1);
    } finally {
      store.isClean = was;
    }
  });

  it("leaves the usage in the slot for a lease holder's session read (keepUsage), and hands it over to the sweep's", async () => {
    const c = company();
    await c.ready();
    for (let i = 0; i < 3; i++) await c.co.fetch(await req("/v1/workers"));
    for (let i = 0; i < 5; i++) expect((await c.co.heartbeat({ provider: true, keepUsage: true })).usage).toEqual({ rowsRead: 0, rowsWritten: 0, requests: 0 });
    expect((await c.co.heartbeat()).usage).toMatchObject({ requests: 3 });
    expect((await c.co.heartbeat()).usage).toEqual({ rowsRead: 0, rowsWritten: 0, requests: 0 });
  });
});

describe("the world's boot", () => {
  it("closes the engine it brought up when it fails after installing it (fence shut, scheduler stopped), and the next boot starts clean", async () => {
    world.failAfterInstall = 1;
    const c = company();
    await c.ready();
    expect(world.boots).toBe(1);
    // The engine was installed, then the boot failed: it is closed, and the object serves nothing from it.
    expect(world.closedGens).toEqual([3]);
    expect((await c.co.fetch(await req("/v1/workers"))).status).toBe(503);
    // The next alarm boots the world again, and that engine is kept.
    await c.co.alarm();
    expect(world.boots).toBe(2);
    expect((await c.co.fetch(await req("/v1/workers"))).status).toBe(200);
    expect(world.closedGens).toEqual([3]);
  });

  it("is shared by concurrent callers: alarms and an RPC on a world whose cold boot failed boot it once", async () => {
    world.failBoots = 1;
    const c = company();
    await c.ready();
    expect(world.boots).toBe(1);
    world.bootDelayMs = 20;
    // The alarm, a retried alarm and a queue consumer's RPC (the fake world has no extras port, so it is refused after
    // the boot) all find no engine at once.
    await Promise.allSettled([c.co.alarm(), c.co.runAlarmNow(), c.co.extrasWorld()]);
    expect(world.boots).toBe(2);
    expect((await c.co.fetch(await req("/v1/workers"))).status).toBe(200);
  });

  it("tries again after a boot that failed, and boots again after the world was stopped (a reset)", async () => {
    world.failBoots = 2;
    const c = company();
    await c.ready();
    await c.co.alarm();
    expect(world.boots).toBe(2);
    expect((await c.co.fetch(await req("/v1/workers"))).status).toBe(503);
    await c.co.alarm();
    expect(world.boots).toBe(3);
    expect((await c.co.fetch(await req("/v1/workers"))).status).toBe(200);
    await c.co.applyStamp({ ...c.stamp!, gen: 4 });
    expect(world.boots).toBe(4);
    expect((await c.co.fetch(await req("/v1/workers", { gen: 4 }))).status).toBe(200);
  });
});

describe("a reset while the old world closes", () => {
  const NEXT = "vis_" + "b".repeat(32);
  const next = (c: ReturnType<typeof company>): WorldStamp => ({ ...c.stamp!, gen: 4, visitor: NEXT, leaseStartedAt: T0 + 5 * MIN });
  /** The engine serving the world now, by the generation it booted for. */
  const servingGen = async (c: ReturnType<typeof company>) => (await c.co.extrasWorld()).gen;

  it("boots nothing from an alarm that fires during the close; the alarm asks again and the reset boots the next generation", async () => {
    const c = company();
    await c.ready();
    world.closeDelayMs = 40;
    world.bootDelayMs = 60;
    const reset = c.co.deltaReset(next(c));
    await sleep(10);
    // The previous visitor's world is closing (engine is gone, draining runs): an alarm fires.
    const asked = c.alarms.length;
    await c.co.runAlarmNow();
    expect(world.bootGens).toEqual([3]);
    // The alarm's purposes are asked for again later, not dropped.
    expect(c.alarms.length).toBeGreaterThan(asked);
    expect(c.alarms.at(-1)!).toBeGreaterThan(Date.now());
    expect(await reset).toMatchObject({ ok: true, gen: 4 });
    expect(world.bootGens).toEqual([3, 4]);
    expect(await servingGen(c)).toBe(4);
    // The next visitor is served by the new generation; the previous cookie generation is refused.
    expect((await c.co.fetch(await req("/v1/workers", { gen: 4, visitor: NEXT }))).status).toBe(200);
    expect((await c.co.fetch(await req("/v1/workers", { gen: 3 }))).status).toBe(409);
  });

  it("refuses an extras RPC that arrives during the close with WORLD_NOT_READY (the queue retries), booting nothing", async () => {
    const c = company();
    await c.ready();
    world.closeDelayMs = 40;
    const reset = c.co.deltaReset(next(c));
    await sleep(10);
    await expect(c.co.extrasWorld()).rejects.toThrow(/WORLD_NOT_READY/);
    await expect(c.co.extrasWriteBack({ command: "expenses.attach_receipt_extract", args: { job_id: "obx_late" } } as never, 3)).rejects.toThrow(/WORLD_NOT_READY/);
    expect(world.bootGens).toEqual([3]);
    await reset;
    expect(world.bootGens).toEqual([3, 4]);
    expect(await servingGen(c)).toBe(4);
    expect(world.writeBacks).toEqual([]);
  });

  it("never keeps a boot of the old generation that is still in flight when the reset stamps the next one", async () => {
    const c = company();
    await c.ready();
    world.closeDelayMs = 30;
    world.bootDelayMs = 80;
    const reset = c.co.deltaReset(next(c));
    await sleep(10);
    // A boot of the old stamp started during the close, as a caller past the reset's guard would start it.
    const stale = (c.co as unknown as { startEngine(): Promise<void> }).startEngine();
    expect(await reset).toMatchObject({ ok: true, gen: 4 });
    await stale;
    // The reset booted its own generation rather than sharing the old boot; the old one was closed, not kept.
    expect(world.bootGens).toEqual([3, 3, 4]);
    expect(world.closedGens).toEqual([3, 3]);
    expect(await servingGen(c)).toBe(4);
  });

  it("refuses a write-back or an export of a job from an older generation, whatever engine is up", async () => {
    const c = company();
    await c.ready();
    await c.co.deltaReset(next(c));
    expect(await servingGen(c)).toBe(4);
    // The previous visitor's OCR job (gen 3) finishes after the reset: nothing reaches the new visitor's world.
    expect(await c.co.extrasWriteBack({ command: "expenses.attach_receipt_extract", args: { job_id: "obx_old" } } as never, 3)).toMatchObject({ ok: false, code: "STALE_GENERATION", retryable: false });
    // The same outcome for an export: a value the queue finishes as stale, never an error it retries.
    expect(await c.co.extrasExport("world", 3)).toEqual({ ok: false, code: "STALE_GENERATION", message: expect.stringContaining("generation 3"), retryable: false });
    expect(world.writeBacks).toEqual([]);
    expect(await c.co.extrasWriteBack({ command: "expenses.attach_receipt_extract", args: { job_id: "obx_new" } } as never, 4)).toMatchObject({ ok: true });
    expect(world.writeBacks).toEqual([{ gen: 4, jobId: "obx_new" }]);
    expect(new TextDecoder().decode(((await c.co.extrasExport("world", 4)) as { bytes: Uint8Array }).bytes)).toBe("world gen 4");
  });

  it("boots nothing from an alarm or an extras RPC during a restore's first step, and the restore's last step boots the restored world", async () => {
    const c = company();
    await c.ready();
    world.closeDelayMs = 40;
    const begin = c.co.restoreBegin({ slot: "slot-1", gen: 5, mode: "slot" } as never);
    await sleep(10);
    await c.co.runAlarmNow();
    await expect(c.co.extrasWorld()).rejects.toThrow(/WORLD_NOT_READY/);
    await begin;
    expect(world.bootGens).toEqual([3]);
    const fakeRestore = fakeModule.store as unknown as Record<string, unknown>;
    fakeRestore.beginRestore = () => ({ applied: 0, triggers: [] });
    fakeRestore.finishRestore = () => ({ ok: true, mismatches: [], rowsWritten: 0 });
    c.m.sql.exec(`CREATE TABLE IF NOT EXISTS kv_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    expect(await c.co.restoreFinish({ bookmark: null })).toMatchObject({ slot: "slot-1", gen: 5 });
    expect(world.bootGens).toEqual([3, 5]);
    expect(await servingGen(c)).toBe(5);
  });
});

describe("a world replaced while its own steps await", () => {
  it("runs no alarm work on an engine that a new generation's stamp replaced while the alarm read the config", async () => {
    const c = company();
    await c.ready();
    world.configDelayMs = 30;
    // The alarm takes the gen 3 engine, then waits on KV; meanwhile the Lobby stamps generation 4.
    const alarm = c.co.runAlarmNow();
    await sleep(5);
    const stamped = c.co.applyStamp({ ...c.stamp!, gen: 4, visitor: "vis_" + "b".repeat(32) });
    await alarm;
    expect(world.closedGens).toEqual([3]);
    expect(world.scopedGens).toEqual([]);
    // Its purposes are asked for again, after the backoff.
    expect(c.alarms.at(-1)!).toBeGreaterThan(Date.now());
    await stamped;
    world.configDelayMs = 0;
    at(c.alarms.at(-1)!);
    await c.co.alarm();
    expect(world.scopedGens).toEqual([4]);
  });

  it("keeps a newer boot that started while a stop waited for the previous one", async () => {
    const c = company();
    await c.ready();
    const co = c.co as unknown as { stamp: WorldStamp; startEngine(): Promise<void>; stopEngine(): Promise<void> };
    world.bootDelayMs = 40;
    // Generation 4's boot is in flight, and a stop waits for it.
    const stamped = c.co.applyStamp({ ...c.stamp!, gen: 4 });
    await sleep(10);
    const stop = co.stopEngine();
    await sleep(10);
    // Meanwhile the world moves to generation 5 and its boot starts (as restoreFinish starts one when no engine is up).
    co.stamp = { ...co.stamp, gen: 5 };
    const newer = co.startEngine();
    await stamped;
    await stop;
    // A caller that finds no engine yet shares the generation 5 boot instead of starting a second one.
    const served = c.co.extrasWorld().catch(() => null);
    await newer;
    await served;
    expect(world.bootGens).toEqual([3, 4, 5]);
    expect(world.closedGens).toEqual([3, 4]);
  });
});

describe("the outbox flush", () => {
  const job = (n: number) => JSON.stringify({ v: 1, kind: "ocr.receipt", jobId: `obx_${String(n).padStart(16, "0")}`, slot: "slot-1", gen: 3, uploadId: "upl_1", expenseId: "exp_1", sha256: "0".repeat(64), storagePath: "blob:x", contentType: "image/png" });
  const append = (c: ReturnType<typeof company>, id: string, body: string) => c.m.sql.exec(`INSERT INTO outbox (id, kind, body, created_at) VALUES (?, 'ocr.receipt', ?, ?)`, id, body, new Date().toISOString());

  it("never sends a row of a transaction still open in another request, so one that rolls back is never sent", async () => {
    const c = company();
    await c.ready();
    // Another request's executor transaction: it holds the world's write lock, appends its row, and then rolls back.
    // The guard this flush sees cannot tell (inTx is per async context), the lock can.
    let rollBack!: () => void;
    const open = world.engine!.writeLocked(async () => {
      append(c, "obx_open", job(1));
      await new Promise<void>((r) => { rollBack = r; });
      c.m.sql.exec(`DELETE FROM outbox WHERE id = 'obx_open'`);
    });
    await sleep(1);
    const flush = c.co.flushOutbox();
    await sleep(10);
    expect(c.sent).toEqual([]);
    rollBack();
    await open;
    expect(await flush).toBe(0);
    expect(c.sent).toEqual([]);
  });

  it("sends each committed row once and deletes it, drops a row that is not a job, and reads again for rows committed meanwhile", async () => {
    const c = company();
    await c.ready();
    append(c, "obx_a", job(2));
    append(c, "obx_bad", "{not json");
    const flush = c.co.flushOutbox();
    // Committed while the first flush runs: its onOutbox finds a flush running, which reads again before it ends.
    append(c, "obx_b", job(3));
    expect(await c.co.flushOutbox()).toBe(0);
    expect(await flush).toBe(2);
    expect(c.sent.map((x) => (x.body as { jobId: string }).jobId)).toEqual([`obx_${"2".padStart(16, "0")}`, `obx_${"3".padStart(16, "0")}`]);
    expect(c.m.sql.exec(`SELECT COUNT(*) AS n FROM outbox`).toArray()[0]!.n).toBe(0);
  });
});

describe("the outbox retry", () => {
  const job = (n: number) => JSON.stringify({ v: 1, kind: "ocr.receipt", jobId: `obx_${String(n).padStart(16, "0")}`, slot: "slot-1", gen: 3, uploadId: "upl_1", expenseId: "exp_1", sha256: "0".repeat(64), storagePath: "blob:x", contentType: "image/png" });
  const append = (c: ReturnType<typeof company>, id: string, body: string, at: string) => c.m.sql.exec(`INSERT INTO outbox (id, kind, body, created_at) VALUES (?, 'ocr.receipt', ?, ?)`, id, body, at);
  const poison = `obx_${"1".padStart(16, "0")}`;

  it("sends the rows behind one whose send keeps failing, and backs off exponentially (capped) instead of every 30 s", async () => {
    let failing = true;
    const c = company({ failSend: (b) => failing && (b as { jobId: string }).jobId === poison });
    await c.ready();
    // The row that cannot be sent is the oldest: the rows behind it go anyway.
    append(c, "obx_a", job(1), "2026-10-26T15:00:00.000Z");
    append(c, "obx_b", job(2), "2026-10-26T15:00:01.000Z");
    append(c, "obx_c", job(3), "2026-10-26T15:00:02.000Z");
    let now = T0 + MIN;
    at(now);
    expect(await c.co.flushOutbox()).toBe(2);
    expect(c.sent.map((x) => (x.body as { jobId: string }).jobId)).toEqual([job(2), job(3)].map((b) => (JSON.parse(b) as { jobId: string }).jobId));
    expect(c.m.sql.exec(`SELECT id FROM outbox`).toArray()).toEqual([{ id: "obx_a" }]);
    const delays: number[] = [c.alarms.at(-1)! - now];
    for (let i = 0; i < 9; i++) {
      now = c.alarms.at(-1)!;
      at(now);
      await c.co.alarm();
      delays.push(c.alarms.at(-1)! - now);
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000]);
    // Once it goes, the backoff starts again from the beginning.
    failing = false;
    now = c.alarms.at(-1)!;
    at(now);
    await c.co.alarm();
    expect(c.m.sql.exec(`SELECT id FROM outbox`).toArray()).toEqual([]);
    failing = true;
    append(c, "obx_d", job(1), "2026-10-26T16:00:00.000Z");
    expect(await c.co.flushOutbox()).toBe(0);
    expect(c.alarms.at(-1)! - now).toBe(2_000);
  });
});

describe("a row the outbox can never send", () => {
  const job = (n: number) => JSON.stringify({ v: 1, kind: "ocr.receipt", jobId: `obx_${String(n).padStart(16, "0")}`, slot: "slot-1", gen: 3, uploadId: "upl_1", expenseId: "exp_1", sha256: "0".repeat(64), storagePath: "blob:x", contentType: "image/png" });
  const poison = `obx_${"1".padStart(16, "0")}`;

  it(`is dead-lettered after ${OUTBOX_DEAD_AFTER} failed flushes over ${OUTBOX_DEAD_AFTER_MS / MIN} minutes, counted across a restart: recorded in failed_jobs, dropped, and no longer retried`, async () => {
    expect(OUTBOX_DEAD_AFTER).toBe(12);
    expect(OUTBOX_DEAD_AFTER_MS).toBe(20 * MIN);
    let tries = 0;
    const c = company({ failSend: (b) => (b as { jobId: string }).jobId === poison && ++tries > 0 });
    await c.ready();
    c.m.sql.exec(`INSERT INTO outbox (id, kind, body, created_at) VALUES ('obx_a', 'ocr.receipt', ?, '2026-10-26T15:00:00.000Z')`, job(1));
    const first = T0 + MIN;
    let now = first;
    at(now);
    let co = c.co;
    await co.flushOutbox();
    for (let i = 0; i < 5; i++) { now = c.alarms.at(-1)!; at(now); await co.alarm(); }
    expect(tries).toBe(6);
    // Evicted between two retries (the backoff reaches minutes): the next instance's boot flush is the 7th try, and
    // it keeps both the count and the time of the first failure.
    const again = c.restart();
    await again.ready();
    co = again.co;
    expect(tries).toBe(7);
    const outbox = () => c.m.sql.exec(`SELECT id FROM outbox WHERE id = 'obx_a'`).toArray();
    while (outbox().length && tries < 100) { now = c.alarms.at(-1)!; at(now); await co.alarm(); }
    expect(outbox()).toEqual([]);
    // The first failed flush that was both the 12th or later and 20 minutes or more after the first failure.
    expect(tries).toBeGreaterThanOrEqual(OUTBOX_DEAD_AFTER);
    expect(now - first).toBeGreaterThanOrEqual(OUTBOX_DEAD_AFTER_MS);
    const dead = c.ops.filter((o) => /INSERT[^]*failed_jobs/i.test(o.sql));
    expect(dead).toHaveLength(1);
    expect(dead[0]!.binds.slice(0, 7)).toEqual([poison, "ocr.receipt", "slot-1", 3, "weft-jobs", tries, "OUTBOX_UNSENT"]);
    expect(String(dead[0]!.binds[7])).toContain("Queue.send refused");
    // No more retries: the outbox purpose is not asked for again, and later flushes send nothing and arm nothing.
    const asked = c.alarms.length;
    const total = tries;
    expect(await co.flushOutbox()).toBe(0);
    expect(c.alarms.length).toBe(asked);
    expect(tries).toBe(total);
    expect([...c.kv.keys()].filter((k) => k.includes("outbox"))).toEqual([]);
  });

  it(`is not dead-lettered by ${OUTBOX_DEAD_AFTER} quick failed flushes (commits and boots during a short Queue outage) before ${OUTBOX_DEAD_AFTER_MS / MIN} minutes`, async () => {
    let failing = true;
    let tries = 0;
    const c = company({ failSend: (b) => failing && (b as { jobId: string }).jobId === poison && ++tries > 0 });
    await c.ready();
    c.m.sql.exec(`INSERT INTO outbox (id, kind, body, created_at) VALUES ('obx_a', 'ocr.receipt', ?, '2026-10-26T15:00:00.000Z')`, job(1));
    const first = T0 + MIN;
    // Three times the count within a minute: every commit with an outbox row and every boot flushes.
    for (let i = 0; i < 3 * OUTBOX_DEAD_AFTER; i++) { at(first + i * 1_000); await c.co.flushOutbox(); }
    const again = c.restart();
    await again.ready();
    expect(tries).toBe(3 * OUTBOX_DEAD_AFTER + 1);
    expect(c.ops.filter((o) => /failed_jobs/i.test(o.sql))).toEqual([]);
    expect(c.m.sql.exec(`SELECT id FROM outbox`).toArray()).toEqual([{ id: "obx_a" }]);
    // Still failing just short of 20 minutes after the first failure: kept.
    at(first + OUTBOX_DEAD_AFTER_MS - 1_000);
    await again.co.flushOutbox();
    expect(c.ops.filter((o) => /failed_jobs/i.test(o.sql))).toEqual([]);
    // The Queue is back: the row is sent, not dead-lettered, and forgotten.
    failing = false;
    at(first + OUTBOX_DEAD_AFTER_MS - 500);
    await again.co.flushOutbox();
    expect(c.sent.map((x) => (x.body as { jobId: string }).jobId)).toEqual([poison]);
    expect(c.ops.filter((o) => /failed_jobs/i.test(o.sql))).toEqual([]);
    expect([...c.kv.keys()].filter((k) => k.includes("outbox"))).toEqual([]);
  });

  it("reads a count an earlier build saved (a bare number) as failures whose time starts now", async () => {
    let tries = 0;
    const c = company({ failSend: (b) => (b as { jobId: string }).jobId === poison && ++tries > 0 });
    await c.ready();
    // What an earlier build left in storage, read by the next instance's boot flush (at T0).
    c.kv.set("weft.outbox_attempts", { obx_a: OUTBOX_DEAD_AFTER + 5 });
    c.m.sql.exec(`INSERT INTO outbox (id, kind, body, created_at) VALUES ('obx_a', 'ocr.receipt', ?, '2026-10-26T15:00:00.000Z')`, job(1));
    const restarted = c.restart();
    await restarted.ready();
    expect(tries).toBe(1);
    expect(c.kv.get("weft.outbox_attempts")).toEqual({ obx_a: { n: OUTBOX_DEAD_AFTER + 6, first: T0 } });
    at(T0 + 5 * MIN);
    await restarted.co.flushOutbox();
    expect(c.ops.filter((o) => /failed_jobs/i.test(o.sql))).toEqual([]);
    at(T0 + OUTBOX_DEAD_AFTER_MS + MIN);
    await restarted.co.flushOutbox();
    expect(c.ops.filter((o) => /INSERT[^]*failed_jobs/i.test(o.sql))).toHaveLength(1);
    expect(c.m.sql.exec(`SELECT id FROM outbox`).toArray()).toEqual([]);
  });

  it("counts only flushes that failed the row in a row, and forgets a row once it is sent", async () => {
    let failing = true;
    const c = company({ failSend: (b) => failing && (b as { jobId: string }).jobId === poison });
    await c.ready();
    c.m.sql.exec(`INSERT INTO outbox (id, kind, body, created_at) VALUES ('obx_a', 'ocr.receipt', ?, '2026-10-26T15:00:00.000Z')`, job(1));
    let now = T0 + MIN;
    at(now);
    await c.co.flushOutbox();
    for (let i = 0; i < OUTBOX_DEAD_AFTER - 2; i++) { now = c.alarms.at(-1)!; at(now); await c.co.alarm(); }
    failing = false;
    now = c.alarms.at(-1)!;
    at(now);
    await c.co.alarm();
    expect(c.sent.map((x) => (x.body as { jobId: string }).jobId)).toEqual([poison]);
    expect(c.ops.filter((o) => /failed_jobs/i.test(o.sql))).toEqual([]);
    expect([...c.kv.keys()].filter((k) => k.includes("outbox"))).toEqual([]);
  });
});

describe("cross-object calls", () => {
  it("assert they are not inside a transaction: the MCP ask limit, the PDF route's browser counter and the usage push", async () => {
    const c = company();
    await c.ready();
    world.inTx = true;
    await expect(world.input!.mcpAskAllowed(`wk_mcp_slot-1_3_${"k".repeat(24)}`)).rejects.toThrow(/IO_IN_TX: LobbyDO\.take/);
    await expect(c.co.fetch(await req("/_hosted/pdf/offer_letter/doc_0001"))).rejects.toThrow(/IO_IN_TX: LobbyDO\.extrasCounterPeek/);
    expect(c.lobbyCalls.filter((x) => x.method === "take" || x.method === "extrasCounterPeek")).toEqual([]);
    world.inTx = false;
    expect(await world.input!.mcpAskAllowed(`wk_mcp_slot-1_3_${"k".repeat(24)}`)).toBe(true);
    expect(await (await c.co.fetch(await req("/_hosted/pdf/offer_letter/doc_0001"))).text()).toBe("0");

    // The usage push goes after 500 requests; one that would go while a transaction is open waits for the next.
    world.inTx = true;
    for (let i = 0; i < 500; i++) await c.co.fetch(await req("/v1/workers"));
    expect(c.lobbyCalls.filter((x) => x.method === "reportUsage")).toEqual([]);
    world.inTx = false;
    await c.co.fetch(await req("/v1/workers"));
    expect(c.lobbyCalls.filter((x) => x.method === "reportUsage")).toHaveLength(1);
  });
});

describe("the run catalog", () => {
  it("records a run cancelled directly through the API, not only runs that end in an alarm drain", async () => {
    const c = company();
    await c.ready();
    expect((await c.co.fetch(await req("/v1/agent/runs/run_0001/cancel", { method: "POST", body: "{}" }))).status).toBe(200);
    // A run still running when the cancel answered has no terminal row yet: nothing is recorded for it here.
    await c.co.fetch(await req("/v1/agent/runs/run_0002/cancel", { method: "POST", body: "{}" }));
    await c.co.fetch(await req("/v1/agent/runs/run_0003", { method: "GET" }));
    await Promise.all(c.waits);
    expect(c.recorded).toHaveLength(1);
    expect(JSON.stringify(c.recorded[0])).toContain("run_0001");
  });
});

describe("the rows budget (defense in depth)", () => {
  const limits = { written: WORLD_BUDGET.leaseRowsWritten, read: WORLD_BUDGET.leaseRowsRead };
  const kvWrites = (c: ReturnType<typeof company>) => c.kvPuts.filter((k) => k === "weft.budget").length;

  it("answers a leased slot's mutations 429 DEMO_LIMIT past its rows written for the generation, and keeps serving its reads", async () => {
    const c = company();
    await c.ready();
    world.rows = (m) => (m === "POST" ? { rowsRead: 10, rowsWritten: 400 } : { rowsRead: 10, rowsWritten: 0 });
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) statuses.push((await c.co.fetch(await req("/v1/time-off/requests", { method: "POST", body: "{}" }))).status);
    // 13 mutations of 400 rows reach 5,200 >= 5,000: the 14th and later are refused.
    expect(statuses.filter((x) => x === 200)).toHaveLength(Math.ceil(limits.written / 400));
    const refused = await c.co.fetch(await req("/v1/time-off/requests", { method: "POST", body: "{}" }));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ code: "DEMO_LIMIT", message: expect.stringContaining("refills at 00:00 UTC") });
    expect((await c.co.fetch(await req("/v1/workers"))).status).toBe(200);
    // The health readout names the generation's rows and the limits.
    const h = await (await c.co.fetch(await req("/v1/health"))).json() as { budget: { rowsWritten: number; limits: { rowsWritten: number } } };
    expect(h.budget).toMatchObject({ rowsWritten: 13 * 400, limits: { rowsWritten: limits.written, rowsRead: limits.read } });
  });

  it("answers every request 429 past the generation's rows read, counting alarm drains, and a new generation starts again", async () => {
    const c = company();
    await c.ready();
    world.rows = (m) => (m === "ALARM" ? { rowsRead: limits.read / 2, rowsWritten: 0 } : { rowsRead: 1_000, rowsWritten: 0 });
    expect((await c.co.fetch(await req("/v1/workers"))).status).toBe(200);
    await c.co.runAlarmNow();
    await c.co.runAlarmNow();
    for (const method of ["GET", "POST"]) {
      const r = await c.co.fetch(await req("/v1/workers", { method, ...(method === "POST" ? { body: "{}" } : {}) }));
      expect(r.status, method).toBe(429);
      expect(await r.json()).toMatchObject({ code: "DEMO_LIMIT" });
    }
    // Refused requests move no row, so any number of them write the tally no more.
    const writes = kvWrites(c);
    for (let i = 0; i < 100; i++) expect((await c.co.fetch(await req("/v1/workers"))).status).toBe(429);
    expect(kvWrites(c)).toBe(writes);
    // A restart keeps the refusal (the tally was written when it crossed the limit).
    const again = c.restart();
    await again.ready();
    expect((await again.co.fetch(await req("/v1/workers"))).status).toBe(429);
    // The visitor's reset is the next generation: its tally starts at zero.
    await again.co.applyStamp({ ...c.stamp!, gen: 4 });
    expect((await again.co.fetch(await req("/v1/workers", { gen: 4 }))).status).toBe(200);
  });

  it("refills a leased slot's budget at 00:00 UTC on the same generation, so a 30-day lease never runs dry for good", async () => {
    const c = company();
    await c.ready();
    world.rows = (m) => (m === "POST" ? { rowsRead: 10, rowsWritten: 1_000 } : { rowsRead: 10, rowsWritten: 0 });
    for (let i = 0; i < 5; i++) expect((await c.co.fetch(await req("/v1/time-off/requests", { method: "POST", body: "{}" }))).status).toBe(200);
    expect((await c.co.fetch(await req("/v1/time-off/requests", { method: "POST", body: "{}" }))).status).toBe(429);
    // Same generation, next UTC day: the tally starts again and mutations are served.
    at(T0 + 24 * 60 * MIN);
    expect((await c.co.fetch(await req("/v1/time-off/requests", { method: "POST", body: "{}" }))).status).toBe(200);
  });

  it("writes its tally one row at a time, at most every 20 requests and at each step or limit, never per request", async () => {
    const c = company();
    await c.ready();
    world.rows = () => ({ rowsRead: 50, rowsWritten: 1 });
    for (let i = 0; i < 200; i++) await c.co.fetch(await req("/v1/workers"));
    // 200 requests, 10,000 rows read and 200 written: 10 writes by count, a step of 250 written never crossed.
    expect(kvWrites(c)).toBeLessThanOrEqual(10 + Math.ceil(10_000 / WORLD_BUDGET.readStep));
    expect(kvWrites(c)).toBeGreaterThan(0);
    expect(c.kv.get("weft.budget")).toMatchObject({ key: expect.stringMatching(/^g3:d\d{4}-\d{2}-\d{2}$/), rowsRead: expect.any(Number), events: expect.any(Number) });
  });

  it("answers the showcase 503 SHOWCASE_LIMIT past its rows read for the UTC day, and serves again the next day", async () => {
    const c = company({ stamp: { slot: "showcase", gen: 1, mode: "showcase", visitor: null, ipHash: null, leaseStartedAt: null } });
    await c.ready();
    world.rows = () => ({ rowsRead: 100_000, rowsWritten: 0 });
    const show = (o: { gen?: number } = {}) => req("/v1/workers", { slot: "showcase", gen: o.gen ?? 0, visitor: null });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await c.co.fetch(await show())).status);
    expect(statuses.filter((x) => x === 200)).toHaveLength(WORLD_BUDGET.showcaseRowsReadPerDay / 100_000);
    const r = await c.co.fetch(await show());
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: "SHOWCASE_LIMIT" });
    at(T0 + 24 * 60 * MIN);
    expect((await c.co.fetch(await show())).status).toBe(200);
  });
});
