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
}
let world: FakeWorld;
const fresh = (): FakeWorld => ({ boots: 0, bootDelayMs: 0, failBoots: 0, inTx: false, scoped: null, lockTail: Promise.resolve(), input: null });

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
    return engineFor(input, currentSql!.sql);
  },
  store: { isClean: () => true } as unknown as EngineModule["store"],
  artifacts: async () => ({ version: "fake", manifest: { journalHash: "x", digest: "x", chunks: 0, rows: 0 }, snapshot: {} }),
};
setEngineLoader(async () => fakeModule);

type LobbyStatusFn = (input: { visitor: string | null; slot?: string | null; gen?: number | null }) => unknown;

function company(o: { stamp?: Partial<WorldStamp> | null; lobbyStatus?: LobbyStatusFn } = {}) {
  const m = memorySql();
  currentSql = m;
  m.sql.exec(`CREATE TABLE kv_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  m.sql.exec(`CREATE TABLE outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`);
  const stamp: WorldStamp | null = o.stamp === null ? null : { slot: "slot-1", gen: 3, mode: "slot", visitor: VISITOR, ipHash: "i".repeat(32), leaseStartedAt: T0, ...o.stamp };
  if (stamp) m.transactionSync(() => writeStamp(m.sql, stamp));
  const kv = new Map<string, unknown>();
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
      setAlarm: (t: number) => { alarms.push(t); alarm = t; }, getAlarm: () => alarm, deleteAll: async () => undefined,
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => (ready = fn()),
    setWebSocketAutoResponse: () => undefined, acceptWebSocket: () => undefined, getWebSockets: () => [], getTags: () => [],
    waitUntil: () => undefined, abort: () => undefined,
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
  };
  const co = new CompanyDO(ctx as never, env as never);
  return { co, ready: () => ready, m, alarms, lobbyCalls, sent, stamp };
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
