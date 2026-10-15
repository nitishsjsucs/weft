// Federal income tax withholding: Pub 15-T 2026 Worksheet 1A, percentage method for automated systems
// (research/domain.md 1.1). 2020+ and pre-2020 paths, Step 2 checkbox tables, Steps 3 and 4. Exact decimals,
// one half-up rounding at the end (line 4b).
import type { TaxTables } from "./data/2026";
import { bracketTax, D, dec, fmt, pct, roundCents } from "./math";
import type { W4Input } from "./types";

export interface FitResult { amountCents: number; trace: string[] }

export function federalIncomeTax(input: { fitWagesCents: number; periods: number; w4: W4Input; supplemental: boolean; ytdSupplementalCents: number }, t: TaxTables): FitResult {
  const { fitWagesCents: wages, periods, w4 } = input;
  const fit = t.federal.fit;
  if (w4.exempt) return { amountCents: 0, trace: ["FIT: W-4 claims exemption, withhold 0.00"] };
  if (input.supplemental) {
    // Optional flat 22%; mandatory 37% on supplemental wages over $1,000,000 in the year.
    const room = Math.max(0, fit.supplemental.thresholdCents - input.ytdSupplementalCents);
    const atFlat = Math.min(wages, room);
    const over = wages - atFlat;
    const amt = dec(atFlat).times(fit.supplemental.flatRate).plus(dec(over).times(fit.supplemental.over1mRate));
    const cents = roundCents(amt);
    return { amountCents: cents, trace: [`FIT supplemental: ${fmt(atFlat)} x ${pct(fit.supplemental.flatRate)}${over > 0 ? ` + ${fmt(over)} x ${pct(fit.supplemental.over1mRate)}` : ""} = ${fmt(amt)} -> ${fmt(cents)}`] };
  }
  const trace: string[] = [];
  const line1c = dec(wages).times(periods);
  let adjusted: InstanceType<typeof D>;
  let status: "mfj" | "single" | "hoh";
  let table;
  if (w4.version === "pre2020") {
    // Pre-2020 W-4: allowances x $4,300, no line 1g, STANDARD schedules, never the HOH table.
    const line1k = dec(fit.pre2020AllowanceCents).times(w4.allowances);
    adjusted = D.max(0, line1c.minus(line1k));
    status = w4.filingStatus === "mfj" ? "mfj" : "single";
    table = fit.tables.standard[status];
    trace.push(`FIT (pre-2020 W-4): 1a ${fmt(wages)} x ${periods} = ${fmt(line1c)}; 1k ${w4.allowances} x ${fmt(fit.pre2020AllowanceCents)} = ${fmt(line1k)}; 1l ${fmt(adjusted)}`);
  } else {
    const line1e = line1c.plus(w4.step4aCents);
    const line1g = w4.step2Checkbox ? 0 : fit.line1gStandardCents[w4.filingStatus];
    const line1h = dec(w4.step4bCents).plus(line1g);
    adjusted = D.max(0, line1e.minus(line1h));
    status = w4.filingStatus;
    table = w4.step2Checkbox ? fit.tables.step2Checkbox[status] : fit.tables.standard[status];
    trace.push(`FIT (2020+ W-4): 1a ${fmt(wages)} x ${periods} = ${fmt(line1c)}; 1d ${fmt(w4.step4aCents)}; 1g ${fmt(line1g)}${w4.step2Checkbox ? " (Step 2 checked)" : ""}; 1f ${fmt(w4.step4bCents)}; 1i ${fmt(adjusted)}`);
  }
  const { tax: tentativeAnnual, row } = bracketTax(adjusted, table);
  const line2h = tentativeAnnual.dividedBy(periods);
  trace.push(`FIT: ${w4.step2Checkbox && w4.version === "2020" ? "checkbox" : "standard"} ${status} row ${fmt(row.atLeastCents)}: ${fmt(row.baseCents)} + ${pct(row.rate)} x ${fmt(adjusted.minus(row.atLeastCents))} = ${fmt(tentativeAnnual)}; / ${periods} = ${fmt(line2h)}`);
  const line3b = w4.version === "2020" ? dec(w4.step3Cents).dividedBy(periods) : dec(0);
  const line3c = D.max(0, line2h.minus(line3b));
  const line4b = line3c.plus(w4.step4cCents);
  const cents = roundCents(line4b);
  trace.push(`FIT: 3b credits ${fmt(line3b)}; 3c ${fmt(line3c)}; 4a extra ${fmt(w4.step4cCents)}; 4b ${fmt(line4b)} -> ${fmt(cents)}`);
  return { amountCents: cents, trace };
}
