// A local stand-in for T2's people, benefits and tax seed (SPEC 5.2 to 5.4), used until merge 1. Same counts and the
// same 4 planted anomalies: 22 CA (2 Oct 1 hires, 1 Oct 19 hire without a bank account, 1 pre-2020 W-4), 14 NY
// (an 18% raise effective Oct 16 recorded as an action, an offboarder ending Oct 23), 12 TX (6 salaried, 6 hourly;
// one tech at 120 h in the Oct 16 to 31 draft). Every name is visibly fictional.
import { mkdtempSync, rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actions, bankAccounts, benefitEnrollments, benefitPlans, closeDb, companies, employerTaxRates, migrate, openDb, payRates, paySchedules,
  taxAccounts, taxProfiles, timeEntries, workers, type Db,
} from "@weft/db";
import type { BankSim, SimEvent } from "@weft/contracts";

export const CO = "cmp_larkspur";
export const PS = "ps_us_semimonthly";
export const TS = "2026-10-26T15:30:00.000Z";
export const PERIODS = [["2026-09-01", "2026-09-15"], ["2026-09-16", "2026-09-30"], ["2026-10-01", "2026-10-15"], ["2026-10-16", "2026-10-31"]] as const;

export interface FixtureIds { nyRaise: string; nyRaiseRate: string; txSpike: string; caOct19: string; nyOffboard: string; caOct1: string[]; all: string[] }

export async function openTempDb(): Promise<{ db: Db; close(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "weft-t1-"));
  const db = openDb({ dataDir: dir });
  await migrate(db);
  return { db, async close() { await closeDb(db); rmSync(dir, { recursive: true, force: true }); } };
}

export async function buildFixtureWorld(db: Db): Promise<FixtureIds> {
  await db.insert(companies).values({ id: CO, legalName: "Larkspur Robotics, Inc.", domain: "larkspur.example", ein: "00-4817265", hqState: "CA", foundedOn: "2023-03-01", createdAt: TS });
  await db.insert(paySchedules).values({ id: PS, companyId: CO, name: "US semi-monthly", frequency: "semimonthly", region: "us", autopay: false });
  await db.insert(taxAccounts).values([
    { id: "txa_0001", companyId: CO, jurisdiction: "US", agency: "irs", accountType: "federal", accountNumber: "00-4817265", status: "active" },
    { id: "txa_0002", companyId: CO, jurisdiction: "CA", agency: "ca_edd", accountType: "combined", accountNumber: "000-4817-2", status: "active" },
    { id: "txa_0003", companyId: CO, jurisdiction: "NY", agency: "ny_dtf", accountType: "withholding", accountNumber: "004817265", status: "active" },
    { id: "txa_0004", companyId: CO, jurisdiction: "NY", agency: "ny_dol", accountType: "unemployment", accountNumber: "00-48172 6", status: "active" },
    { id: "txa_0005", companyId: CO, jurisdiction: "TX", agency: "tx_twc", accountType: "unemployment", accountNumber: "00-481726-5", status: "active" },
    { id: "txa_0006", companyId: CO, jurisdiction: "CO", agency: "co_dor", accountType: "withholding", status: "not_registered" },
    { id: "txa_0007", companyId: CO, jurisdiction: "CO", agency: "co_cdle", accountType: "unemployment", status: "not_registered" },
  ]);
  const rate = (id: string, jurisdiction: string, code: string, r: string, base: number) => ({ id, companyId: CO, jurisdiction, code, rate: r, wageBaseCents: base, effectiveFrom: "2026-01-01", source: "seed" });
  await db.insert(employerTaxRates).values([rate("etr_0001", "CA", "sui", "0.034", 700000), rate("etr_0002", "CA", "ett", "0.001", 700000), rate("etr_0003", "NY", "sui", "0.041", 1760000), rate("etr_0004", "TX", "sui", "0.027", 900000)]);
  await db.insert(benefitPlans).values([
    { id: "bpl_0001", companyId: CO, carrier: "Juniper Mutual", category: "health", type: "medical", name: "Juniper PPO 1500", pretaxCode: "section125_medical", pricesJson: JSON.stringify({ ee: 9500, ee_spouse: 21000, ee_children: 18500, family: 31000 }), matchJson: JSON.stringify({ employer_cents: 38000 }) },
    { id: "bpl_0002", companyId: CO, carrier: "Juniper Mutual", category: "health", type: "dental", name: "Juniper Dental Plus", pretaxCode: "section125_medical", pricesJson: JSON.stringify({ ee: 800, ee_spouse: 1800, ee_children: 1600, family: 2800 }), matchJson: JSON.stringify({ employer_cents: 2400 }) },
    { id: "bpl_0003", companyId: CO, carrier: "Tidewater Retirement", category: "retirement", type: "401k", name: "Tidewater 401(k)", pretaxCode: "401k_traditional", pricesJson: "{}", matchJson: JSON.stringify({ match_bps: 10000, cap_bps: 400 }) },
  ]);

  const ids: FixtureIds = { nyRaise: "", nyRaiseRate: "prt_0049", txSpike: "", caOct19: "", nyOffboard: "", caOct1: [], all: [] };
  let n = 0;
  const add = async (w: { state: "CA" | "NY" | "TX"; start: string; end?: string; status?: string; kind: "salary" | "hourly"; amount: number; pre2020?: boolean; bank?: boolean; benefits?: boolean }) => {
    n++;
    const id = `wrk_${String(n).padStart(4, "0")}`;
    ids.all.push(id);
    await db.insert(workers).values({
      id, companyId: CO, employeeNumber: `EMP-${String(n).padStart(4, "0")}`, type: "employee", workerType: "us_w2", status: w.status ?? "active",
      firstName: `Person${n}`, lastName: "Example", workEmail: `person${n}@larkspur.example`, title: "Engineer", workState: w.state,
      timezone: "America/Los_Angeles", startDate: w.start, endDate: w.end ?? null, payScheduleId: PS, createdAt: TS, updatedAt: TS,
    });
    await db.insert(payRates).values({ id: `prt_${String(n).padStart(4, "0")}`, workerId: id, kind: w.kind, amountCents: w.amount, effectiveFrom: w.start });
    await db.insert(taxProfiles).values({
      workerId: id, w4Version: w.pre2020 ? "pre2020" : "2020", filingStatus: w.pre2020 ? "mfj" : n % 3 === 0 ? "mfj" : "single", allowances: w.pre2020 ? 3 : 0,
      step2Checkbox: n === 7, step3Cents: n % 8 === 0 ? 220000 : 0, stateFilingStatus: w.state === "TX" ? null : n % 3 === 0 ? "married" : "single", stateAllowances: 1, source: "seed",
    });
    if (w.bank ?? true) await db.insert(bankAccounts).values({ id: `bnk_${String(n).padStart(4, "0")}`, workerId: id, bankName: "Tidepool Federal Credit Union", accountLast4: String(1000 + n), routingLast4: "0021", credentialRef: `vault:bank-${id}`, status: "active", source: "seed" });
    if (w.benefits ?? n % 2 === 0) {
      await db.insert(benefitEnrollments).values([
        { id: `ben_${String(n * 3).padStart(4, "0")}`, workerId: id, planId: "bpl_0001", tier: "ee", status: "active", effectiveFrom: w.start },
        { id: `ben_${String(n * 3 + 1).padStart(4, "0")}`, workerId: id, planId: "bpl_0002", tier: "ee", status: "active", effectiveFrom: w.start },
      ]);
    }
    if (n % 3 === 1) await db.insert(benefitEnrollments).values({ id: `ben_${String(n * 3 + 2).padStart(4, "0")}`, workerId: id, planId: "bpl_0003", deferralBps: 500, status: "active", effectiveFrom: w.start });
    return id;
  };
  const salary = (i: number) => 6_200_000 + ((i * 3_700_000) % 18_300_000);   // $62,000 to $245,000

  // CA: 19 steady, 2 Oct 1 hires, 1 Oct 19 hire with no bank account. One pre-2020 W-4.
  for (let i = 0; i < 19; i++) await add({ state: "CA", start: `2024-0${(i % 9) + 1}-1${i % 10}`, kind: "salary", amount: i === 0 ? 24_500_000 : salary(i), pre2020: i === 3 });
  ids.caOct1.push(await add({ state: "CA", start: "2026-10-01", kind: "salary", amount: 9_600_000 }));
  ids.caOct1.push(await add({ state: "CA", start: "2026-10-01", kind: "salary", amount: 8_800_000 }));
  ids.caOct19 = await add({ state: "CA", start: "2026-10-19", status: "onboarding", kind: "salary", amount: 10_400_000, bank: false, benefits: false });
  // NY: 12 steady, the raise, the offboarder.
  for (let i = 0; i < 12; i++) await add({ state: "NY", start: "2025-02-03", kind: "salary", amount: i === 0 ? 21_000_000 : salary(i + 30) });
  ids.nyRaise = await add({ state: "NY", start: "2025-04-14", kind: "salary", amount: 12_000_000 });
  ids.nyOffboard = await add({ state: "NY", start: "2024-11-04", end: "2026-10-23", status: "offboarding", kind: "salary", amount: 9_800_000 });
  // TX: 6 salaried, 5 steady techs, 1 spike tech.
  for (let i = 0; i < 6; i++) await add({ state: "TX", start: "2025-06-02", kind: "salary", amount: salary(i + 60) });
  const techs: string[] = [];
  for (let i = 0; i < 6; i++) techs.push(await add({ state: "TX", start: "2025-03-10", kind: "hourly", amount: 2800 + i * 160 }));
  ids.txSpike = techs[5]!;
  let t = 0;
  for (const tech of techs) {
    for (const [ps, pe] of PERIODS) {
      const hours = tech === ids.txSpike && ps === "2026-10-16" ? 12000 : 8667;
      await db.insert(timeEntries).values({ id: `tim_${String(++t).padStart(4, "0")}`, workerId: tech, periodStart: ps, periodEnd: pe, regularHoursX100: hours, overtimeHoursX100: 0, source: "seed" });
    }
  }
  // The NY raise: 18% effective 2026-10-16, applied by Vic as an action (seq 1, result id = the new pay rate id).
  await db.insert(actions).values({
    seq: 1, actionId: "act_0001", ts: "2026-10-09T17:00:00.000Z", actorKind: "human", actorId: "usr_dana", command: "people.update_pay_rate",
    argsJson: "{}", argsHash: "x", resultId: ids.nyRaiseRate, summary: "Pay rate change", reversible: "yes", prevHash: "0".repeat(64), hash: "1".repeat(64),
  });
  await db.update(payRates).set({ effectiveTo: "2026-10-15" }).where(eqId(ids.nyRaise));
  await db.insert(payRates).values({ id: ids.nyRaiseRate, workerId: ids.nyRaise, kind: "salary", amountCents: 14_160_000, effectiveFrom: "2026-10-16", createdActionSeq: 1 });
  return ids;
}

const eqId = (workerId: string) => eq(payRates.workerId, workerId);

/**
 * In-memory bank simulator: settles on the first tick at or after settle_at. With `returnFirst` it behaves like the
 * real simulator's `return` fault: the batch is returned (first entry, R03) and never settles.
 */
export function fakeBank(opts: { returnFirst?: boolean } = {}) {
  const batches: { id: string; payrollRunId: string; total: number; entries: { workerId: string; amountCents: number; accountRef: string }[]; settleAt: string; status: string }[] = [];
  const bank: Pick<BankSim, "submitBatch" | "tick"> = {
    async submitBatch(req) {
      // Same input rules as the real bank simulator (packages/sim/src/bank.ts).
      if (typeof req.credential !== "string" || req.credential.length < 8) throw new Error("SIM_AUTH: the sim bank rejected the credential");
      for (const e of req.entries) {
        if (!Number.isInteger(e.amountCents) || e.amountCents < 0) throw new Error(`bank.submitBatch: bad amount for ${e.workerId}`);
        if (!e.accountRef.startsWith("vault:")) throw new Error("bank.submitBatch: account refs must be vault names");
      }
      const id = `simb_${String(batches.length + 1).padStart(4, "0")}`;
      batches.push({ id, payrollRunId: req.payrollRunId, total: req.entries.reduce((s, e) => s + e.amountCents, 0), entries: req.entries, settleAt: req.settleAt, status: "submitted" });
      return { batchId: id, settleAt: req.settleAt };
    },
    async tick(now) {
      const out: SimEvent[] = [];
      for (const b of batches) {
        if (b.status !== "submitted" || b.settleAt > now) continue;
        if (opts.returnFirst) { b.status = "returned"; out.push({ type: "sim.bank_batch_returned" as const, subjectRef: b.id, payload: { batch_id: b.id, payroll_run_id: b.payrollRunId, worker_id: b.entries[0]!.workerId } }); }
        else { b.status = "settled"; out.push({ type: "sim.bank_batch_settled" as const, subjectRef: b.id, payload: { batch_id: b.id, payroll_run_id: b.payrollRunId } }); }
      }
      return out;
    },
  };
  return { bank, batches };
}

