// Time off in payroll (wave 3, docs/wave3.md). Owner: w3-timeoff. payroll/w3-hooks.ts calls these from compute.ts; the
// scaffold returns the earnings unchanged. Salaried gross is split into salary, pto, sick and paid_holiday lines at
// annual / 2,080 per hour (never increased); hourly workers get leave lines on top of worked hours.
import type { DbTx } from "@weft/db";
import type { EarningJson, PayRateRow, PeriodSpec, WorkerRow } from "../payroll/compute";

export type TimeOffPayrollInputs = { approved: unknown[] };
export async function loadTimeOffPayrollInputs(_tx: DbTx, _companyId: string, _workerIds: string[]): Promise<TimeOffPayrollInputs> { return { approved: [] }; }
export function timeOffEarnings(_w: WorkerRow, _rate: PayRateRow | null, earnings: EarningJson[], _p: PeriodSpec, _inputs: TimeOffPayrollInputs): EarningJson[] {
  return earnings;
}
