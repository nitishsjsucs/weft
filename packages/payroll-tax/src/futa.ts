// FUTA (research/domain.md 1.3): 6.0% less the 5.4% credit, 0.6% net on the first $7,000 per employee per year.
import type { TaxTables } from "./data/2026";
import { dec, fmt, pct, roundCents, underBase } from "./math";
import type { TaxCalcLine } from "./types";

/** FUTA 0.6% net on the first $7,000. Credit reduction is a year-end Form 940 item, never withheld per paycheck. */
export function futa(input: { futaWagesCents: number; ytdFutaWagesCents: number }, t: TaxTables): { line: TaxCalcLine; trace: string } {
  const f = t.federal.futa;
  const taxable = underBase(input.futaWagesCents, input.ytdFutaWagesCents, f.wageBaseCents);
  const amt = roundCents(dec(taxable).times(f.netRate));
  return {
    line: { code: "futa", jurisdiction: "US", payer: "employer", taxable_wages_cents: taxable, rate: f.netRate, amount_cents: amt },
    trace: `FUTA: ${fmt(taxable)} (YTD ${fmt(input.ytdFutaWagesCents)} of ${fmt(f.wageBaseCents)}) x ${pct(f.netRate)} = ${fmt(amt)}`,
  };
}
