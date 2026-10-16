// Pay run lifecycle (SPEC 7.4): draft (refreshed by preview) to processing (approved, bank batch submitted) to
// processed (batch settled, YTD written) or failed. These functions run inside the caller's transaction: the executor's
// for commands, the seed's for history. They never emit events or append actions; commands return those.
import { and, desc, eq, inArray } from "drizzle-orm";
import { Conflict, NotFound, type BankSim, type Flag, type IdPrefix } from "@weft/contracts";
import { bankAccounts, paychecks, payrollRuns, paySchedules, workers, ytdLedger, type DbTx } from "@weft/db";
import { TAX_DATA_VERSION, ytdDeltasFromLines, type TaxCalcLine, type TaxTables } from "@weft/payroll-tax";
import { semimonthlyRunDates, runIdForPayday } from "./calendar";
import { computePeriod, type ComputedPaycheck, type DeductionJson, type PeriodSpec } from "./compute";
import { flagsFor, isBlocked, loadFlagContext, reviewGroupOf, runFlags } from "./anomalies";
import { assertTotalsIdentities, bankBatchTotal, computeTotals, totalsDto, type TotalsCents } from "./totals";
import { activeBankOf, includedPaychecks, rowAmounts, runSubjectHash } from "./subject";

export interface LifecycleDeps { newId(prefix: IdPrefix): Promise<string>; now: string; tables?: TaxTables }
export type RunRow = typeof payrollRuns.$inferSelect;

/** A domain refusal the command layer maps to its RefusalCode (BLOCKED_LINES, DOMAIN_*). */
export class PayrollRefusal extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) { super(message); this.name = "PayrollRefusal"; }
}

export async function getRun(tx: DbTx, runId: string): Promise<RunRow> {
  const r = (await tx.select().from(payrollRuns).where(eq(payrollRuns.id, runId)))[0];
  if (!r) throw new NotFound(`No payroll run ${runId}`);
  return r;
}

/** The last processed regular run of the schedule that ended before `before` (SPEC 7.4 previous_run_id). */
export async function lastProcessedRun(tx: DbTx, payScheduleId: string, before: string): Promise<RunRow | null> {
  const rows = await tx.select().from(payrollRuns)
    .where(and(eq(payrollRuns.payScheduleId, payScheduleId), eq(payrollRuns.status, "processed"), eq(payrollRuns.subtype, "regular")))
    .orderBy(desc(payrollRuns.periodEnd));
  return rows.find((r) => r.periodEnd < before) ?? null;
}

export interface CreateDraftInput { companyId: string; payScheduleId: string; periodEnd: string; runId?: string }

/** payroll.create_draft: allowed while another draft of the schedule is open; compared with the last processed run. */
export async function createDraft(tx: DbTx, deps: LifecycleDeps, input: CreateDraftInput): Promise<RunRow> {
  const schedule = (await tx.select().from(paySchedules).where(eq(paySchedules.id, input.payScheduleId)))[0];
  if (!schedule || schedule.companyId !== input.companyId) throw new NotFound(`No pay schedule ${input.payScheduleId}`);
  if (schedule.frequency !== "semimonthly" || schedule.region !== "us") throw new PayrollRefusal("DOMAIN_UNSUPPORTED_SCHEDULE", `Only US semi-monthly schedules run in the foundation; ${schedule.id} is ${schedule.region} ${schedule.frequency}`);
  const dates = semimonthlyRunDates(input.periodEnd);
  const id = input.runId ?? runIdForPayday(dates.payday);
  const clash = (await tx.select().from(payrollRuns).where(eq(payrollRuns.id, id)))[0];
  if (clash) throw new Conflict(`Payroll run ${id} already exists (${clash.status})`, { runId: id });
  const prev = await lastProcessedRun(tx, input.payScheduleId, dates.periodStart);
  await tx.insert(payrollRuns).values({
    id, companyId: input.companyId, payScheduleId: input.payScheduleId, type: "us", subtype: "regular", status: "draft",
    periodStart: dates.periodStart, periodEnd: dates.periodEnd, payday: dates.payday, approvalDeadline: dates.approvalDeadline, fundingMethod: "ach",
    taxDataVersion: deps.tables?.version ?? TAX_DATA_VERSION, previousRunId: prev?.id ?? null, excludedWorkerIdsJson: "[]",
    createdAt: deps.now, updatedAt: deps.now,
  });
  await writePaychecks(tx, deps, await getRun(tx, id));
  return getRun(tx, id);
}

/** payroll.preview_run: recomputes a draft in place, keeping paycheck ids per worker. */
export async function previewRun(tx: DbTx, deps: LifecycleDeps, runId: string): Promise<RunRow> {
  const run = await getRun(tx, runId);
  if (run.status !== "draft") throw new PayrollRefusal("DOMAIN_NOT_DRAFT", `Payroll run ${runId} is ${run.status}; only drafts are recomputed`);
  await writePaychecks(tx, deps, run);
  return getRun(tx, runId);
}

/**
 * Recomputes every open draft of the company whose payday is on or after `fromDate`. tax.update_rate and
 * tax.revert_rate call it in the same transaction, so a draft never carries a superseded rate and a pending
 * payroll.submit_run proposal sees a new subject hash (STALE_SUBJECT) instead of paying stale numbers.
 */
export async function refreshOpenDrafts(tx: DbTx, deps: LifecycleDeps, companyId: string, fromDate: string): Promise<string[]> {
  const drafts = await tx.select().from(payrollRuns).where(and(eq(payrollRuns.companyId, companyId), eq(payrollRuns.status, "draft")));
  const refreshed: string[] = [];
  for (const run of drafts) {
    if (run.payday < fromDate) continue;
    await writePaychecks(tx, deps, run);
    refreshed.push(run.id);
  }
  return refreshed;
}

function paycheckValues(cp: ComputedPaycheck, flags: Flag[]) {
  const status = isBlocked(flags) ? "blocked" : "draft";
  return {
    status, reviewGroup: reviewGroupOf(flags), hoursX100: cp.hoursX100, grossCents: cp.calc.gross_cents, netCents: cp.calc.net_cents,
    reimbursementsCents: cp.reimbursementsCents, reimbursementsJson: JSON.stringify(cp.reimbursementLines ?? []),   // wave 3 (w3-expenses)
    earningsJson: JSON.stringify(cp.earnings), deductionsJson: JSON.stringify(cp.deductions),
    benefitsJson: JSON.stringify(cp.benefits), taxesJson: JSON.stringify(cp.calc.taxes), flagsJson: JSON.stringify(flags),
  };
}

async function writePaychecks(tx: DbTx, deps: LifecycleDeps, run: RunRow): Promise<void> {
  const spec: PeriodSpec = { companyId: run.companyId, payScheduleId: run.payScheduleId, periodStart: run.periodStart, periodEnd: run.periodEnd, payday: run.payday };
  const dismissed = await dismissedWorkerIds(tx, run.companyId, run.periodStart, run.periodEnd);
  const computed = (await computePeriod(tx, spec, { tables: deps.tables, excludeYtdSources: [`payroll:${run.id}`] })).filter((c) => !dismissed.has(c.workerId));
  const ctx = await loadFlagContext(tx, { payScheduleId: run.payScheduleId, periodStart: run.periodStart, periodEnd: run.periodEnd, previousRunId: run.previousRunId, workerIds: computed.map((c) => c.workerId) });
  const existing = await tx.select().from(paychecks).where(eq(paychecks.payrollRunId, run.id));
  const byWorker = new Map(existing.map((p) => [p.workerId, p]));
  const keep = new Set<string>();
  for (const cp of computed) {
    const flags = flagsFor(cp, ctx);
    const values = paycheckValues(cp, flags);
    const old = byWorker.get(cp.workerId);
    if (old) {
      keep.add(old.id);
      const sameFlags = old.flagsJson === values.flagsJson;
      await tx.update(paychecks).set({ ...values, ...(sameFlags ? {} : { explanation: null, explanationSource: null, explanationRunId: null }) }).where(eq(paychecks.id, old.id));
    } else {
      await tx.insert(paychecks).values({ id: await deps.newId("pyc_"), payrollRunId: run.id, workerId: cp.workerId, ...values });
    }
  }
  const stale = existing.filter((p) => !keep.has(p.id)).map((p) => p.id);
  if (stale.length) await tx.delete(paychecks).where(inArray(paychecks.id, stale));
  await writeRunSummary(tx, deps, run.id, runFlags({ included: computed, ctx, previousRunGrossCents: ctx.previousRunGrossCents }));
}

/**
 * Workers whose final pay (wave 2, w2-offboarding) already covers this period: a dismissal paycheck that is not
 * excluded or failed, in a run of the company whose period overlaps. A regular draft leaves them out, so the
 * period's wages are paid once. Empty (and a no-op) when no dismissal run exists.
 */
export async function dismissedWorkerIds(tx: DbTx, companyId: string, periodStart: string, periodEnd: string): Promise<Set<string>> {
  const runs = (await tx.select().from(payrollRuns).where(and(eq(payrollRuns.companyId, companyId), eq(payrollRuns.subtype, "dismissal"))))
    .filter((r) => r.status !== "failed" && r.periodStart <= periodEnd && r.periodEnd >= periodStart);
  if (!runs.length) return new Set();
  const rows = await tx.select({ workerId: paychecks.workerId, status: paychecks.status }).from(paychecks).where(inArray(paychecks.payrollRunId, runs.map((r) => r.id)));
  return new Set(rows.filter((p) => p.status !== "excluded" && p.status !== "failed").map((p) => p.workerId));
}

/** Recomputes totals, the anomaly summary and the stored subject hash from the paycheck rows. */
export async function writeRunSummary(tx: DbTx, deps: Pick<LifecycleDeps, "now">, runId: string, runLevelFlags?: Flag[]): Promise<TotalsCents> {
  const run = await getRun(tx, runId);
  const rows = await tx.select().from(paychecks).where(eq(paychecks.payrollRunId, runId));
  const totals = computeTotals(rows.map(rowAmounts));
  assertTotalsIdentities(totals);
  const prior = run.anomalySummaryJson ? (JSON.parse(run.anomalySummaryJson) as { runFlags?: Flag[] }) : {};
  const live = rows.filter((p) => p.status !== "excluded");
  const summary = {
    needsReview: live.filter((p) => p.reviewGroup === "needs_review").length,
    ready: live.filter((p) => p.reviewGroup === "ready").length,
    blocked: rows.filter((p) => p.status === "blocked").length,
    excluded: rows.filter((p) => p.status === "excluded").length,
    runFlags: runLevelFlags ?? prior.runFlags ?? [],
  };
  const { hash } = await runSubjectHash(tx, runId, false);
  await tx.update(payrollRuns).set({ totalsJson: JSON.stringify(totalsDto(totals)), anomalySummaryJson: JSON.stringify(summary), subjectHash: hash, updatedAt: deps.now }).where(eq(payrollRuns.id, runId));
  return totals;
}

export interface SubmitInput { runId: string; excludeBlocked: boolean; approvedBy: string; actionSeq: number | null; bank: Pick<BankSim, "submitBatch">; credential: string; settleAt?: string }
export interface SubmitResult { runId: string; batchId: string; settleAt: string; totals: TotalsCents; moneyCents: number; bankTotalCents: number; excludedWorkerIds: string[]; includedCount: number }

/** The money-moving half of payroll.submit_run, inside the executor's transaction (SPEC 7.4). */
export async function submitRun(tx: DbTx, deps: LifecycleDeps, input: SubmitInput): Promise<SubmitResult> {
  const run = await getRun(tx, input.runId);
  if (run.status !== "draft") throw new PayrollRefusal("DOMAIN_NOT_DRAFT", `Payroll run ${run.id} is ${run.status}, not draft`);
  const rows = await tx.select().from(paychecks).where(eq(paychecks.payrollRunId, run.id));
  const blocked = rows.filter((p) => p.status === "blocked");
  if (blocked.length && !input.excludeBlocked) {
    throw new PayrollRefusal("BLOCKED_LINES", `${blocked.length} paycheck(s) are blocked: ${blocked.map((p) => p.workerId).sort().join(", ")}`, { runId: run.id, blockedWorkerIds: blocked.map((p) => p.workerId).sort() });
  }
  const excludedWorkerIds = blocked.map((p) => p.workerId).sort();
  if (blocked.length) await tx.update(paychecks).set({ status: "excluded" }).where(inArray(paychecks.id, blocked.map((p) => p.id)));
  const included = includedPaychecks(rows.map((p) => (p.status === "blocked" ? { ...p, status: "excluded" } : p)), false);
  if (!included.length) throw new PayrollRefusal("DOMAIN_EMPTY_RUN", `Payroll run ${run.id} has no paychecks to pay`);
  const banks = await tx.select().from(bankAccounts).where(inArray(bankAccounts.workerId, included.map((p) => p.workerId)));
  const entries = included.map((p) => {
    const b = activeBankOf(banks, p.workerId);
    if (!b) throw new PayrollRefusal("BLOCKED_LINES", `Paycheck ${p.id} has no active bank account`, { runId: run.id });
    // Simulators store only vault names (SPEC 8): the deposit account travels as its credential_ref, never its id.
    return { workerId: p.workerId, amountCents: p.netCents + p.reimbursementsCents, accountRef: b.credentialRef };
  });
  const totals = computeTotals(included.map(rowAmounts));
  assertTotalsIdentities(totals);
  const bankTotal = entries.reduce((s, e) => s + e.amountCents, 0);
  if (bankTotal !== bankBatchTotal(totals)) throw new Error(`bank batch total ${bankTotal} != netPay + reimbursements ${bankBatchTotal(totals)}`);
  const settleAt = input.settleAt ?? semimonthlyRunDates(run.periodEnd).settleAt;
  const batch = await input.bank.submitBatch({ payrollRunId: run.id, entries, credential: input.credential, settleAt });
  await tx.update(paychecks).set({ status: "processing" }).where(inArray(paychecks.id, included.map((p) => p.id)));
  await tx.update(payrollRuns).set({
    status: "processing", approvedBy: input.approvedBy, approvedAt: deps.now, submittedActionSeq: input.actionSeq, bankBatchId: batch.batchId,
    settleAt: batch.settleAt, excludedWorkerIdsJson: JSON.stringify(excludedWorkerIds), updatedAt: deps.now,
  }).where(eq(payrollRuns.id, run.id));
  await writeRunSummary(tx, deps, run.id);
  return { runId: run.id, batchId: batch.batchId, settleAt: batch.settleAt, totals, moneyCents: totals.totalCost, bankTotalCents: bankTotal, excludedWorkerIds, includedCount: included.length };
}

/** The system record of a settled batch (payroll.mark_processed): processed, YTD ledger rows written. */
export async function markProcessed(tx: DbTx, deps: Pick<LifecycleDeps, "now">, input: { runId: string; batchId?: string }): Promise<{ runId: string; ytdRows: number; paychecks: number }> {
  const run = await getRun(tx, input.runId);
  if (run.status === "processed") return { runId: run.id, ytdRows: 0, paychecks: 0 };
  if (run.status !== "processing") throw new PayrollRefusal("DOMAIN_NOT_PROCESSING", `Payroll run ${run.id} is ${run.status}, not processing`);
  if (input.batchId && run.bankBatchId && input.batchId !== run.bankBatchId) throw new PayrollRefusal("DOMAIN_BATCH_MISMATCH", `Batch ${input.batchId} does not belong to ${run.id}`);
  const rows = (await tx.select().from(paychecks).where(eq(paychecks.payrollRunId, run.id))).filter((p) => p.status === "processing");
  const year = Number(run.payday.slice(0, 4));
  const { workerStates } = await workerStatesOf(tx, rows.map((p) => p.workerId));
  let n = 0;
  for (const p of rows) {
    const deltas = ytdDeltasFromLines({
      state: workerStates.get(p.workerId) ?? "CA", grossCents: p.grossCents, taxes: JSON.parse(p.taxesJson) as TaxCalcLine[],
      deductions: (JSON.parse(p.deductionsJson) as DeductionJson[]).filter((d) => d.pretax).map((d) => ({ code: d.code, amount_cents: d.amountCents })),
      // Off-cycle runs (wave 2): bonus lines are supplemental wages, counted toward the $1,000,000 flat-rate threshold.
      ...(run.subtype === "off_cycle" ? { supplementalCents: (JSON.parse(p.earningsJson) as { type: string; amountCents: number }[]).filter((e) => e.type === "bonus").reduce((s, e) => s + e.amountCents, 0) } : {}),
    });
    const values = Object.entries(deltas).sort(([a], [b]) => (a < b ? -1 : 1)).map(([code, amountCents]) => ({ workerId: p.workerId, year, code, amountCents, source: `payroll:${run.id}` }));
    if (values.length) await tx.insert(ytdLedger).values(values);
    n += values.length;
  }
  if (rows.length) await tx.update(paychecks).set({ status: "processed" }).where(inArray(paychecks.id, rows.map((p) => p.id)));
  await tx.update(payrollRuns).set({ status: "processed", processedAt: deps.now, updatedAt: deps.now }).where(eq(payrollRuns.id, run.id));
  return { runId: run.id, ytdRows: n, paychecks: rows.length };
}

/**
 * The system record of a returned bank batch (payroll.mark_failed, SPEC 7.4 states). The bank simulator returns the
 * whole batch (sim_bank_batches.status = returned) and never settles it, so nothing in it was paid: the run and every
 * paycheck still processing become failed, the returned entry is named as the cause, and no YTD rows are written.
 * Idempotent on a failed run.
 */
export async function markFailed(tx: DbTx, deps: Pick<LifecycleDeps, "now">, input: { runId: string; batchId?: string; workerId: string }): Promise<{ runId: string; returnedPaycheckId: string; failed: number }> {
  const run = await getRun(tx, input.runId);
  const all = await tx.select().from(paychecks).where(eq(paychecks.payrollRunId, run.id));
  const returned = all.find((p) => p.workerId === input.workerId);
  if (!returned) throw new NotFound(`No paycheck for ${input.workerId} in ${run.id}`);
  if (run.status === "failed") return { runId: run.id, returnedPaycheckId: returned.id, failed: 0 };
  if (run.status !== "processing") throw new PayrollRefusal("DOMAIN_NOT_PROCESSING", `Payroll run ${run.id} is ${run.status}, not processing`);
  if (input.batchId && run.bankBatchId && input.batchId !== run.bankBatchId) throw new PayrollRefusal("DOMAIN_BATCH_MISMATCH", `Batch ${input.batchId} does not belong to ${run.id}`);
  if (returned.status !== "processing") throw new PayrollRefusal("DOMAIN_NOT_PROCESSING", `Paycheck ${returned.id} is ${returned.status}, not processing`);
  const inFlight = all.filter((p) => p.status === "processing");
  await tx.update(paychecks).set({ status: "failed" }).where(inArray(paychecks.id, inFlight.map((p) => p.id)));
  await tx.update(payrollRuns).set({ status: "failed", updatedAt: deps.now }).where(eq(payrollRuns.id, run.id));
  await writeRunSummary(tx, deps, run.id);
  return { runId: run.id, returnedPaycheckId: returned.id, failed: inFlight.length };
}

async function workerStatesOf(tx: DbTx, ids: string[]): Promise<{ workerStates: Map<string, string> }> {
  const rows = ids.length ? await tx.select({ id: workers.id, state: workers.workState }).from(workers).where(inArray(workers.id, ids)) : [];
  return { workerStates: new Map(rows.map((r) => [r.id, r.state ?? "CA"])) };
}
