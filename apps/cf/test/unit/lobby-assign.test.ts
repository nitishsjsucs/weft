// LobbyDO.assign under interleaving (design 6.2, cf4 review minor 8): the per-IP-hash lease cap holds when starts from
// one address arrive together. In a Durable Object, other calls run while one awaits KV or another object (only
// storage holds the input gate), so the Lobby runs here on Node over a fake ctx whose KV, SpendDO and slot calls all
// yield, which makes every start pass its first look at the cap before any of them takes a slot.
import { describe, expect, it } from "vitest";
import { HOSTED_SETTINGS } from "../../src/shared/contracts";
import { utcDay } from "../../src/shared/http";
import { LobbyDO } from "../../src/core/lobby/lobby-do";
import { FULL_RESTORE_ROWS, WAITLIST_MAX, WAITLIST_TTL_MS } from "../../src/core/lobby/policy";
import { LAST_SEEN_WRITE_MS } from "../../src/core/lobby/lobby-do";
import { memorySql, readMeter, writeMeter } from "./sqlite";

const yieldTick = () => new Promise((r) => setTimeout(r, 1));

/** A pool slot as the Lobby sees it: its usage since the last drain, its visitor's last activity, and every heartbeat. */
interface FakeSlot { usage: { rowsRead: number; rowsWritten: number; requests: number }; lastActivityMs: number | null; heartbeats: Record<string, unknown>[] }

function lobbyOver(pool: number): { lobby: LobbyDO; stamps: string[]; m: ReturnType<typeof memorySql>; wake: () => LobbyDO; slots: Map<string, FakeSlot> } {
  const m = memorySql();
  const ctx = { storage: { sql: m.sql, transactionSync: <T>(fn: () => T) => m.transactionSync(fn) }, waitUntil: () => undefined };
  const stamps: string[] = [];
  const slots = new Map<string, FakeSlot>();
  const slotOf = (name: string) => { let f = slots.get(name); if (!f) { f = { usage: { rowsRead: 0, rowsWritten: 0, requests: 0 }, lastActivityMs: null, heartbeats: [] }; slots.set(name, f); } return f; };
  const env = {
    WEFT_POOL_SIZE: String(pool),
    WEFT_CONFIG_MEMO_MS: "0",
    CONFIG: { get: async (keys: string[] | string) => { await yieldTick(); return Array.isArray(keys) ? new Map(keys.map((k) => [k, null])) : null; } },
    SPEND: {
      idFromName: (n: string) => n,
      get: () => ({
        status: async () => {
          await yieldTick();
          return { caps: { dayUsd: 2, neuronsDay: 5000 }, spentMicros: { day: 0 }, neurons: { used: 0 } };
        },
      }),
    },
    COMPANY: {
      idFromName: (n: string) => n,
      get: (slot: string) => ({
        applyStamp: async (s: { visitor: string }) => { await yieldTick(); stamps.push(`${slot}:${s.visitor}`); return { ok: true, gen: 1 }; },
        heartbeat: async (opts: { keepUsage?: boolean } = {}) => {
          await yieldTick();
          const f = slotOf(slot);
          f.heartbeats.push(opts);
          const usage = opts.keepUsage ? { rowsRead: 0, rowsWritten: 0, requests: 0 } : f.usage;
          if (!opts.keepUsage) f.usage = { rowsRead: 0, rowsWritten: 0, requests: 0 };
          return { stamped: null, lastActivityMs: f.lastActivityMs, clean: true, usage, snapshot: null };
        },
      }),
    },
  };
  const lobby = new LobbyDO(ctx as never, env as never);
  m.sql.exec(`UPDATE slots SET state = 'ready'`);
  /** The same object after a hibernation: a new instance over the same storage, with nothing in memory. */
  const wake = () => new LobbyDO(ctx as never, env as never);
  return { lobby, stamps, m, wake, slots };
}

const visitor = (i: number) => `vis_${i.toString(16).padStart(32, "0")}`;

describe("LobbyDO.assign under interleaving", () => {
  it("leases one slot, not one per start, when an address has one lease left today", async () => {
    const { lobby } = lobbyOver(4);
    const ipHash = "a".repeat(32);
    await lobby.extrasCounterAdd(`ip:${ipHash}`, HOSTED_SETTINGS.leasesPerIpHashPerDay - 1, utcDay());
    const results = await Promise.all([1, 2, 3, 4].map((i) => lobby.assign({ visitor: visitor(i), ipHash })));
    expect(results.filter((r) => r.status === "leased")).toHaveLength(1);
    expect(results.filter((r) => r.status === "ip_limit")).toHaveLength(3);
    expect(await lobby.counter({ key: `ip:${ipHash}` })).toBe(HOSTED_SETTINGS.leasesPerIpHashPerDay);
  });

  it("still gives concurrent starts from different addresses their own slots", async () => {
    const { lobby, stamps } = lobbyOver(4);
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => lobby.assign({ visitor: visitor(i), ipHash: String(i).repeat(32) })));
    const leased = results.filter((r) => r.status === "leased") as { slot: string }[];
    expect(leased).toHaveLength(4);
    expect(new Set(leased.map((r) => r.slot)).size).toBe(4);
    expect(results.filter((r) => r.status === "waitlist")).toHaveLength(1);
    expect(stamps).toHaveLength(4);
  });
});

describe("LobbyDO.status after a hosted reset", () => {
  const sql = (lobby: LobbyDO) => (lobby as unknown as { sql: { exec(q: string, ...b: unknown[]): unknown } }).sql;
  const leaseMs = (l: { expiresAt?: string }) => Date.parse(l.expiresAt!);

  it("answers a cookie of an older generation of the visitor's own lease with the lease as it is now", async () => {
    const { lobby } = lobbyOver(2);
    const me = visitor(40);
    const l = await lobby.assign({ visitor: me, ipHash: "c".repeat(32) });
    if (l.status !== "leased") throw new Error(`not leased: ${l.status}`);
    // What a reset that kept the lease leaves behind: the lease row on the next generation, with the same start.
    sql(lobby).exec(`UPDATE leases SET gen = gen + 1 WHERE visitor = ?`, me);
    const now = await lobby.status({ visitor: me, slot: l.slot, gen: l.gen, leaseExpiresMs: leaseMs(l) });
    expect(now.lease).toMatchObject({ slot: l.slot, gen: l.gen + 1 });
    expect((await lobby.status({ visitor: me, slot: l.slot, gen: l.gen + 1, leaseExpiresMs: leaseMs(l) })).lease).toMatchObject({ gen: l.gen + 1 });
    // Without the lease it was issued for, an older generation names nothing; the lease's own generation still does.
    expect((await lobby.status({ visitor: me, slot: l.slot, gen: l.gen })).lease).toBeNull();
    expect((await lobby.status({ visitor: me, slot: l.slot, gen: l.gen + 1 })).lease).toMatchObject({ gen: l.gen + 1 });
  });

  it("never moves a cookie of an earlier, ended lease of the same visitor onto a later lease of that slot", async () => {
    const { lobby } = lobbyOver(1);
    // An operator visitor id is stable per name, so the same visitor leases the same slot again.
    const me = visitor(43);
    const first = await lobby.assign({ visitor: me, ipHash: "c".repeat(32), now: Date.now() - 5 * 60_000 });
    if (first.status !== "leased") throw new Error(`not leased: ${first.status}`);
    // The first lease ends and its slot is reset (the next generation); the visitor leases the slot again.
    sql(lobby).exec(`DELETE FROM leases WHERE visitor = ?`, me);
    sql(lobby).exec(`UPDATE slots SET gen = gen + 1 WHERE name = ?`, first.slot);
    const second = await lobby.assign({ visitor: me, ipHash: "c".repeat(32) });
    if (second.status !== "leased") throw new Error(`not leased: ${second.status}`);
    expect(second).toMatchObject({ slot: first.slot, gen: first.gen + 1 });
    // The first lease's cookie: an older generation of the slot, the same visitor, another lease. No lease.
    expect((await lobby.status({ visitor: me, slot: first.slot, gen: first.gen, leaseExpiresMs: leaseMs(first) })).lease).toBeNull();
    expect((await lobby.status({ visitor: me, slot: first.slot, gen: second.gen, leaseExpiresMs: leaseMs(first) })).lease).toBeNull();
    // The second lease's own cookie still names it.
    expect((await lobby.status({ visitor: me, slot: second.slot, gen: second.gen, leaseExpiresMs: leaseMs(second) })).lease).toMatchObject({ gen: second.gen });
  });

  it("still answers no lease for another visitor, another slot or a cookie newer than the lease", async () => {
    const { lobby } = lobbyOver(2);
    const me = visitor(41);
    const l = await lobby.assign({ visitor: me, ipHash: "d".repeat(32) });
    if (l.status !== "leased") throw new Error(`not leased: ${l.status}`);
    const other = l.slot === "slot-1" ? "slot-2" : "slot-1";
    expect((await lobby.status({ visitor: visitor(42), slot: l.slot, gen: l.gen, leaseExpiresMs: leaseMs(l) })).lease).toBeNull();
    expect((await lobby.status({ visitor: me, slot: other, gen: l.gen, leaseExpiresMs: leaseMs(l) })).lease).toBeNull();
    expect((await lobby.status({ visitor: me, slot: l.slot, gen: l.gen + 1, leaseExpiresMs: leaseMs(l) })).lease).toBeNull();
  });
});

describe("LobbyDO's rebuild of a slot the reset could not return to the seed", () => {
  it("deletes the vectors the slot's generations upserted, as a reset in place does", async () => {
    const m = memorySql();
    const ctx = { storage: { sql: m.sql, transactionSync: <T>(fn: () => T) => m.transactionSync(fn) }, waitUntil: () => undefined };
    const deleted: string[][] = [];
    const created: unknown[] = [];
    const env = {
      WEFT_POOL_SIZE: "2",
      WEFT_CONFIG_MEMO_MS: "0",
      CONFIG: { get: async (keys: string[] | string) => (Array.isArray(keys) ? new Map(keys.map((k) => [k, k === "lobby.provision_rows_ceiling" ? "400000" : null])) : null) },
      SPEND: { idFromName: (n: string) => n, get: () => ({ status: async () => ({ caps: { dayUsd: 2, neuronsDay: 5000 }, spentMicros: { day: 0 }, neurons: { used: 0 } }) }) },
      MEMVEC: { deleteByIds: async (ids: string[]) => { deleted.push(ids); return { mutationId: "m" }; } },
      RESEED: { create: async (o: unknown) => { created.push(o); return {}; } },
      COMPANY: {
        idFromName: (n: string) => n,
        get: () => ({
          applyStamp: async () => ({ ok: true, gen: 1 }),
          heartbeat: async () => ({ stamped: null, lastActivityMs: null, clean: false, usage: { rowsRead: 0, rowsWritten: 0, requests: 0 }, snapshot: null }),
          // The delta reset finds a digest mismatch: the slot goes to a full restore.
          deltaReset: async () => ({ ok: false, method: "delta", gen: 1, rowsWritten: 0, mismatches: ["notes"], ms: 1 }),
          endLease: async () => undefined,
        }),
      },
    };
    const lobby = new LobbyDO(ctx as never, env as never);
    m.sql.exec(`UPDATE slots SET state = 'ready', gen = 1`);
    const l = await lobby.assign({ visitor: visitor(60), ipHash: "e".repeat(32) });
    if (l.status !== "leased") throw new Error(`not leased: ${l.status}`);
    await lobby.recordVectors({ slot: l.slot, gen: 1, ids: ["v1", "v2"] });
    await lobby.recordVectors({ slot: "slot-other", gen: 1, ids: ["keep"] });
    await lobby.release({ slot: l.slot, reason: "test" });
    expect(created).toHaveLength(1);
    expect(deleted).toEqual([["v1", "v2"]]);
    expect(m.sql.exec(`SELECT slot, id FROM vectors ORDER BY id`).toArray()).toEqual([{ slot: "slot-other", id: "keep" }]);
  });
});

describe("LobbyDO's Platform readout", () => {
  it("is memoized for 30 s, so GET /api/_hosted/platform reads the day's counters at most once per 30 s", async () => {
    const { lobby, m } = lobbyOver(4);
    const exec = m.sql.exec.bind(m.sql);
    let reads = 0;
    m.sql.exec = ((q: string, ...b: unknown[]) => { if (/\bFROM (counters|leases|slots|waitlist)\b/i.test(q)) reads += 1; return exec(q, ...b); }) as typeof m.sql.exec;
    const now = Date.now();
    const first = await lobby.readout({ now });
    const once = reads;
    expect(once).toBeGreaterThan(0);
    // Any number of visitors in the next 30 s, through either RPC the Platform page uses, read nothing more.
    for (let i = 0; i < 50; i++) expect(await lobby.readout({ now: now + 29_000 })).toEqual(first);
    expect(await lobby.extrasReadout()).toEqual(first);
    expect(reads).toBe(once);
    // After 30 s it is read again, and what changed shows.
    // A full restore's rows written today: one restore fewer is left.
    await lobby.extrasCounterAdd("restore_rows", FULL_RESTORE_ROWS, utcDay(now));
    const later = await lobby.readout({ now: now + 30_000 });
    expect(reads).toBeGreaterThan(once);
    expect(later.restoresLeft).toBe(first.restoresLeft - 1);
    // It carries the extras' counters and the SpendDO status the level read, so the Platform page asks neither.
    expect(first.counters).toEqual({ "help.queries": 0, "pdf.browser_ms": 0 });
    expect(first.spend).toMatchObject({ caps: { dayUsd: 2 } });
    await lobby.extrasCounterAdd("help.queries", 3, utcDay(now));
    expect((await lobby.readout({ now: now + 61_000 })).counters["help.queries"]).toBe(3);
    // The admin ops readout is always fresh.
    const n = reads;
    await lobby.ops({ now: now + 31_000 });
    expect(reads).toBeGreaterThan(n);
  });
});

describe("LobbyDO's waitlist", () => {
  const count = (m: ReturnType<typeof memorySql>) => Number(m.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM waitlist`).toArray()[0]!.n);

  it(`holds at most ${WAITLIST_MAX} live entries: a new visitor past it is answered full and not added, one in line keeps its place, and stale entries free their places`, async () => {
    expect(WAITLIST_MAX).toBe(50);
    const { lobby, m } = lobbyOver(1);
    const t0 = Date.now();
    expect((await lobby.assign({ visitor: visitor(1), ipHash: "a".repeat(32), now: t0 })).status).toBe("leased");
    // A cookie-less visitor retrying: every attempt is a new visitor id.
    const results = [];
    for (let i = 0; i < 3 * WAITLIST_MAX; i++) results.push(await lobby.assign({ visitor: visitor(1000 + i), ipHash: "b".repeat(32), now: t0 + i }));
    expect(results.slice(0, WAITLIST_MAX).map((r) => r.status === "waitlist" && r.position)).toEqual(Array.from({ length: WAITLIST_MAX }, (_, i) => i + 1));
    expect(results.slice(WAITLIST_MAX).every((r) => r.status === "full" && r.poolSize === 1)).toBe(true);
    expect(count(m)).toBe(WAITLIST_MAX);
    expect((await lobby.status({ visitor: null, now: t0 + 200 })).pool.waitlist).toBe(WAITLIST_MAX);
    // One already in line asks again: same place, no new entry.
    expect(await lobby.assign({ visitor: visitor(1003), ipHash: "b".repeat(32), now: t0 + 1_000 })).toMatchObject({ status: "waitlist", position: 4 });
    // Ten of them keep asking; the TTL passes for the rest, whose places free up for new visitors.
    for (let i = 0; i < 10; i++) await lobby.assign({ visitor: visitor(1000 + i), ipHash: "b".repeat(32), now: t0 + WAITLIST_TTL_MS - 1_000 });
    const later = t0 + WAITLIST_TTL_MS + 3 * WAITLIST_MAX;
    expect(await lobby.assign({ visitor: visitor(5000), ipHash: "c".repeat(32), now: later })).toMatchObject({ status: "waitlist", position: 11 });
    expect(count(m)).toBe(11);
    expect((await lobby.status({ visitor: visitor(5000), now: later })).waitlistPosition).toBe(11);
  });

  it("answers a cookie-less status and the Platform readout with bounded reads on a Lobby that just woke up, however many counters and stale entries today holds", async () => {
    const reads = async (n: number) => {
      const { lobby, m, wake } = lobbyOver(2);
      const now = Date.now();
      for (const i of [1, 2]) expect((await lobby.assign({ visitor: visitor(i), ipHash: String(i).repeat(32), now })).status).toBe("leased");
      // Today's other counters: a row per IP hash that leased, per visitor upload, per admin signature.
      const day = utcDay(now);
      const counter = m.db.prepare(`INSERT INTO counters (day, key, n) VALUES (?, ?, 1)`);
      for (let i = 0; i < n; i++) { counter.run(day, `ip:${i}`); counter.run(day, `upload:vis_${i}`); counter.run(day, `admin_sig:${i}`); }
      // A full line, and stale entries the sweep has not deleted yet.
      const entry = m.db.prepare(`INSERT INTO waitlist (visitor, ip_hash, at, seen) VALUES (?, 'x', ?, ?)`);
      for (let i = 0; i < n; i++) entry.run(`vis_stale_${i}`, now - 2 * WAITLIST_TTL_MS, now - 2 * WAITLIST_TTL_MS);
      for (let i = 0; i < WAITLIST_MAX; i++) entry.run(`vis_live_${i}`, now, now);
      const meter = readMeter(m);
      // Each read reaches a Lobby with no memo: the object hibernated since the last one.
      const status = await wake().status({ visitor: null, now });
      expect(status.pool).toEqual({ size: 2, free: 0, waitlist: WAITLIST_MAX });
      const afterStatus = meter.rows;
      const readout = await wake().readout({ now });
      expect(readout.leases).toEqual({ active: 2, pool: 2, waitlist: WAITLIST_MAX });
      return { status: afterStatus, readout: meter.rows - afterStatus };
    };
    const small = await reads(10);
    const large = await reads(3_000);
    expect(large).toEqual(small);
    // The six usage counters, the slots and leases of the pool, and one count of the line through its index.
    expect(small.status).toBeLessThanOrEqual(20);
    expect(small.readout).toBeLessThanOrEqual(30);
  });
});

describe("a lease holder's GET /api/_session", () => {
  const counter = (m: ReturnType<typeof memorySql>, key: string) => Number(m.sql.exec<{ n: number }>(`SELECT n FROM counters WHERE day = ? AND key = ?`, utcDay(), key).toArray()[0]?.n ?? 0);
  const storedLastSeen = (m: ReturnType<typeof memorySql>) => Number(m.sql.exec<{ t: number }>(`SELECT last_seen AS t FROM leases`).toArray()[0]!.t);

  it("writes no Lobby row per poll: the heartbeat leaves the slot's usage in the slot, and the last-seen time is written once a minute", async () => {
    const { lobby, m, slots, wake } = lobbyOver(2);
    const t0 = Date.now();
    const v = visitor(7);
    const lease = await lobby.assign({ visitor: v, ipHash: "7".repeat(32), now: t0 });
    expect(lease.status).toBe("leased");
    const slot = (lease as { slot: string }).slot;
    const f = slots.get(slot) ?? (slots.set(slot, { usage: { rowsRead: 0, rowsWritten: 0, requests: 0 }, lastActivityMs: null, heartbeats: [] }), slots.get(slot)!);
    const w = writeMeter(m);
    // A tab polls every 2 s for 3 minutes while its visitor works: each poll finds new usage and newer activity.
    let last = null as Awaited<ReturnType<LobbyDO["status"]>> | null;
    for (let i = 1; i <= 90; i++) {
      const now = t0 + i * 2_000;
      f.usage = { rowsRead: f.usage.rowsRead + 400, rowsWritten: f.usage.rowsWritten + 3, requests: f.usage.requests + 2 };
      f.lastActivityMs = now - 500;
      last = await lobby.status({ visitor: v, slot, gen: 0, now });
      expect(last.lease?.slot).toBe(slot);
    }
    // 180 s of polls: the last-seen time was written about once a minute (3 rows), nothing else.
    expect(w.rows).toBeLessThanOrEqual(Math.ceil((90 * 2_000) / LAST_SEEN_WRITE_MS));
    expect([...w.tables]).toEqual(["leases"]);
    expect(f.heartbeats.every((h) => h.keepUsage === true)).toBe(true);
    // The lease answer still reads the freshest activity (kept in memory), not the stored one.
    expect(Date.parse(last!.lease!.idleExpiresAt)).toBe(t0 + 180_000 - 500 + 30 * 60_000);
    expect(t0 + 180_000 - storedLastSeen(m)).toBeLessThanOrEqual(LAST_SEEN_WRITE_MS + 500);
    expect(counter(m, "rows_read")).toBe(0);
    // A Lobby that just woke up still finds the lease live, from the stored time and the slot's heartbeat.
    const cold = await wake().status({ visitor: v, slot, gen: 0, now: t0 + 181_000 });
    expect(Date.parse(cold.lease!.idleExpiresAt)).toBe(t0 + 180_000 - 500 + 30 * 60_000);
    // The sweep collects what the polls left in the slot.
    await lobby.sweep({ now: t0 + 182_000 });
    expect(counter(m, "rows_read")).toBe(90 * 400);
    expect(counter(m, "rows_written")).toBe(90 * 3);
    expect(counter(m, "do_requests")).toBe(90 * 2);
    expect(f.usage).toEqual({ rowsRead: 0, rowsWritten: 0, requests: 0 });
  });
});
