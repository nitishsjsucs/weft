// Carrier invoice simulator (w2-benefits-contractors): deterministic lines, the planted tier errors, storage and the fault target.
import { afterEach, describe, expect, it } from "vitest";
import { benefitEnrollments, benefitPlans, companies, simCarrierInvoices, workers } from "@weft/db";
import { createSimulators } from "../src/index";
import { buildCarrierLines, CARRIER_NAME, monthPeriods } from "../src/carrier";
import { simWorld, type SimTestWorld } from "./helpers";

let w: SimTestWorld | null = null;
afterEach(async () => { await w?.close(); w = null; });

const PPO = { ee: 9_500, ee_spouse: 21_000, ee_children: 18_500, family: 31_000, employer: 38_000 };
async function fixture(db: SimTestWorld["db"]) {
  const at = "2026-10-01T00:00:00.000Z";
  await db.insert(companies).values({ id: "cmp_larkspur", legalName: "Larkspur Robotics, Inc.", domain: "larkspur.example", ein: "00-0000000", hqState: "CA", foundedOn: "2020-01-01", createdAt: at });
  const person = (n: number, endDate: string | null = null) => ({
    id: `wrk_000${n}`, companyId: "cmp_larkspur", employeeNumber: `EMP-000${n}`, type: "employee", workerType: "us_w2", status: "active", firstName: `P${n}`, lastName: "Demo",
    workEmail: `p${n}@larkspur.example`, title: "Engineer", timezone: "America/Los_Angeles", startDate: "2024-01-01", endDate, createdAt: at, updatedAt: at,
  });
  await db.insert(workers).values([person(1), person(2), person(3, "2026-10-23"), person(4)]);
  await db.insert(benefitPlans).values([
    { id: "bpl_0001", companyId: "cmp_larkspur", carrier: CARRIER_NAME, category: "health", type: "medical", name: "PPO", pretaxCode: "section125_medical", pricesJson: JSON.stringify(PPO), matchJson: null },
    { id: "bpl_0002", companyId: "cmp_larkspur", carrier: CARRIER_NAME, category: "health_savings", type: "hsa", name: "HSA", pretaxCode: "hsa_cafeteria", pricesJson: "{}", matchJson: null },
  ]);
  const enr = (id: number, workerId: string, planId: string, tier: string | null) => ({ id: `ben_000${id}`, workerId, planId, tier, employeeCents: null, deferralBps: null, status: "active", effectiveFrom: "2026-01-01", effectiveTo: null });
  await db.insert(benefitEnrollments).values([enr(1, "wrk_0001", "bpl_0001", "ee"), enr(2, "wrk_0002", "bpl_0001", "family"), enr(3, "wrk_0003", "bpl_0001", "ee"), enr(4, "wrk_0004", "bpl_0001", "family"), enr(5, "wrk_0001", "bpl_0002", null)]);
}

describe("carrier invoice simulator", () => {
  it("bills two semi-monthly periods per enrollment and plants the family and ee tier errors once each", async () => {
    w = await simWorld();
    await fixture(w.db);
    const lines = await buildCarrierLines(w.db, "2026-10");
    expect(lines.map((l) => [l.workerId, l.tier, l.amountCents])).toEqual([
      ["wrk_0001", "family", 62_000],   // single coverage with no dependent on file billed at family
      ["wrk_0002", "ee", 19_000],       // family enrollment billed at ee
      ["wrk_0003", "ee", 19_000],       // last day 2026-10-23, still billed in full
      ["wrk_0004", "family", 62_000],   // second family enrollment billed correctly
    ]);
    expect(monthPeriods("2026-02")).toEqual([{ start: "2026-02-01", end: "2026-02-15" }, { start: "2026-02-16", end: "2026-02-28" }]);
  });

  it("stores the invoice once and returns the same invoice on later calls", async () => {
    w = await simWorld();
    await fixture(w.db);
    const sims = createSimulators({ db: w.db, clock: w.clock });
    const a = await sims.carrier.invoice("2026-10");
    const b = await sims.carrier.invoice("2026-10");
    expect(b).toEqual(a);
    expect(a).toMatchObject({ month: "2026-10", carrier: CARRIER_NAME, totalCents: 162_000 });
    expect(await w.db.select().from(simCarrierInvoices)).toHaveLength(1);
  });

  it("honors the carrier.invoice fault target", async () => {
    w = await simWorld();
    await fixture(w.db);
    const sims = createSimulators({ db: w.db, clock: w.clock });
    await sims.faults.arm({ target: "carrier.invoice", kind: "error", mode: "once" });
    await expect(sims.carrier.invoice("2026-10")).rejects.toThrow(/carrier.invoice/);
    await expect(sims.carrier.invoice("2026-10")).resolves.toMatchObject({ month: "2026-10" });
  });
});
