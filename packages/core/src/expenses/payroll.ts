// Expenses in payroll (wave 3, docs/wave3.md). Owner: w3-expenses. payroll/w3-hooks.ts calls these from compute.ts.
// An approved item attached to a draft (expenses.payroll_run_id) rides that run's paycheck for the worker:
// status scheduled is a non-taxable reimbursement (reimbursementsCents and reimbursements_json: outside gross, taxes
// and net, inside the bank entry and the totals); approved_taxable (past the 60-day accountable window) becomes a
// taxable_reimbursement earning line inside gross. Nothing is attached in the scaffold world, so paychecks are unchanged.
import { and, inArray, isNotNull } from "drizzle-orm";
import type { ExpenseCategory, ReimbursementLine } from "@weft/contracts";
import { expenses, payrollRuns, type DbTx } from "@weft/db";
import type { EarningJson, PeriodSpec, WorkerRow } from "../payroll/compute";

export interface ScheduledExpense {
  id: string; workerId: string; category: ExpenseCategory; amountCents: number; taxable: boolean;
  run: { payScheduleId: string; periodStart: string; periodEnd: string; payday: string };
}
export type ExpensePayrollInputs = { scheduled: ScheduledExpense[] };

export async function loadExpensePayrollInputs(tx: DbTx, companyId: string, workerIds: string[]): Promise<ExpensePayrollInputs> {
  if (!workerIds.length) return { scheduled: [] };
  const rows = await tx.select().from(expenses).where(and(inArray(expenses.workerId, workerIds), inArray(expenses.status, ["scheduled", "approved_taxable"]), isNotNull(expenses.payrollRunId)));
  const mine = rows.filter((r) => r.companyId === companyId);
  if (!mine.length) return { scheduled: [] };
  const runs = await tx.select().from(payrollRuns).where(inArray(payrollRuns.id, [...new Set(mine.map((r) => r.payrollRunId!))]));
  const byId = new Map(runs.map((r) => [r.id, r]));
  const scheduled: ScheduledExpense[] = [];
  for (const r of mine.sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const run = byId.get(r.payrollRunId!);
    if (!run || run.subtype !== "regular") continue;
    scheduled.push({ id: r.id, workerId: r.workerId, category: r.category as ExpenseCategory, amountCents: r.amountCents, taxable: r.status === "approved_taxable", run: { payScheduleId: run.payScheduleId, periodStart: run.periodStart, periodEnd: run.periodEnd, payday: run.payday } });
  }
  return { scheduled };
}

/** The worker's attached items for exactly this regular period (schedule, period and payday). Pure. */
export function reimbursementsFor(w: WorkerRow, p: PeriodSpec, inputs: ExpensePayrollInputs): { reimbursementsCents: number; lines: ReimbursementLine[]; taxableEarnings: EarningJson[] } {
  const items = (inputs.scheduled ?? []).filter((s) => s.workerId === w.id && s.run.payScheduleId === p.payScheduleId && s.run.periodStart === p.periodStart && s.run.periodEnd === p.periodEnd && s.run.payday === p.payday);
  const lines: ReimbursementLine[] = items.filter((s) => !s.taxable).map((s) => ({ expenseId: s.id, category: s.category, amountCents: s.amountCents }));
  const taxableEarnings: EarningJson[] = items.filter((s) => s.taxable).map((s) => ({ type: "taxable_reimbursement", amountCents: s.amountCents, hoursX100: null }));
  return { reimbursementsCents: lines.reduce((t, l) => t + l.amountCents, 0), lines, taxableEarnings };
}
