// REIMBURSEMENT_SPIKE (wave 3, docs/wave3.md). Owner: w3-expenses. Called by payroll/w3-hooks.ts; the scaffold flags nothing.
import type { Flag } from "@weft/contracts";
import type { DbTx } from "@weft/db";
import type { ComputedPaycheck } from "../payroll/compute";
import type { W3FlagInput } from "../payroll/w3-hooks";

export async function loadExpenseFlagData(_tx: DbTx, _input: W3FlagInput): Promise<unknown> { return null; }
export function expenseFlags(_cp: ComputedPaycheck, _data: unknown): Flag[] { return []; }
