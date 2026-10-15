import { NotImplemented } from "@weft/contracts";
import { TAX_2026, type TaxTables } from "./data/2026";
import type { PaycheckCalc, PaycheckInput } from "./types";

export * from "./types";
export { TAX_2026, TAX_DATA_VERSION, type TaxTables } from "./data/2026";

/** Pure, no I/O (SPEC 7.2). */
export function calculatePaycheck(_input: PaycheckInput, _tables: TaxTables = TAX_2026): PaycheckCalc {
  throw new NotImplemented("calculatePaycheck (t1-payroll)");
}
