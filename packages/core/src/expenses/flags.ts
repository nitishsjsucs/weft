// REIMBURSEMENT_SPIKE (wave 3, research/wave3/expenses-timeoff.md 7.3 item 7). Owner: w3-expenses. Called by
// payroll/w3-hooks.ts. A paycheck's reimbursements over $2,500, or over 3 times the worker's average across the last 3
// processed regular runs of the schedule (when that average is above zero), go to Needs Review.
import { and, desc, eq, inArray } from "drizzle-orm";
import { formatCents, type Flag } from "@weft/contracts";
import { paychecks, payrollRuns, type DbTx } from "@weft/db";
import type { ComputedPaycheck } from "../payroll/compute";
import type { W3FlagInput } from "../payroll/w3-hooks";

export const REIMBURSEMENT_SPIKE_CENTS = 250_000;
export const REIMBURSEMENT_SPIKE_MULTIPLE = 3;
export interface ExpenseFlagData { recent: Map<string, number[]> }

export async function loadExpenseFlagData(tx: DbTx, input: W3FlagInput): Promise<ExpenseFlagData> {
  const runs = (await tx.select({ id: payrollRuns.id, periodEnd: payrollRuns.periodEnd }).from(payrollRuns)
    .where(and(eq(payrollRuns.payScheduleId, input.payScheduleId), eq(payrollRuns.status, "processed"), eq(payrollRuns.subtype, "regular")))
    .orderBy(desc(payrollRuns.periodEnd))).filter((r) => r.periodEnd < input.periodStart).slice(0, 3);
  const recent = new Map<string, number[]>();
  if (!runs.length || !input.workerIds.length) return { recent };
  const rows = await tx.select({ workerId: paychecks.workerId, cents: paychecks.reimbursementsCents }).from(paychecks)
    .where(and(inArray(paychecks.payrollRunId, runs.map((r) => r.id)), inArray(paychecks.workerId, input.workerIds)));
  for (const r of rows) recent.set(r.workerId, [...(recent.get(r.workerId) ?? []), r.cents]);
  return { recent };
}

export function expenseFlags(cp: ComputedPaycheck, data: unknown): Flag[] {
  const cents = cp.reimbursementsCents;
  if (cents <= 0) return [];
  const recent = (data as ExpenseFlagData | null)?.recent?.get(cp.workerId) ?? [];
  const avg = recent.length ? Math.floor(recent.reduce((s, c) => s + c, 0) / recent.length) : 0;
  const overCap = cents > REIMBURSEMENT_SPIKE_CENTS;
  const overAvg = avg > 0 && cents > REIMBURSEMENT_SPIKE_MULTIPLE * avg;
  if (!overCap && !overAvg) return [];
  return [{
    rule: "REIMBURSEMENT_SPIKE", severity: "review",
    message: overCap ? `Reimbursements ${formatCents(cents)} are over ${formatCents(REIMBURSEMENT_SPIKE_CENTS)}` : `Reimbursements ${formatCents(cents)} are over ${REIMBURSEMENT_SPIKE_MULTIPLE} times the recent average ${formatCents(avg)}`,
    evidence: { worker_id: cp.workerId, reimbursements_cents: cents, recent_average_cents: avg, expense_ids: (cp.reimbursementLines ?? []).map((l) => l.expenseId) },
  }];
}
