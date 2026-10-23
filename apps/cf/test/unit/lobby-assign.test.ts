// LobbyDO.assign under interleaving (design 6.2, cf4 review minor 8): the per-IP-hash lease cap holds when starts from
// one address arrive together. In a Durable Object, other calls run while one awaits KV or another object (only
// storage holds the input gate), so the Lobby runs here on Node over a fake ctx whose KV, SpendDO and slot calls all
// yield, which makes every start pass its first look at the cap before any of them takes a slot.
import { describe, expect, it } from "vitest";
import { HOSTED_SETTINGS } from "../../src/shared/contracts";
import { utcDay } from "../../src/shared/http";
import { LobbyDO } from "../../src/core/lobby/lobby-do";
import { FULL_RESTORE_ROWS } from "../../src/core/lobby/policy";
import { memorySql } from "./sqlite";

const yieldTick = () => new Promise((r) => setTimeout(r, 1));

function lobbyOver(pool: number): { lobby: LobbyDO; stamps: string[]; m: ReturnType<typeof memorySql> } {
  const m = memorySql();
  const ctx = { storage: { sql: m.sql, transactionSync: <T>(fn: () => T) => m.transactionSync(fn) }, waitUntil: () => undefined };
  const stamps: string[] = [];
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
        heartbeat: async () => { await yieldTick(); return { stamped: null, lastActivityMs: null, clean: true, usage: { rowsRead: 0, rowsWritten: 0, requests: 0 }, snapshot: null }; },
      }),
    },
  };
  const lobby = new LobbyDO(ctx as never, env as never);
  m.sql.exec(`UPDATE slots SET state = 'ready'`);
  return { lobby, stamps, m };
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
    // The admin ops readout is always fresh.
    const n = reads;
    await lobby.ops({ now: now + 31_000 });
    expect(reads).toBeGreaterThan(n);
  });
});
