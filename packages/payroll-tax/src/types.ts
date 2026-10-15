// Engine types (SPEC 7.2). Owner: t1-payroll. Integer cents; rates are decimal strings.
export interface EarningLine { type: "regular" | "overtime" | "salary" | "bonus" | "supplemental"; amount_cents: number; hours_x100: number | null }
export interface DeductionLine { code: string; amount_cents: number }
export interface W4Input {
  version: "2020" | "pre2020"; filingStatus: "single" | "mfj" | "hoh"; step2Checkbox: boolean;
  step3Cents: number; step4aCents: number; step4bCents: number; step4cCents: number; allowances: number; exempt: boolean;
}
/**
 * State withholding certificate. CA DE 4: filingStatus single | married | hoh, allowances (regular) and
 * additionalAllowances (Table 2 estimated deduction). NY IT-2104: single | married, allowances = exemptions.
 * CO: DR 0004 line 2 amount in allowanceOverrideCents, else the W-4 filing status decides.
 */
export interface StateWithholdingInput {
  filingStatus: string | null; allowances: number;
  additionalAllowances?: number; extraCents?: number; allowanceOverrideCents?: number | null;
}
export interface EmployerRateInput { rate: string; wageBaseCents: number }
/**
 * `ytd` keys (cents, this calendar year, before this paycheck): gross, fit_wages, ss_wages, medicare_wages, futa_wages,
 * sui_wages:<ST>, state_pit_wages:<ST>, sdi_wages:CA, pfl_wages:NY, dbl_wages:NY, famli_wages:CO, k401_deferral,
 * supplemental, and tax amounts as tax:<jurisdiction>:<code>:<payer> (for example tax:NY:pfl:employee).
 */
export interface PaycheckInput {
  payDate: string; payPeriodsPerYear: number; jurisdiction: "CA" | "NY" | "TX" | "CO" | string;
  earnings: EarningLine[]; pretax: DeductionLine[]; posttax: DeductionLine[]; reimbursements_cents: number;
  w4: W4Input; state: StateWithholdingInput; ytd: Record<string, number>;
  employerRates: { sui: EmployerRateInput | null; ett: EmployerRateInput | null }; supplemental?: boolean;
  /** NY DBL: the employer collects the employee share (default true). */
  collectNyDbl?: boolean;
}
export interface TaxCalcLine { code: string; jurisdiction: string; payer: "employee" | "employer"; taxable_wages_cents: number; rate: string | null; amount_cents: number }
export interface PaycheckCalc {
  gross_cents: number; taxableWages: Record<string, number>; taxes: TaxCalcLine[];
  /** Employee deductions: pre-tax plus post-tax (not taxes). */
  employee_deductions_cents: number;
  employee_taxes_cents: number; employer_taxes_cents: number; pretax_cents: number; posttax_cents: number;
  /** gross - employee taxes - pre-tax - post-tax; excludes reimbursements. */
  net_cents: number; ytdDeltas: Record<string, number>; trace: string[];
}
