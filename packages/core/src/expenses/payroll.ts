// Expenses in payroll (wave 3, docs/wave3.md). Owner: w3-expenses. payroll/w3-hooks.ts calls these from compute.ts;
// the scaffold returns no reimbursements, so every paycheck is unchanged until the track fills them in.
// Non-taxable reimbursements go to reimbursementsCents (outside gross, inside net and the bank entry); approved_taxable
// items become a taxable_reimbursement earning line inside gross.
import type { ReimbursementLine } from "@weft/contracts";
import type { DbTx } from "@weft/db";
import type { EarningJson, PeriodSpec, WorkerRow } from "../payroll/compute";

export type ExpensePayrollInputs = { scheduled: unknown[] };
export async function loadExpensePayrollInputs(_tx: DbTx, _companyId: string, _workerIds: string[]): Promise<ExpensePayrollInputs> { return { scheduled: [] }; }
export function reimbursementsFor(_w: WorkerRow, _p: PeriodSpec, _inputs: ExpensePayrollInputs): { reimbursementsCents: number; lines: ReimbursementLine[]; taxableEarnings: EarningJson[] } {
  return { reimbursementsCents: 0, lines: [], taxableEarnings: [] };
}
