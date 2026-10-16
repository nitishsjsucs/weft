// DUPLICATE_SUPPLEMENTAL, RAISE_NOT_APPLIED and WITHHOLDING_CHANGED (wave 3, docs/wave3.md). Owner: w3-parity-routines.
// Called by payroll/w3-hooks.ts; the scaffold flags nothing.
import type { Flag } from "@weft/contracts";
import type { DbTx } from "@weft/db";
import type { ComputedPaycheck } from "./compute";
import type { W3FlagInput } from "./w3-hooks";

export async function loadParityFlagData(_tx: DbTx, _input: W3FlagInput): Promise<unknown> { return null; }
export function parityFlags(_cp: ComputedPaycheck, _data: unknown): Flag[] { return []; }
