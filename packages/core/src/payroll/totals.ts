// The 12 run totals (SPEC 7.4), integer cents plus a display string. In the simulator Weft remits every deduction, so:
//   netPay = grossPay - workerTaxes - preTaxDeductions - postTaxDeductions
//   totalCost = grossPay + reimbursements + employerTaxes + employerBenefitContributions + transactionFees
//   cashRequirement = totalCost; bank batch total = netPay + reimbursements.
// workerBenefitContributions is an informational subset of pre-tax plus post-tax. Excluded paychecks are left out.
import { money, TOTALS_FIELDS, type Totals } from "@weft/contracts";
import type { TaxCalcLine } from "@weft/payroll-tax";
import type { BenefitJson, DeductionJson } from "./compute";

export type TotalsField = (typeof TOTALS_FIELDS)[number];
export type TotalsCents = Record<TotalsField, number>;

export interface PaycheckAmounts {
  status: string; grossCents: number; netCents: number; reimbursementsCents: number;
  taxes: Pick<TaxCalcLine, "payer" | "amount_cents">[]; deductions: DeductionJson[]; benefits: BenefitJson[];
}

/** Sim ACH fee is $0.00 and is shown as such. */
export const SIM_ACH_FEE_CENTS = 0;

export function computeTotals(rows: PaycheckAmounts[]): TotalsCents {
  const t: TotalsCents = Object.fromEntries(TOTALS_FIELDS.map((k) => [k, 0])) as TotalsCents;
  for (const p of rows) {
    if (p.status === "excluded") continue;
    t.grossPay += p.grossCents;
    t.netPay += p.netCents;
    t.reimbursements += p.reimbursementsCents;
    for (const x of p.taxes) { if (x.payer === "employee") t.workerTaxes += x.amount_cents; else t.employerTaxes += x.amount_cents; }
    for (const d of p.deductions) { if (d.pretax) t.preTaxDeductions += d.amountCents; else t.postTaxDeductions += d.amountCents; }
    for (const b of p.benefits) { t.workerBenefitContributions += b.employeeCents; t.employerBenefitContributions += b.employerCents; }
  }
  t.transactionFees = SIM_ACH_FEE_CENTS;
  t.totalCost = t.grossPay + t.reimbursements + t.employerTaxes + t.employerBenefitContributions + t.transactionFees;
  t.cashRequirement = t.totalCost;
  return t;
}

/** Throws when an identity of SPEC 7.4 does not hold. */
export function assertTotalsIdentities(t: TotalsCents): void {
  const fail = (m: string) => { throw new Error(`totals identity failed: ${m}`); };
  if (t.netPay !== t.grossPay - t.workerTaxes - t.preTaxDeductions - t.postTaxDeductions) fail("netPay = grossPay - workerTaxes - preTaxDeductions - postTaxDeductions");
  if (t.totalCost !== t.grossPay + t.reimbursements + t.employerTaxes + t.employerBenefitContributions + t.transactionFees) fail("totalCost");
  if (t.cashRequirement !== t.totalCost) fail("cashRequirement = totalCost");
}

export const bankBatchTotal = (t: TotalsCents) => t.netPay + t.reimbursements;

export function totalsDto(t: TotalsCents): Totals {
  return Object.fromEntries(TOTALS_FIELDS.map((k) => [k, money(t[k])])) as Totals;
}
export function totalsFromDto(json: string | null): TotalsCents | null {
  if (!json) return null;
  const d = JSON.parse(json) as Record<string, { amount: number }>;
  return Object.fromEntries(TOTALS_FIELDS.map((k) => [k, d[k]?.amount ?? 0])) as TotalsCents;
}
