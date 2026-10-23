// CompanyDO's own plumbing on Node over a fake ctx and env, with a small fake engine behind the EngineModule seam
// (design 3.3, 4.6, 6.3): the MCP key's lease check, the minted key's expiry, the alarm's retry, the boot that two
// callers share, the outbox flush under the world's write lock, and the I/O guards. The clock here is Date only (fake
// timers for Date), so a lease's 3 hours pass at once. The Miniflare suite runs the same class in workerd.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOSTED_SETTINGS, type HostedJob, type TxGuard } from "../../src/shared/contracts";
import { setEngineLoader, type EngineModule, type WorldBootInput, type WorldEngine } from "../../src/core/company/engine";
import type { WorldStamp } from "../../src/core/company/rpc";
import { readStamp, writeStamp } from "../../src/core/company/world-state";
import { signCtx } from "../../src/shared/tokens";
import { memorySql } from "./sqlite";

(globalThis as { WebSocketRequestResponsePair?: unknown }).WebSocketRequestResponsePair ??= class { constructor(readonly request: string, readonly response: string) {} };
const { CompanyDO } = await import("../../src/core/company/company-do");

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
}
let world: FakeWorld;
const fresh = (): FakeWorld => ({ boots: 0, bootDelayMs: 0, failBoots: 0, inTx: false, scoped: null, lockTail: Promise.resolve(), input: null, engine: null });

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
      measure: async (fn) => ({ value: await fn(), usage: { statements: 0, rowsRead: 0, rowsWritten: 0, tablesRead: [], tablesWritten: [] } }),
      totals: () => ({ statements: 0, rowsRead: 0, rowsWritten: 0, tablesRead: [], tablesWritten: [] }),
      reset() {}, version: () => 0, versions: () => ({}), onCommit: () => () => undefined,
    },
    guard,
    fetch: async (req) => new Response(JSON.stringify({ path: new URL(req.url).pathname }), { headers: { "content-type": "application/json" } }),
    mcp: async () => new Response(JSON.stringify({ mcp: true }), { headers: { "content-type": "application/json" } }),
    inScope: async (fn) => { if (world.scoped) await world.scoped(); return fn(); },
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
    close: async () => undefined,
  } as WorldEngine;
}

let currentSql: ReturnType<typeof memorySql> | null = null;
const fakeModule: EngineModule = {
  async boot(input) {
    world.boots += 1;
    if (world.bootDelayMs) await sleep(world.bootDelayMs);
    if (world.failBoots > 0) { world.failBoots -= 1; throw new Error("fake boot failure"); }
    world.input = input;
    world.engine = engineFor(input, currentSql!.sql);
    return world.engine;
  },
  store: { isClean: () => true } as unknown as EngineModule["store"],
  artifacts: async () => ({ version: "fake", manifest: { journalHash: "x", digest: "x", chunks: 0, rows: 0 }, snapshot: {} }),
};
setEngineLoader(async () => fakeModule);

type LobbyStatusFn = (input: { visitor: string | null; slot?: string | null; gen?: number | null }) => unknown;

function company(o: { stamp?: Partial<WorldStamp> | null; lobbyStatus?: LobbyStatusFn; failSetAlarms?: number } = {}) {
  const m = memorySql();
  currentSql = m;
  m.sql.exec(`CREATE TABLE kv_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  m.sql.exec(`CREATE TABLE outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`);
  const stamp: WorldStamp | null = o.stamp === null ? null : { slot: "slot-1", gen: 3, mode: "slot", visitor: VISITOR, ipHash: "i".repeat(32), leaseStartedAt: T0, ...o.stamp };
  if (stamp) m.transactionSync(() => writeStamp(m.sql, stamp));
  const kv = new Map<string, unknown>();
  const failing = { n: o.failSetAlarms ?? 0 };
  const waits: Promise<unknown>[] = [];
  const recorded: unknown[][] = [];
  const alarms: number[] = [];
  let alarm: number | null = null;
  let ready: Promise<unknown> = Promise.resolve();
  const lobbyCalls: { method: string; input: unknown }[] = [];
  const sent: { queue: string; body: unknown }[] = [];
  const ctx = {
    id: { name: stamp?.slot ?? "slot-1" },
    storage: {
      sql: m.sql, transactionSync: <T>(fn: () => T) => m.transactionSync(fn),
      kv: { get: (k: string) => kv.get(k), put: (k: string, v: unknown) => { kv.set(k, v); }, delete: (k: string) => kv.delete(k) },
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
    CONFIG: { get: async (keys: string[] | string) => (Array.isArray(keys) ? new Map(keys.map((k) => [k, null])) : null) },
    LOBBY: { idFromName: (n: string) => n, get: () => lobbyStub },
    SPEND: { idFromName: (n: string) => n, get: () => ({}) },
    COMPANY: { idFromName: (n: string) => n, get: () => ({}) },
    JOBS: { send: async (body: unknown) => { sent.push({ queue: "jobs", body }); } },
    RENDER: { send: async (body: unknown) => { sent.push({ queue: "render", body }); } },
    RL_RUN: { limit: async () => ({ success: true }) },
    OPS: { prepare: () => ({ bind: (...b: unknown[]) => ({ run: async () => { recorded.push(b); return {}; } }) }) },
  };
  const co = new CompanyDO(ctx as never, env as never);
  return { co, ready: () => ready, m, alarms, failing, lobbyCalls, sent, stamp, waits, recorded };
}

async function req(path: string, o: { method?: string; visitor?: string | null; slot?: string; gen?: number; body?: string; headers?: Record<string, string> } = {}): Promise<Request> {
  const ctx = await signCtx(CTX, { slot: o.slot ?? "slot-1", gen: o.gen ?? 3, visitor: o.visitor === undefined ? VISITOR : o.visitor, ipHash: "i".repeat(32), human: true, smoke: false, iat: Math.floor(Date.now() / 1000) });
  return new Request(`https://weft.test${path}`, { method: o.method ?? "GET", headers: { "x-weft-ctx": ctx, ...o.headers }, ...(o.body !== undefined ? { body: o.body } : {}) });
}
const mcp = (o: { gen?: number } = {}) => req("/mcp", { method: "POST", visitor: null, gen: o.gen, body: "{}", headers: { authorization: `Bearer wk_mcp_slot-1_3_${"k".repeat(24)}` } });
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
    // Busy all along, so never idle; the 3 hours still end it.
    for (const t of [60, 120, 170, 179]) { at(T0 + t * MIN); await c.co.fetch(await req("/v1/workers")); }
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
    const lease = () => ({ slot: "slot-1", gen: 3, expiresAt: new Date(T0 + 180 * MIN).toISOString(), idleExpiresAt: new Date(T0 + 40 * MIN).toISOString(), resetsLeft: 3 });
    const c = company({ lobbyStatus: () => ({ level: 0, pool: { size: 2, free: 0, waitlist: 0 }, lease: lease(), waitlistPosition: null, worldProvider: null }) });
    await c.ready();
    at(T0 + 15 * MIN);
    expect((await c.co.fetch(await mcp())).status).toBe(200);
    expect((await c.co.fetch(await mcp())).status).toBe(200);
    expect(c.lobbyCalls.filter((x) => x.method === "status")).toEqual([{ method: "status", input: { visitor: VISITOR, slot: "slot-1", gen: 3, now: T0 + 15 * MIN } }]);
    // The Lobby's last-seen time (10 minutes in) is now this instance's: idle 30 minutes after it.
    at(T0 + 41 * MIN);
    expect((await c.co.fetch(await mcp())).status).toBe(409);

    const gone = company();
    await gone.ready();
    at(T0 + 5 * MIN);
    expect((await gone.co.fetch(await mcp())).status).toBe(409);
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

describe("the world's boot", () => {
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
