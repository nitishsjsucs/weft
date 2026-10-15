// @weft/payroll-tax: the pure payroll and tax engine (SPEC 7). No I/O; integer cents; synthetic 2026.1 tables.
export * from "./types";
export { TAX_2026, TAX_DATA_VERSION, WAGE_BASES, type TaxTables, type WageBase, type Bracket, type PretaxRule } from "./data/2026";
export { calculatePaycheck, taxableWages } from "./calculate";
export { federalIncomeTax } from "./federal";
export { fica } from "./fica";
export { futa } from "./futa";
export { californiaPit } from "./states/ca";
export { newYorkPit, newYorkPfl, newYorkDbl, nyDblPeriodCapCents, nyPeriodTable, nyTableA } from "./states/ny";
export { coloradoPit } from "./states/co";
export { SUPPORTED_STATES } from "./states/index";
export { roundCents } from "./math";
