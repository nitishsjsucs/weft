// Read models for payroll: API DTOs (contracts/domain.ts PayrollRun, Paycheck) and the concise agent format of
// payroll.get_run (SPEC 9.2: totals, counts by section, flagged rows with evidence; under 8,000 characters).
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { formatCents, money, TOTALS_FIELDS, type Flag, type Paycheck, type PayrollRun } from "@weft/contracts";
import { paychecks, payrollRuns, workers, type DbTx } from "@weft/db";
import type { TaxCalcLine } from "@weft/payroll-tax";
import { computeWorkerPaycheck, loadWorld, loadYtd, type BenefitJson, type DeductionJson, type EarningJson } from "./compute";
import { totalsFromDto } from "./totals";

type RunRow = typeof payrollRuns.$inferSelect;
type PaycheckRow = typeof paychecks.$inferSelect;

export const workerDisplayName = (w: { firstName: string; lastName: string }) => `${w.firstName} ${w.lastName}`;

export async function workerNames(tx: DbTx, ids: string[]): Promise<Map<string, { name: string; state: string | null }>> {
  const rows = ids.length ? await tx.select({ id: workers.id, firstName: workers.firstName, lastName: workers.lastName, state: workers.workState }).from(workers).where(inArray(workers.id, ids)) : [];
  return new Map(rows.map((r) => [r.id, { name: workerDisplayName(r), state: r.state }]));
}

export function runDto(r: RunRow, paycheckCount: number): PayrollRun {
  const summary = r.anomalySummaryJson ? (JSON.parse(r.anomalySummaryJson) as { needsReview: number; ready: number; blocked: number; excluded: number }) : null;
  return {
    id: r.id, payScheduleId: r.payScheduleId, type: r.type as PayrollRun["type"], subtype: r.subtype as PayrollRun["subtype"], status: r.status as PayrollRun["status"],
    periodStart: r.periodStart, periodEnd: r.periodEnd, payday: r.payday, approvalDeadline: r.approvalDeadline, fundingMethod: "ach",
    totals: r.totalsJson ? (JSON.parse(r.totalsJson) as PayrollRun["totals"]) : null,
    anomalySummary: summary ? { needsReview: summary.needsReview, ready: summary.ready, blocked: summary.blocked, excluded: summary.excluded } : null,
    subjectHash: r.subjectHash, taxDataVersion: r.taxDataVersion, previousRunId: r.previousRunId, excludedWorkerIds: JSON.parse(r.excludedWorkerIdsJson) as string[],
    approvedBy: r.approvedBy, approvedAt: r.approvedAt, submittedActionSeq: r.submittedActionSeq, bankBatchId: r.bankBatchId, settleAt: r.settleAt,
    processedAt: r.processedAt, paycheckCount,
  };
}

export function paycheckDto(p: PaycheckRow, workerName: string, trace?: string[]): Paycheck {
  const taxes = JSON.parse(p.taxesJson) as TaxCalcLine[];
  const benefits = JSON.parse(p.benefitsJson) as BenefitJson[];
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  return {
    id: p.id, payrollRunId: p.payrollRunId, workerId: p.workerId, workerName, status: p.status as Paycheck["status"], reviewGroup: p.reviewGroup as Paycheck["reviewGroup"],
    hoursX100: p.hoursX100, gross: money(p.grossCents), net: money(p.netCents), reimbursements: money(p.reimbursementsCents),
    employeeTaxes: money(sum(taxes.filter((t) => t.payer === "employee").map((t) => t.amount_cents))),
    companyTaxes: money(sum(taxes.filter((t) => t.payer === "employer").map((t) => t.amount_cents))),
    companyBenefits: money(sum(benefits.map((b) => b.employerCents))),
    earnings: JSON.parse(p.earningsJson) as EarningJson[], deductions: JSON.parse(p.deductionsJson) as DeductionJson[], benefits,
    taxes: taxes.map((t) => ({ code: t.code, jurisdiction: t.jurisdiction, payer: t.payer, taxableWagesCents: t.taxable_wages_cents, rate: t.rate, amountCents: t.amount_cents })),
    flags: JSON.parse(p.flagsJson) as Flag[], explanation: p.explanation, explanationSource: (p.explanationSource as Paycheck["explanationSource"]) ?? null, explanationRunId: p.explanationRunId,
    ...(trace ? { trace } : {}),
  };
}

export async function listRuns(tx: DbTx, companyId: string, opts: { limit: number; afterId?: string | null; status?: string | null }): Promise<{ rows: RunRow[]; counts: Map<string, number> }> {
  const conds = [eq(payrollRuns.companyId, companyId)];
  if (opts.afterId) conds.push(gt(payrollRuns.id, opts.afterId));
  if (opts.status) conds.push(eq(payrollRuns.status, opts.status));
  const rows = await tx.select().from(payrollRuns).where(and(...conds)).orderBy(asc(payrollRuns.id)).limit(opts.limit);
  const counts = new Map<string, number>();
  if (rows.length) {
    const pcs = await tx.select({ runId: paychecks.payrollRunId }).from(paychecks).where(inArray(paychecks.payrollRunId, rows.map((r) => r.id)));
    for (const p of pcs) counts.set(p.runId, (counts.get(p.runId) ?? 0) + 1);
  }
  return { rows, counts };
}

const short = (cents: number) => ({ cents, display: formatCents(cents) });

/** The concise payroll.get_run result. */
export async function concisePayrollRun(tx: DbTx, run: RunRow, filters: { flaggedOnly?: boolean; workerId?: string; state?: string; detailed?: boolean }) {
  const rows = await tx.select().from(paychecks).where(eq(paychecks.payrollRunId, run.id)).orderBy(asc(paychecks.workerId));
  const names = await workerNames(tx, rows.map((p) => p.workerId));
  const totals = totalsFromDto(run.totalsJson);
  const live = rows.filter((p) => p.status !== "excluded");
  const matches = (p: PaycheckRow) => (!filters.workerId || p.workerId === filters.workerId) && (!filters.state || names.get(p.workerId)?.state === filters.state);
  const flagged = rows.filter((p) => p.reviewGroup === "needs_review" || p.status === "excluded").filter(matches);
  const summary = run.anomalySummaryJson ? (JSON.parse(run.anomalySummaryJson) as { runFlags?: Flag[] }) : {};
  const row = (p: PaycheckRow) => {
    const n = names.get(p.workerId);
    return { paycheck_id: p.id, worker: `${n?.name ?? p.workerId} (${p.workerId})`, state: n?.state ?? null, status: p.status, hours_x100: p.hoursX100, gross_cents: p.grossCents, gross_display: formatCents(p.grossCents), net_cents: p.netCents, net_display: formatCents(p.netCents) };
  };
  const listOthers = filters.detailed || ((filters.workerId || filters.state) && !filters.flaggedOnly);
  return {
    run_id: run.id, status: run.status, period: `${run.periodStart} to ${run.periodEnd}`, payday: run.payday, approval_deadline: run.approvalDeadline,
    previous_run_id: run.previousRunId, tax_data_version: run.taxDataVersion, label: "synthetic",
    counts: { paychecks: rows.length, needs_review: live.filter((p) => p.reviewGroup === "needs_review").length, ready: live.filter((p) => p.reviewGroup === "ready").length, blocked: rows.filter((p) => p.status === "blocked").length, excluded: rows.filter((p) => p.status === "excluded").length },
    totals: totals ? Object.fromEntries(TOTALS_FIELDS.map((k) => [k, short(totals[k])])) : null,
    excluded_worker_ids: JSON.parse(run.excludedWorkerIdsJson) as string[],
    flagged: flagged.map((p) => ({
      ...row(p), flags: (JSON.parse(p.flagsJson) as Flag[]).map((f) => ({ rule: f.rule, severity: f.severity, message: f.message, evidence: f.evidence })),
      explanation: p.explanation, explanation_source: p.explanationSource,
    })),
    run_flags: summary.runFlags ?? [],
    ...(listOthers ? { ready: rows.filter((p) => p.reviewGroup === "ready" && p.status !== "excluded").filter(matches).map(row) } : {}),
  };
}

/**
 * The tax trace of a paycheck, recomputed with the engine from current HR data and the YTD ledger as of that run
 * (sources from this run and later paydays excluded). Labeled as a recomputation in the UI.
 */
export async function paycheckTrace(tx: DbTx, p: PaycheckRow): Promise<string[]> {
  const run = (await tx.select().from(payrollRuns).where(eq(payrollRuns.id, p.payrollRunId)))[0];
  if (!run) return [];
  const w = (await tx.select().from(workers).where(eq(workers.id, p.workerId)))[0];
  if (!w) return [];
  const later = (await tx.select({ id: payrollRuns.id, payday: payrollRuns.payday }).from(payrollRuns).where(eq(payrollRuns.payScheduleId, run.payScheduleId)))
    .filter((r) => r.payday >= run.payday).map((r) => `payroll:${r.id}`);
  const world = await loadWorld(tx, run.companyId, [w.id]);
  const ytd = await loadYtd(tx, [w.id], Number(run.payday.slice(0, 4)), later);
  const cp = computeWorkerPaycheck(w, { companyId: run.companyId, payScheduleId: run.payScheduleId, periodStart: run.periodStart, periodEnd: run.periodEnd, payday: run.payday }, world, ytd.get(w.id) ?? {});
  return [`Recomputed from current HR data (synthetic ${run.taxDataVersion} tables)`, ...cp.calc.trace];
}
