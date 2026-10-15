// FICA (research/domain.md 1.2): Social Security 6.2% each to $184,500 via YTD, Medicare 1.45% each with no cap,
// Additional Medicare 0.9% employee only on wages over $200,000 in the calendar year, regardless of filing status.
import type { TaxTables } from "./data/2026";
import { dec, fmt, pct, roundCents, underBase } from "./math";
import type { TaxCalcLine } from "./types";

export function fica(input: { ssWagesCents: number; medicareWagesCents: number; ytdSsWagesCents: number; ytdMedicareWagesCents: number }, t: TaxTables): { lines: TaxCalcLine[]; trace: string[] } {
  const ss = t.federal.socialSecurity;
  const med = t.federal.medicare;
  const ssTaxable = underBase(input.ssWagesCents, input.ytdSsWagesCents, ss.wageBaseCents);
  const ssEe = roundCents(dec(ssTaxable).times(ss.employeeRate));
  const ssEr = roundCents(dec(ssTaxable).times(ss.employerRate));
  const medEe = roundCents(dec(input.medicareWagesCents).times(med.employeeRate));
  const medEr = roundCents(dec(input.medicareWagesCents).times(med.employerRate));
  const before = Math.max(0, input.ytdMedicareWagesCents - med.additionalThresholdCents);
  const after = Math.max(0, input.ytdMedicareWagesCents + input.medicareWagesCents - med.additionalThresholdCents);
  const addlWages = after - before;
  const addl = roundCents(dec(addlWages).times(med.additionalRate));
  const lines: TaxCalcLine[] = [
    { code: "ss", jurisdiction: "US", payer: "employee", taxable_wages_cents: ssTaxable, rate: ss.employeeRate, amount_cents: ssEe },
    { code: "medicare", jurisdiction: "US", payer: "employee", taxable_wages_cents: input.medicareWagesCents, rate: med.employeeRate, amount_cents: medEe },
  ];
  if (addlWages > 0) lines.push({ code: "medicare_additional", jurisdiction: "US", payer: "employee", taxable_wages_cents: addlWages, rate: med.additionalRate, amount_cents: addl });
  lines.push(
    { code: "ss", jurisdiction: "US", payer: "employer", taxable_wages_cents: ssTaxable, rate: ss.employerRate, amount_cents: ssEr },
    { code: "medicare", jurisdiction: "US", payer: "employer", taxable_wages_cents: input.medicareWagesCents, rate: med.employerRate, amount_cents: medEr },
  );
  const trace = [
    `SS: ${fmt(ssTaxable)} (YTD ${fmt(input.ytdSsWagesCents)} of ${fmt(ss.wageBaseCents)} base) x ${pct(ss.employeeRate)} = ${fmt(ssEe)} each side`,
    `Medicare: ${fmt(input.medicareWagesCents)} x ${pct(med.employeeRate)} = ${fmt(medEe)} each side${addlWages > 0 ? `; Additional Medicare ${fmt(addlWages)} over ${fmt(med.additionalThresholdCents)} x ${pct(med.additionalRate)} = ${fmt(addl)} (employee only)` : ""}`,
  ];
  return { lines, trace };
}
