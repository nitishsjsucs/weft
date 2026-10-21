// LobbyDO.assign under interleaving (design 6.2, cf4 review minor 8): the per-IP-hash lease cap holds when starts from
// one address arrive together. In a Durable Object, other calls run while one awaits KV or another object (only
// storage holds the input gate), so the Lobby runs here on Node over a fake ctx whose KV, SpendDO and slot calls all
// yield, which makes every start pass its first look at the cap before any of them takes a slot.
import { describe, expect, it } from "vitest";
import { HOSTED_SETTINGS } from "../../src/shared/contracts";
import { utcDay } from "../../src/shared/http";
import { LobbyDO } from "../../src/core/lobby/lobby-do";
import { memorySql } from "./sqlite";

const yieldTick = () => new Promise((r) => setTimeout(r, 1));

function lobbyOver(pool: number): { lobby: LobbyDO; stamps: string[] } {
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
  return { lobby, stamps };
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
