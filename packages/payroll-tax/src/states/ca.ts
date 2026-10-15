// California PIT: EDD Method B (exact calculation), computed on an annual basis and prorated back to the period,
// which EDD permits (research/domain.md 2.1). Steps: low income exemption, estimated deduction, standard deduction,
// tax rate table, exemption allowance credit.
import type { TaxTables } from "../data/2026";
import { bracketTax, D, dec, fmt, pct, roundCents } from "../math";
import type { StateWithholdingInput } from "../types";

export function californiaPit(input: { wagesCents: number; periods: number; withholding: StateWithholdingInput; supplemental: boolean }, t: TaxTables): { amountCents: number; trace: string[] } {
  const ca = t.states.CA.incomeTax;
  const status = normalizeCaStatus(input.withholding.filingStatus);
  const allowances = input.withholding.allowances;
  const extra = input.withholding.extraCents ?? 0;
  const key = status === "single" ? "single" : status === "hoh" ? "hoh" : allowances >= 2 ? "married_2plus" : "married_0_1";
  const annual = dec(input.wagesCents).times(input.periods);
  const trace: string[] = [];
  if (annual.lessThanOrEqualTo(ca.lowIncomeExemptionCents[key])) {
    trace.push(`CA PIT (Method B, annual): ${fmt(annual)} at or below the low income exemption ${fmt(ca.lowIncomeExemptionCents[key])}, withhold ${fmt(extra)}`);
    return { amountCents: extra, trace };
  }
  const estimated = dec(ca.estimatedDeductionPerAllowanceCents).times(input.withholding.additionalAllowances ?? 0);
  const std = ca.standardDeductionCents[key];
  const taxable = D.max(0, annual.minus(estimated).minus(std));
  const table = ca.tables[status];
  const { tax, row } = bracketTax(taxable, table);
  const credit = dec(ca.allowanceCreditCents).times(allowances);
  const annualTax = D.max(0, tax.minus(credit));
  const perPeriod = annualTax.dividedBy(input.periods).plus(extra);
  const cents = roundCents(perPeriod);
  trace.push(`CA PIT (Method B, annual): ${fmt(annual)} - est. deduction ${fmt(estimated)} - standard ${fmt(std)} = ${fmt(taxable)}; ${status} row over ${fmt(row.atLeastCents)}: ${fmt(row.baseCents)} + ${pct(row.rate)} x ${fmt(taxable.minus(row.atLeastCents))} = ${fmt(tax)}; - ${allowances} x ${fmt(ca.allowanceCreditCents)} credit = ${fmt(annualTax)}; / ${input.periods} = ${fmt(annualTax.dividedBy(input.periods))}${extra ? ` + extra ${fmt(extra)}` : ""} -> ${fmt(cents)}`);
  return { amountCents: cents, trace };
}

export function normalizeCaStatus(s: string | null): "single" | "married" | "hoh" {
  if (s === "married" || s === "mfj") return "married";
  if (s === "hoh") return "hoh";
  return "single";
}
