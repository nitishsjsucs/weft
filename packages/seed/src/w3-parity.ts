// Seed step w3_parity (wave 3, docs/wave3.md). Owner: w3-parity-routines. Deterministic.
// Never change wave 1 or wave 2 seed counts (SPEC 5.2 numbers are asserted by tests) and never touch processed runs.
//
// The default step adds only data that no wave 1 or wave 2 number reads: synthetic birthdays (MM-DD, never a year)
// for about half the people, and the contractors' tax forms on file. The three anomaly cases are a separate helper, plantParityAnomalyCases(), because each
// case changes pay data and the open draft pay_2026_10_30 must keep its GP2 flags: the helper dates every case inside
// the Nov 1 to 15 period, so only a new draft for that period shows them (tests/scenarios/gp16-anomalies.test.ts).
import { and, asc, eq } from "drizzle-orm";
import { idMinter } from "@weft/core";
import { contractorTaxForms, onboardingSubmissions, paychecks, payrollRuns, payRates, workers, type Db } from "@weft/db";
import type { SeedContext } from "./context";
import { seedWorkerId } from "./people";

/**
 * Tax forms on file for the three contractors abroad (wave 3 rank 15). Ines and Arjun signed a W-8BEN before they
 * started (in effect through 2028-12-31). Claire has none: she moved her work to her own company, so the W-8BEN she
 * signed as a person was superseded and the W-8BEN-E for the company is still to come.
 */
export const CONTRACTOR_FORMS = [
  { key: "ines", form: "w8ben", signedOn: "2025-05-26", status: "active" },
  { key: "arjun", form: "w8ben", signedOn: "2025-07-28", status: "active" },
  { key: "claire", form: "w8ben", signedOn: "2025-09-08", status: "superseded" },
] as const;

/** Every other active person, by employee id order, gets a synthetic month and day (opt-in for milestones). */
export async function seedW3Parity(ctx: SeedContext): Promise<void> {
  const rows = await ctx.db.select({ id: workers.id, status: workers.status }).from(workers).where(eq(workers.companyId, ctx.companyId)).orderBy(asc(workers.id));
  let i = 0;
  for (const w of rows) {
    if (w.status !== "active") continue;
    if (i++ % 2 !== 0) continue;
    const n = Number(w.id.replace(/\D/g, "")) || i;
    // Deterministic month and day spread over the year; day 1 to 28 so every month is valid.
    const month = ((n * 7) % 12) + 1;
    const day = ((n * 11) % 28) + 1;
    await ctx.db.update(workers).set({ birthMonthDay: `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` }).where(eq(workers.id, w.id));
  }
  const newId = idMinter(ctx.db);
  for (const f of CONTRACTOR_FORMS) {
    await ctx.db.insert(contractorTaxForms).values({
      id: await newId("ctf_"), workerId: seedWorkerId(f.key), form: f.form, signedOn: f.signedOn, expiresOn: `${Number(f.signedOn.slice(0, 4)) + 3}-12-31`,
      documentId: null, status: f.status, createdAt: `${f.signedOn}T17:00:00.000Z`,
    });
  }
}

/** The three planted workers: A misses a raise, B changes withholding, C was paid a bonus that a new run repeats. */
export const PARITY_CASES = {
  raise: { workerId: "wrk_0010", effectiveFrom: "2026-11-01" },
  withholding: { workerId: "wrk_0011", submittedAt: "2026-11-02T17:00:00.000Z" },
  bonus: { workerId: "wrk_0012", amountCents: 250_000, payday: "2026-11-06" },
} as const;

/**
 * Plants one case per wave 3 anomaly rule, all inside the Nov 1 to 15 period:
 * - RAISE_NOT_APPLIED: a 6% raise for A effective Nov 1 whose end date was keyed as its first day, so compute falls
 *   back to the old rate for the Nov 1 to 15 draft.
 * - WITHHOLDING_CHANGED: a new federal W-4 for B submitted Nov 2 (masked fields only; the tax profile is unchanged).
 * - DUPLICATE_SUPPLEMENTAL: a processed off-cycle bonus for C (payday Nov 6); an off-cycle that repeats it is blocked.
 * Returns the ids it wrote. Test and demo worlds only; the default seed does not call it.
 */
export async function plantParityAnomalyCases(db: Db, companyId = "cmp_larkspur"): Promise<{ payRateId: string; submissionId: string; bonusRunId: string }> {
  const newId = idMinter(db);
  const rate = (await db.select().from(payRates).where(eq(payRates.workerId, PARITY_CASES.raise.workerId)).orderBy(asc(payRates.effectiveFrom))).at(-1);
  if (!rate) throw new Error(`plantParityAnomalyCases: ${PARITY_CASES.raise.workerId} has no pay rate`);
  const payRateId = await newId("prt_");
  await db.insert(payRates).values({
    id: payRateId, workerId: PARITY_CASES.raise.workerId, kind: rate.kind, amountCents: Math.round(rate.amountCents * 1.06), currency: rate.currency,
    effectiveFrom: PARITY_CASES.raise.effectiveFrom, effectiveTo: PARITY_CASES.raise.effectiveFrom, createdActionSeq: null,
  });

  const submissionId = await newId("obs_");
  await db.insert(onboardingSubmissions).values({
    id: submissionId, workerId: PARITY_CASES.withholding.workerId, kind: "federal_w4",
    maskedJson: JSON.stringify({ filingStatus: "single", step2Checkbox: false, step3Cents: 0, step4aCents: 0, step4bCents: 0, step4cCents: 5_000, exempt: false, synthetic: true }),
    documentId: null, submittedAt: PARITY_CASES.withholding.submittedAt, actionSeq: null,
  });

  const [c] = await db.select().from(workers).where(and(eq(workers.id, PARITY_CASES.bonus.workerId), eq(workers.companyId, companyId)));
  if (!c) throw new Error(`plantParityAnomalyCases: no worker ${PARITY_CASES.bonus.workerId}`);
  const bonusRunId = `pay_${PARITY_CASES.bonus.payday.replace(/-/g, "_")}_oc_seed`;
  const at = "2026-11-06T17:00:00.000Z";
  await db.insert(payrollRuns).values({
    id: bonusRunId, companyId, payScheduleId: c.payScheduleId ?? "ps_us_semimonthly", type: "us", subtype: "off_cycle", status: "processed",
    periodStart: "2026-11-01", periodEnd: "2026-11-15", payday: PARITY_CASES.bonus.payday, approvalDeadline: "2026-11-04T13:00:00.000Z", fundingMethod: "ach",
    totalsJson: null, anomalySummaryJson: null, subjectHash: null, taxDataVersion: "2026.1", previousRunId: null, excludedWorkerIdsJson: "[]",
    approvedBy: "usr_theo", approvedAt: at, processedAt: at, createdAt: at, updatedAt: at,
  });
  await db.insert(paychecks).values({
    id: await newId("pyc_"), payrollRunId: bonusRunId, workerId: c.id, status: "processed", reviewGroup: "ready", hoursX100: null,
    grossCents: PARITY_CASES.bonus.amountCents, netCents: Math.round(PARITY_CASES.bonus.amountCents * 0.6),
    earningsJson: JSON.stringify([{ type: "bonus", amountCents: PARITY_CASES.bonus.amountCents, hoursX100: null }]),
    deductionsJson: "[]", benefitsJson: "[]", taxesJson: "[]", flagsJson: "[]",
  });
  return { payRateId, submissionId, bonusRunId };
}
