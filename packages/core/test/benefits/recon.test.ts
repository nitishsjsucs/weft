// Reconciliation classifier and payout conversion over a tiny hand-built world (owner: w2-benefits-contractors).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { benefitEnrollments, benefitPlans, closeDb, companies, migrate, openDb, paychecks, payrollRuns, workers, type Db } from "@weft/db";
import { computeFindings, convertToUsdCents, reconPeriods, storeFindings, type ReconInvoice } from "../../src/benefits/queries";
import { newId } from "../../src/shared/ids";

const CARRIER = "Juniper Mutual (sim)";
const PPO = { ee: 9_500, ee_spouse: 21_000, ee_children: 18_500, family: 31_000 };
let db: Db; let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "weft-recon-"));
  db = openDb({ dataDir: dir });
  await migrate(db);
  const at = "2026-10-01T00:00:00.000Z";
  await db.insert(companies).values({ id: "cmp_larkspur", legalName: "Larkspur Robotics, Inc. (demo)", domain: "larkspur.example", ein: "00-0000000", hqState: "CA", foundedOn: "2020-01-01", createdAt: at });
  const person = (n: number, startDate = "2024-01-01", endDate: string | null = null) => ({
    id: `wrk_000${n}`, companyId: "cmp_larkspur", employeeNumber: `EMP-000${n}`, type: "employee", workerType: "us_w2", status: "active", firstName: `P${n}`, lastName: "Demo",
    workEmail: `p${n}@larkspur.example`, title: "Engineer", timezone: "America/Los_Angeles", startDate, endDate, createdAt: at, updatedAt: at,
  });
  await db.insert(workers).values([person(1), person(2), person(3, "2026-10-19"), person(4), person(5, "2024-01-01", "2026-09-30")]);
  await db.insert(benefitPlans).values({ id: "bpl_0001", companyId: "cmp_larkspur", carrier: CARRIER, category: "health", type: "medical", name: "PPO", pretaxCode: "section125_medical", pricesJson: JSON.stringify(PPO), matchJson: null });
  const enr = (id: number, workerId: string, tier: string, from = "2026-01-01", status = "active", to: string | null = null) => ({ id: `ben_000${id}`, workerId, planId: "bpl_0001", tier, employeeCents: null, deferralBps: null, status, effectiveFrom: from, effectiveTo: to });
  await db.insert(benefitEnrollments).values([enr(1, "wrk_0001", "ee"), enr(2, "wrk_0002", "family"), enr(3, "wrk_0003", "ee", "2026-10-19"), enr(4, "wrk_0004", "ee_spouse"), enr(5, "wrk_0005", "ee")]);
  await db.insert(payrollRuns).values([
    { id: "pay_2026_10_15", companyId: "cmp_larkspur", payScheduleId: "ps_x", type: "regular", subtype: "regular", status: "processed", periodStart: "2026-10-01", periodEnd: "2026-10-15", payday: "2026-10-15", approvalDeadline: at, taxDataVersion: "t", createdAt: at, updatedAt: at },
    { id: "pay_2026_10_30", companyId: "cmp_larkspur", payScheduleId: "ps_x", type: "regular", subtype: "regular", status: "draft", periodStart: "2026-10-16", periodEnd: "2026-10-31", payday: "2026-10-30", approvalDeadline: at, taxDataVersion: "t", createdAt: at, updatedAt: at },
  ]);
  const pc = (run: string, workerId: string, cents: number) => ({ id: `pyc_${run.slice(-5)}_${workerId}`, payrollRunId: run, workerId, status: "ok", reviewGroup: "ready", grossCents: 1, netCents: 1, earningsJson: "[]", deductionsJson: "[]", benefitsJson: JSON.stringify([{ planId: "bpl_0001", employeeCents: cents, employerCents: 0 }]), taxesJson: "[]" });
  await db.insert(paychecks).values([pc("pay_2026_10_15", "wrk_0001", 9_500), pc("pay_2026_10_30", "wrk_0001", 9_500), pc("pay_2026_10_30", "wrk_0003", 9_500), pc("pay_2026_10_15", "wrk_0004", 21_000), pc("pay_2026_10_30", "wrk_0004", 21_000)]);
});
afterAll(async () => { await closeDb(db); rmSync(dir, { recursive: true, force: true }); });

const invoice = (lines: ReconInvoice["lines"]): ReconInvoice => ({ month: "2026-10", carrier: CARRIER, lines, totalCents: lines.reduce((s, l) => s + l.amountCents, 0) });

describe("reconciliation classifier", () => {
  it("prorates a mid-month hire, flags a missing line, an unknown line, a mismatch and a worker who left", async () => {
    const out = await computeFindings(db, "cmp_larkspur", invoice([
      { workerId: "wrk_0001", planId: "bpl_0001", amountCents: 19_000, tier: "ee", periods: 2 },        // correct
      { workerId: "wrk_0003", planId: "bpl_0001", amountCents: 9_500, tier: "ee", periods: 1 },         // hired Oct 19: one period, correct
      { workerId: "wrk_0004", planId: "bpl_0001", amountCents: 37_000, tier: "ee_spouse", periods: 2 }, // amount differs from the tier
      { workerId: "wrk_0005", planId: "bpl_0001", amountCents: 19_000, tier: "ee", periods: 2 },        // left Sep 30
      { workerId: "wrk_0009", planId: "bpl_0001", amountCents: 19_000, tier: "ee", periods: 2 },        // nobody on file
    ]));
    expect(out.map((f) => [f.kind, f.workerId, f.billedCents, f.expectedCents, f.deductedCents])).toEqual([
      ["terminated_but_billed", "wrk_0005", 19_000, 0, 0],
      ["billed_not_enrolled", "wrk_0009", 19_000, 0, 0],
      ["enrolled_not_billed", "wrk_0002", 0, 62_000, 0],
      ["amount_mismatch", "wrk_0004", 37_000, 42_000, 42_000],
    ]);
  });

  it("infers the billed tier from the amount when a line has no tier", async () => {
    const out = await computeFindings(db, "cmp_larkspur", invoice([{ workerId: "wrk_0001", planId: "bpl_0001", amountCents: 62_000 }]));
    expect(out.find((f) => f.workerId === "wrk_0001")).toMatchObject({ kind: "missing_dependent", billedCents: 62_000, expectedCents: 19_000, deductedCents: 19_000 });
  });

  it("stores idempotently, refreshes amounts and resolves open findings that no longer apply", async () => {
    const mint = (p: "rcf_") => newId(db, p);
    const first = await computeFindings(db, "cmp_larkspur", invoice([{ workerId: "wrk_0009", planId: "bpl_0001", amountCents: 19_000, tier: "ee" }]));
    const a = await storeFindings(db, "cmp_larkspur", "2026-10", CARRIER, first, "2026-10-26T15:30:00.000Z", mint);
    const b = await storeFindings(db, "cmp_larkspur", "2026-10", CARRIER, first, "2026-10-26T15:30:00.000Z", mint);
    expect([a.created, b.created, b.unchanged]).toEqual([a.rows.length, 0, a.rows.length]);
    expect(b.rows.map((r) => r.id)).toEqual(a.rows.map((r) => r.id));
    const c = await storeFindings(db, "cmp_larkspur", "2026-10", CARRIER, first.filter((f) => f.kind !== "billed_not_enrolled"), "2026-10-26T15:30:00.000Z", mint);
    expect(c.resolved).toBe(1);
  });

  it("splits a month into the two semi-monthly periods and refuses bad months", () => {
    expect(reconPeriods("2026-10")).toEqual([{ start: "2026-10-01", end: "2026-10-15" }, { start: "2026-10-16", end: "2026-10-31" }]);
    expect(() => reconPeriods("2026-13")).toThrow(/YYYY-MM/);
  });
});

describe("payout conversion", () => {
  it("rounds half up to whole USD cents", () => {
    expect(convertToUsdCents(650_000, "1.08")).toBe(702_000);
    expect(convertToUsdCents(41_000_000, "0.012")).toBe(492_000);
    expect(convertToUsdCents(125, "0.012")).toBe(2);   // 1.5
    expect(convertToUsdCents(124, "0.012")).toBe(1);   // 1.488
    expect(() => convertToUsdCents(1.5, "1")).toThrow(/integer/);
  });
});
