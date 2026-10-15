// Engine types (SPEC 7.2). Owner: t1-payroll. Integer cents; rates are decimal strings.
export interface EarningLine { type: "regular" | "overtime" | "salary" | "bonus" | "supplemental"; amount_cents: number; hours_x100: number | null }
export interface DeductionLine { code: string; amount_cents: number }
export interface W4Input {
  version: "2020" | "pre2020"; filingStatus: "single" | "mfj" | "hoh"; step2Checkbox: boolean;
  step3Cents: number; step4aCents: number; step4bCents: number; step4cCents: number; allowances: number; exempt: boolean;
}
export interface StateWithholdingInput { filingStatus: string | null; allowances: number }
export interface EmployerRateInput { rate: string; wageBaseCents: number }
export interface PaycheckInput {
  payDate: string; payPeriodsPerYear: number; jurisdiction: "CA" | "NY" | "TX" | "CO" | string;
  earnings: EarningLine[]; pretax: DeductionLine[]; posttax: DeductionLine[]; reimbursements_cents: number;
  w4: W4Input; state: StateWithholdingInput; ytd: Record<string, number>;
  employerRates: { sui: EmployerRateInput | null; ett: EmployerRateInput | null }; supplemental?: boolean;
}
export interface TaxCalcLine { code: string; jurisdiction: string; payer: "employee" | "employer"; taxable_wages_cents: number; rate: string | null; amount_cents: number }
export interface PaycheckCalc {
  gross_cents: number; taxableWages: Record<string, number>; taxes: TaxCalcLine[];
  employee_deductions_cents: number; net_cents: number; ytdDeltas: Record<string, number>; trace: string[];
}
