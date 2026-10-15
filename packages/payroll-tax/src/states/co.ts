// Colorado PIT: DR 1098 (2026) worksheet, 4.40% flat after the annual allowance (research/domain.md 2.8).
import type { TaxTables } from "../data/2026";
import { D, dec, fmt, pct, roundCents } from "../math";
import type { StateWithholdingInput, W4Input } from "../types";

export function coloradoPit(input: { wagesCents: number; periods: number; w4: W4Input; withholding: StateWithholdingInput }, t: TaxTables): { amountCents: number; trace: string[] } {
  const co = t.states.CO.incomeTax;
  const override = input.withholding.allowanceOverrideCents ?? null;
  const allowance = override ?? (input.w4.filingStatus === "mfj" ? co.allowanceCents.mfj : co.allowanceCents.other);
  const annual = dec(input.wagesCents).times(input.periods);
  const line2b = D.max(0, annual.minus(allowance));
  const line2c = line2b.times(co.rate);
  const line2d = line2c.dividedBy(input.periods);
  const extra = input.withholding.extraCents ?? 0;
  const cents = roundCents(line2d.plus(extra));
  return {
    amountCents: cents,
    trace: [`CO PIT (DR 1098): ${fmt(annual)} - allowance ${fmt(allowance)}${override !== null ? " (DR 0004)" : ""} = ${fmt(line2b)}; x ${pct(co.rate)} = ${fmt(line2c)}; / ${input.periods} = ${fmt(line2d)}${extra ? ` + extra ${fmt(extra)}` : ""} -> ${fmt(cents)}`],
  };
}
