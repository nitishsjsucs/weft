// The spend ledger keys a run by (world, run id). Run ids restart at run_0001 after POST /v1/sim/reset (and in every eval
// trial world), while <dataDir>/spend is never reset, so before this the per-run cap summed the first run of every
// world: after enough resets run_0001 started "Stopped by the run spend cap". An API restart on the same world keeps
// its id, so a run that resumes after a restart still counts what it spent. The day and live caps stay cumulative.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpendLedger } from "@weft/contracts";
import { seedWorld } from "@weft/seed";
import { createWeft, type Weft } from "../src/compose";
import { worldId, worldIdFile } from "../src/world-id";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "weft-spend-world-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
beforeEach(() => {
  vi.stubEnv("WEFT_RUN_USD_CAP", "0.10");
  vi.stubEnv("WEFT_DAY_USD_CAP", "2.00");
  vi.stubEnv("WEFT_LIVE_USD_CAP", "0.50");
});
afterEach(() => { vi.unstubAllEnvs(); });

const spend = async (ledger: SpendLedger, usd: number) => {
  const r = await ledger.reserve({ runId: "run_0001", usdMicros: Math.round(usd * 1e6), model: "gpt-5.6-luna", live: true });
  if (r.ok) await ledger.settle(r.reservationId, Math.round(usd * 1e6));
  return r;
};

describe("the per-run spend cap across rebuilt worlds", () => {
  it("POST /v1/sim/reset starts a new world, so run_0001 gets its own cap; a restart keeps the world", async () => {
    const dataDir = tmp();
    let weft: Weft = await createWeft({ dataDir, testMode: true });
    try {
      await seedWorld(weft);
      const headers = { "x-weft-principal": "usr_dana", "x-weft-proxy": weft.proxySecret, "content-type": "application/json" };
      expect((await spend(weft.ledger, 0.08)).ok).toBe(true);
      const first = readFileSync(worldIdFile(dataDir), "utf8").trim();
      expect(first).toMatch(/^wld_[0-9a-f]{16}$/);
      // Same world: $0.08 spent, $0.03 more would cross the $0.10 run cap.
      expect(await spend(weft.ledger, 0.03)).toMatchObject({ ok: false, cap: "run", spentMicros: 80_000 });

      const res = await weft.app.request("/v1/sim/reset", { method: "POST", headers, body: "{}" });
      expect(res.status, await res.clone().text()).toBe(200);
      expect((await spend(weft.ledger, 0.03)).ok).toBe(true);
      const second = readFileSync(worldIdFile(dataDir), "utf8").trim();
      expect(second).not.toBe(first);
      expect(await weft.ledger.spent({ runId: "run_0001" })).toBe(30_000);
      // Never reset: the live total holds both worlds.
      expect(await weft.ledger.spent({ live: true })).toBe(110_000);

      // An API restart on the same data dir is the same world: run_0001 still has $0.03 against it.
      await weft.close();
      weft = await createWeft({ dataDir, testMode: true });
      expect(worldId(dataDir)).toBe(second);
      expect(await weft.ledger.spent({ runId: "run_0001" })).toBe(30_000);
      expect(await spend(weft.ledger, 0.08)).toMatchObject({ ok: false, cap: "run", spentMicros: 30_000 });
    } finally {
      await weft.close();
    }
  });

  it("the world id is minted once, a removed file starts a new world, and a file that holds no id is replaced", () => {
    const dataDir = tmp();
    const ids = Array.from({ length: 5 }, () => worldId(dataDir));
    expect(new Set(ids).size).toBe(1);
    rmSync(worldIdFile(dataDir));
    const next = worldId(dataDir);
    expect(next).not.toBe(ids[0]);
    writeFileSync(worldIdFile(dataDir), "not an id\n");
    const replaced = worldId(dataDir);
    expect(replaced).toMatch(/^wld_[0-9a-f]{16}$/);
    expect(worldId(dataDir)).toBe(replaced);
  });
});
