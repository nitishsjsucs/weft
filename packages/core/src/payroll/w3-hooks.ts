// Scaffold (frozen): the wave 3 seams into payroll compute and the pre-payroll rules (docs/wave3.md). Each track fills
// only its own file: ../expenses/payroll.ts and ../expenses/flags.ts (w3-expenses), ../time-off/payroll.ts and
// ../time-off/flags.ts (w3-timeoff), ./parity-flags.ts (w3-parity-routines). With the scaffold stubs nothing changes.
import type { Flag } from "@weft/contracts";
import type { DbTx } from "@weft/db";
import type { ComputedPaycheck } from "./compute";
import { loadExpensePayrollInputs, type ExpensePayrollInputs } from "../expenses/payroll";
import { loadTimeOffPayrollInputs, type TimeOffPayrollInputs } from "../time-off/payroll";
import { expenseFlags, loadExpenseFlagData } from "../expenses/flags";
import { loadTimeOffFlagData, timeOffFlags } from "../time-off/flags";
import { loadParityFlagData, parityFlags } from "./parity-flags";

export { reimbursementsFor } from "../expenses/payroll";
export { timeOffEarnings } from "../time-off/payroll";

export interface W3PayrollInputs { expenses: ExpensePayrollInputs; timeOff: TimeOffPayrollInputs }
export const EMPTY_W3_INPUTS: W3PayrollInputs = { expenses: { scheduled: [] }, timeOff: { approved: [] } };
export async function loadW3PayrollInputs(tx: DbTx, companyId: string, workerIds: string[]): Promise<W3PayrollInputs> {
  const [expenses, timeOff] = await Promise.all([loadExpensePayrollInputs(tx, companyId, workerIds), loadTimeOffPayrollInputs(tx, companyId, workerIds)]);
  return { expenses, timeOff };
}

export interface W3FlagInput { payScheduleId: string; periodStart: string; periodEnd: string; previousRunId: string | null; workerIds: string[] }
export interface W3FlagData { expenses: unknown; timeOff: unknown; parity: unknown }
export async function loadW3FlagData(tx: DbTx, input: W3FlagInput): Promise<W3FlagData> {
  const [expenses, timeOff, parity] = await Promise.all([loadExpenseFlagData(tx, input), loadTimeOffFlagData(tx, input), loadParityFlagData(tx, input)]);
  return { expenses, timeOff, parity };
}
export function w3Flags(cp: ComputedPaycheck, data: W3FlagData | undefined): Flag[] {
  if (!data) return [];
  return [...parityFlags(cp, data.parity), ...timeOffFlags(cp, data.timeOff), ...expenseFlags(cp, data.expenses)];
}
