// The seed profiles: base is exactly seedWorld() (its digest is what tests, e2e and the eval worlds pin), rich is a
// deterministic layer on top whose action chain still verifies.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closeDb, migrate, openDb, type Db } from "@weft/db";
import { commands, createSimClock } from "@weft/core";
import { createExecutor } from "@weft/executor";
import { createSimulators } from "@weft/sim";
import { digestDb, SEED_CLOCK, seedWorld } from "../src/index";
import { parseSeedProfile, seedWorldProfile, type SeedProfile } from "../src/profile";

async function seeded<T>(profile: SeedProfile | "world", read: (db: Db, verify: () => Promise<{ ok: boolean; gitLag: number }>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "weft-profile-"));
  const db = openDb({ dataDir: dir });
  try {
    await migrate(db);
    const clock = await createSimClock({ db, initial: { at: SEED_CLOCK, rate: 0 } });
    const executor = await createExecutor({ db, clock, dataDir: dir, commands, simulators: createSimulators, testMode: true });
    try {
      const target = { db, clock, executor, sims: createSimulators({ db, clock }), dataDir: dir };
      if (profile === "world") await seedWorld(target); else await seedWorldProfile(target, profile);
      expect(clock.now()).toBe(SEED_CLOCK);
      return await read(db, () => executor.verifyChain());
    } finally { await executor.close(); }
  } finally { await closeDb(db); rmSync(dir, { recursive: true, force: true }); }
}
/** The planted rows the rich layer must leave alone: the four Weft pay runs and their paychecks, YTD, the base
 * expenses, time-off requests and ledger, offers, notices, filings, compliance items and the first action. */
async function planted(db: Db): Promise<string> {
  const q = (s: string) => db.all<Record<string, unknown>>(sql.raw(s));
  return JSON.stringify({
    runs: await q(`SELECT * FROM payroll_runs WHERE tax_data_version != 'imported' ORDER BY id`),
    checks: await q(`SELECT p.* FROM paychecks p JOIN payroll_runs r ON r.id = p.payroll_run_id WHERE r.tax_data_version != 'imported' ORDER BY p.id`),
    ytd: await q(`SELECT * FROM ytd_ledger ORDER BY worker_id, year, code, source`),
    expenses: await q(`SELECT * FROM expenses WHERE id <= 'exp_0014' ORDER BY id`),
    requests: await q(`SELECT * FROM time_off_requests WHERE id <= 'tor_0006' ORDER BY id`),
    ledger: await q(`SELECT * FROM time_off_ledger WHERE id <= 'tol_0138' ORDER BY id`),
    offers: await q(`SELECT * FROM offers WHERE id = 'offr_0001'`),
    notices: await q(`SELECT * FROM notices WHERE id = 'ntc_0001'`),
    filings: await q(`SELECT * FROM filings WHERE id <= 'fil_0013' ORDER BY id`),
    items: await q(`SELECT * FROM compliance_items WHERE id <= 'cal_0052' ORDER BY id`),
    action1: await q(`SELECT * FROM actions WHERE seq = 1`),
    workers: await q(`SELECT * FROM workers WHERE id <= 'wrk_0051' ORDER BY id`),
    recon: await q(`SELECT * FROM benefit_recon_findings WHERE month = '2026-10'`),
  });
}
const count = async (db: Db, table: string) => (await db.all<{ n: number }>(sql.raw(`SELECT COUNT(*) AS n FROM "${table}"`)))[0]!.n;

describe("seed profiles", () => {
  it("parses the profile name and defaults to base", () => {
    expect(parseSeedProfile(undefined)).toBe("base");
    expect(parseSeedProfile("rich")).toBe("rich");
    expect(() => parseSeedProfile("huge")).toThrow(/base, rich/);
  });

  it("base is exactly seedWorld()", async () => {
    expect(await seeded("base", (db) => digestDb(db))).toBe(await seeded("world", (db) => digestDb(db)));
  }, 60_000);

  it("rich is deterministic, fills history and keeps the action chain valid", async () => {
    const a = await seeded("rich", async (db, verify) => {
      const chain = await verify();
      expect(chain.ok).toBe(true);
      expect(chain.gitLag).toBe(0);
      expect(await count(db, "agent_runs")).toBeGreaterThanOrEqual(20);
      expect(await count(db, "actions")).toBeGreaterThanOrEqual(100);
      expect(await count(db, "routine_runs")).toBeGreaterThanOrEqual(15);
      expect(await count(db, "time_off_requests")).toBeGreaterThanOrEqual(120);
      expect(await count(db, "offboarding_cases")).toBe(2);
      expect(await count(db, "contractor_payments")).toBeGreaterThanOrEqual(40);
      expect(await count(db, "payroll_runs")).toBe(20);
      expect((await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM time_off_requests WHERE status = 'pending'`))[0]!.n).toBe(3);
      expect((await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM expenses WHERE status = 'needs_review'`))[0]!.n).toBe(8);
      // The imported pay history adds up to the imported year-to-date gross, worker by worker.
      const off = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM ytd_ledger y WHERE y.code = 'gross' AND y.source = 'import' AND y.amount_cents !=
        (SELECT COALESCE(SUM(p.gross_cents), 0) FROM paychecks p JOIN payroll_runs r ON r.id = p.payroll_run_id WHERE r.tax_data_version = 'imported' AND p.worker_id = y.worker_id)`);
      expect(off[0]!.n).toBe(0);
      return { digest: await digestDb(db), planted: await planted(db) };
    });
    // Planted rows stay exactly as the base seed wrote them.
    expect(a.planted).toBe(await seeded("base", (db) => planted(db)));
    expect(await seeded("rich", (db) => digestDb(db))).toBe(a.digest);
  }, 120_000);
});
