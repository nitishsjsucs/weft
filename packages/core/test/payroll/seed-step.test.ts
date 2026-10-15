// The seed step (packages/seed/src/payroll.ts) over the local fixture world, until T2's people seed lands at merge 1.
// After merge 1, tests/scenarios/s2-pre-payroll.test.ts asserts the same 4/44 split on the real seed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { NotImplemented, type Simulators } from "@weft/contracts";
import { paychecks, payrollRuns, type Db } from "@weft/db";
import { seedPayroll } from "../../../seed/src/payroll";
import { buildFixtureWorld, openTempDb, type FixtureIds } from "./fixture-world";

const stubSims = { bank: { submitBatch: async () => { throw new NotImplemented("bank"); }, tick: async () => { throw new NotImplemented("bank"); } } } as unknown as Simulators;

let t: { db: Db; close(): Promise<void> };
let ids: FixtureIds;
beforeAll(async () => {
  t = await openTempDb();
  ids = await buildFixtureWorld(t.db);
  await seedPayroll({ db: t.db, sims: stubSims, companyId: "cmp_larkspur" } as never);
});
afterAll(async () => { await t.close(); });

describe("seed step payroll", () => {
  it("builds 3 processed runs and the 48-paycheck draft with 4 Needs Review and 44 Ready", async () => {
    const runs = await t.db.select().from(payrollRuns).orderBy(payrollRuns.id);
    expect(runs.map((r) => [r.id, r.status])).toEqual([["pay_2026_09_15", "processed"], ["pay_2026_09_30", "processed"], ["pay_2026_10_15", "processed"], ["pay_2026_10_30", "draft"]]);
    expect(runs[0]!.bankBatchId).toBe("simb_seed_2026_09_15");
    const rows = await t.db.select().from(paychecks).where(eq(paychecks.payrollRunId, "pay_2026_10_30"));
    expect(rows).toHaveLength(48);
    expect(rows.filter((p) => p.reviewGroup === "needs_review").map((p) => p.workerId).sort()).toEqual([ids.nyRaise, ids.txSpike, ids.caOct19, ids.nyOffboard].sort());
    expect(rows.filter((p) => p.reviewGroup === "ready")).toHaveLength(44);
  });
  it("is a no-op on a world without the pay schedule (scaffold seed before merge 1)", async () => {
    const e = await openTempDb();
    try {
      await seedPayroll({ db: e.db, sims: stubSims, companyId: "cmp_larkspur" } as never);
      expect(await e.db.select().from(payrollRuns)).toEqual([]);
    } finally { await e.close(); }
  });
});
