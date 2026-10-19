import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSpendLedger, LUNA, reserveUsd, stepCostUsd, usdToMicros } from "../src/index";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "weft-spend-"));
  dirs.push(d);
  return join(d, "spend");
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("cost", () => {
  it("prices Luna with the three prices", () => {
    expect(LUNA).toEqual({ inPerM: 0.2, cachedPerM: 0.02, outPerM: 1.2 });
    const usd = stepCostUsd({ input: 3000, cached: 2000, cacheWrite: 500, output: 200, reasoning: 50 });
    expect(usd).toBeCloseTo((1000 * 0.2 + 2000 * 0.02 + 200 * 1.2) / 1e6, 12);
    expect(reserveUsd(3000, 8000)).toBeCloseTo((3000 * 0.2 + 8000 * 1.2) / 1e6, 12);
  });
});

describe("spend ledger", () => {
  it("reserves, settles and releases into <UTC wall date>.jsonl", async () => {
    const dir = tmp();
    const ledger = createSpendLedger({ dir, caps: { runUsd: 0.1, dayUsd: 2, liveUsd: 0.5 }, wallNow: () => new Date("2026-10-15T23:30:00-07:00") });
    const r = await ledger.reserve({ runId: "run_0001", usdMicros: 9_000, model: "gpt-5.6-luna", live: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(readdirSync(dir).filter((f) => f.endsWith(".jsonl"))).toEqual(["2026-10-16.jsonl"]);
    expect(await ledger.spent({ runId: "run_0001" })).toBe(0);
    expect((await ledger.committed({ runId: "run_0001" })).openMicros).toBe(9_000);
    await ledger.settle(r.reservationId, 1_234);
    expect(await ledger.spent({ runId: "run_0001" })).toBe(1_234);
    expect(await ledger.spent({ live: true })).toBe(1_234);
    const r2 = await ledger.reserve({ runId: "run_0001", usdMicros: 5_000, model: "gpt-5.6-luna", live: true });
    if (!r2.ok) throw new Error("expected ok");
    await ledger.release(r2.reservationId);
    expect(await ledger.committed({ runId: "run_0001" })).toEqual({ settledMicros: 1_234, openMicros: 0 });
  });

  it("acceptance: a reservation over WEFT_LIVE_USD_CAP is refused with cap live", async () => {
    const ledger = createSpendLedger({ dir: tmp(), env: { WEFT_LIVE_USD_CAP: "0.50", WEFT_RUN_USD_CAP: "10", WEFT_DAY_USD_CAP: "10" } });
    const a = await ledger.reserve({ runId: "run_a", usdMicros: 450_000, model: "gpt-5.6-luna", live: true });
    expect(a.ok).toBe(true);
    const b = await ledger.reserve({ runId: "run_b", usdMicros: 60_000, model: "gpt-5.6-luna", live: true });
    expect(b).toEqual({ ok: false, code: "BUDGET_EXCEEDED", cap: "live", spentMicros: 450_000 });
    // Scripted spend never counts against the live cap.
    expect((await ledger.reserve({ runId: "run_c", usdMicros: 60_000, model: "scripted", live: false })).ok).toBe(true);
  });

  it("refuses over the run cap and the day cap", async () => {
    const ledger = createSpendLedger({ dir: tmp(), caps: { runUsd: 0.1, dayUsd: 0.15, liveUsd: 5 } });
    expect(await ledger.reserve({ runId: "run_1", usdMicros: 100_001, model: "m", live: true })).toMatchObject({ ok: false, cap: "run" });
    expect((await ledger.reserve({ runId: "run_1", usdMicros: 90_000, model: "m", live: true })).ok).toBe(true);
    expect(await ledger.reserve({ runId: "run_2", usdMicros: 90_000, model: "m", live: true })).toMatchObject({ ok: false, cap: "day" });
  });

  it("acceptance: the ledger is keyed by the wall clock, never the sim clock (reset and advance never touch it)", async () => {
    const dir = tmp();
    const ledger = createSpendLedger({ dir, wallNow: () => new Date("2026-10-15T20:00:00Z") });
    const r = await ledger.reserve({ runId: null, usdMicros: 10, model: "m", live: true });
    if (!r.ok) throw new Error("expected ok");
    await ledger.settle(r.reservationId, 7);
    // A second ledger on the same dir (a new world after reset, any sim time) sees the same spend.
    const again = createSpendLedger({ dir, wallNow: () => new Date("2026-10-15T21:00:00Z") });
    expect(await again.spent({ day: "2026-10-15" })).toBe(7);
  });

  it("acceptance: a stale lock older than 10 s is recovered", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".lock"), { recursive: true });
    const old = new Date(Date.now() - 11_000);
    utimesSync(join(dir, ".lock"), old, old);
    const ledger = createSpendLedger({ dir });
    const r = await ledger.reserve({ runId: null, usdMicros: 1, model: "m", live: false });
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, ".lock"))).toBe(false);
  });

  it("a fresh lock held by another writer times out after the retry window", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".lock"), { recursive: true });
    const ledger = createSpendLedger({ dir, lockRetryMs: 100 });
    await expect(ledger.reserve({ runId: null, usdMicros: 1, model: "m", live: false })).rejects.toThrow(/SPEND_LOCK_TIMEOUT/);
  });

  it("concurrent reservations never exceed the cap", async () => {
    const ledger = createSpendLedger({ dir: tmp(), caps: { runUsd: 10, dayUsd: 10, liveUsd: 0.1 } });
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => ledger.reserve({ runId: `run_${i}`, usdMicros: usdToMicros(0.01), model: "m", live: true })));
    expect(rs.filter((r) => r.ok).length).toBe(10);
  });
});

describe("the per-run cap keys a run by its world (run ids restart with every rebuilt world)", () => {
  const caps = { runUsd: 0.1, dayUsd: 2, liveUsd: 0.5 };

  it("a new world's run_0001 gets its own run cap; the day and live caps stay cumulative", async () => {
    const dir = tmp();
    let world = "wld_aaaaaaaaaaaaaaaa";
    const ledger = createSpendLedger({ dir, caps, world: () => world, wallNow: () => new Date("2026-10-18T20:00:00Z") });
    const a = await ledger.reserve({ runId: "run_0001", usdMicros: 80_000, model: "gpt-5.6-luna", live: true });
    if (!a.ok) throw new Error("expected ok");
    await ledger.settle(a.reservationId, 80_000);
    // The same run in the same world is still capped: $0.08 spent, $0.03 more would cross $0.10.
    expect(await ledger.reserve({ runId: "run_0001", usdMicros: 30_000, model: "gpt-5.6-luna", live: true })).toMatchObject({ ok: false, cap: "run", spentMicros: 80_000 });
    // The world is rebuilt (a reset, the next eval trial): run_0001 is another run now.
    world = "wld_bbbbbbbbbbbbbbbb";
    expect(await ledger.spent({ runId: "run_0001" })).toBe(0);
    const b = await ledger.reserve({ runId: "run_0001", usdMicros: 30_000, model: "gpt-5.6-luna", live: true });
    if (!b.ok) throw new Error(`expected ok, got the ${b.cap} cap`);
    await ledger.settle(b.reservationId, 30_000);
    expect(await ledger.spent({ live: true })).toBe(110_000);
    expect(await ledger.spent({ day: "2026-10-18" })).toBe(110_000);
    // Each line records its world; settle copies it from the reservation.
    const lines = ledger.entries();
    expect(lines.map((e) => [e.kind, e.world])).toEqual([
      ["reserve", "wld_aaaaaaaaaaaaaaaa"], ["settle", "wld_aaaaaaaaaaaaaaaa"], ["reserve", "wld_bbbbbbbbbbbbbbbb"], ["settle", "wld_bbbbbbbbbbbbbbbb"],
    ]);
    // Back in the first world (an API restart on the same world), the first run still counts what it spent.
    world = "wld_aaaaaaaaaaaaaaaa";
    expect(await ledger.committed({ runId: "run_0001" })).toEqual({ settledMicros: 80_000, openMicros: 0 });
  });

  it("the live cap still binds across worlds", async () => {
    let n = 0;
    const ledger = createSpendLedger({ dir: tmp(), caps: { runUsd: 0.4, dayUsd: 2, liveUsd: 0.5 }, world: () => `wld_${String(++n).padStart(16, "0")}` });
    expect((await ledger.reserve({ runId: "run_0001", usdMicros: 300_000, model: "m", live: true })).ok).toBe(true);
    expect(await ledger.reserve({ runId: "run_0001", usdMicros: 300_000, model: "m", live: true })).toMatchObject({ ok: false, cap: "live" });
  });

  it("without a world, or when the world is unknown, run ids alone key the cap as before", async () => {
    for (const world of [undefined, () => null]) {
      const ledger = createSpendLedger({ dir: tmp(), caps, ...(world ? { world } : {}) });
      const a = await ledger.reserve({ runId: "run_0001", usdMicros: 80_000, model: "m", live: true });
      if (!a.ok) throw new Error("expected ok");
      expect(await ledger.reserve({ runId: "run_0001", usdMicros: 30_000, model: "m", live: true })).toMatchObject({ ok: false, cap: "run" });
      expect(ledger.entries()[0]).not.toHaveProperty("world");
    }
  });
});

describe("prices per provider (wave 2)", () => {
  it("prices Claude Opus 5.5 at $4, $0.20 and $20 per million, local models at zero, and WEFT_PRICES_JSON still overrides", async () => {
    const { pricesFor, CLAUDE_OPUS_5_5 } = await import("../src/index");
    expect(pricesFor("openai", {})).toEqual(LUNA);
    expect(pricesFor("claude", {})).toEqual({ inPerM: 4, cachedPerM: 0.2, outPerM: 20, cacheWritePerM: 5 });
    expect(pricesFor("openai_compat", {})).toEqual({ inPerM: 0, cachedPerM: 0, outPerM: 0 });
    // 3,000 input (2,000 cached) and 200 output tokens on Claude: 1,000 * 4 + 2,000 * 0.2 + 200 * 20 = 8,400 micro dollars.
    expect(usdToMicros(stepCostUsd({ input: 3000, cached: 2000, cacheWrite: 0, output: 200, reasoning: 0 }, CLAUDE_OPUS_5_5))).toBe(8400);
    expect(pricesFor("claude", { WEFT_PRICES_JSON: JSON.stringify({ outPerM: 15 }) })).toEqual({ inPerM: 4, cachedPerM: 0.2, outPerM: 15, cacheWritePerM: 5 });
    // 1,000 cache-write tokens inside 3,000 input (2,000 cached): writes at $5, not the $4 input rate.
    expect(usdToMicros(stepCostUsd({ input: 3000, cached: 2000, cacheWrite: 1000, output: 200, reasoning: 0 }, CLAUDE_OPUS_5_5))).toBe(9400);
  });
});
