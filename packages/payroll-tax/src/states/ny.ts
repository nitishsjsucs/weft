// New York: NYS-50-T-NYS (1/26) Method II exact calculation (research/domain.md 2.2), PFL and DBL.
// Per-period tables are the annual schedules divided by the periods per year: breakpoints to whole dollars and
// add amounts to cents (half up). That derivation reproduces the published biweekly single table II-B row for row
// (checked in the golden tests). Table A for 0 exemptions is the published value where we have it (biweekly) and
// otherwise annual / periods to the nearest $0.10, which also reproduces the published biweekly values.
// Recapture rows are encoded as data and never "fixed".
import type { Bracket, TaxTables } from "../data/2026";
import { D, dec, fmt, pct, roundCents } from "../math";
import type { StateWithholdingInput, TaxCalcLine } from "../types";

export interface PeriodRow { atLeastCents: number; addCents: number; rate: string }

export function nyPeriodTable(annual: Bracket[], periods: number): PeriodRow[] {
  return annual.map((r) => ({
    atLeastCents: roundCents(dec(r.atLeastCents).dividedBy(periods).dividedBy(100)) * 100,
    addCents: roundCents(dec(r.baseCents).dividedBy(periods)),
    rate: r.rate,
  }));
}

export function nyTableA(status: "single" | "married", exemptions: number, periods: number, t: TaxTables): number {
  const ny = t.states.NY.incomeTax;
  const published = ny.tableAPublishedCents[periods]?.[status];
  const base = published ?? roundCents(dec(ny.annualAllowanceCents[status]).dividedBy(periods).dividedBy(10)) * 10;
  const perExemption = ny.tableCExemptionCents[periods] ?? roundCents(dec(ny.annualAllowanceCents.perExemption).dividedBy(periods));
  return base + perExemption * exemptions;
}

export function newYorkPit(input: { wagesCents: number; periods: number; withholding: StateWithholdingInput; supplemental: boolean }, t: TaxTables): { amountCents: number; trace: string[] } {
  const ny = t.states.NY.incomeTax;
  const extra = input.withholding.extraCents ?? 0;
  if (input.supplemental) {
    const amt = roundCents(dec(input.wagesCents).times(ny.supplementalRate));
    return { amountCents: amt, trace: [`NY PIT supplemental: ${fmt(input.wagesCents)} x ${pct(ny.supplementalRate)} = ${fmt(amt)}`] };
  }
  const status = input.withholding.filingStatus === "married" || input.withholding.filingStatus === "mfj" ? "married" : "single";
  const exemptions = input.withholding.allowances;
  const trace: string[] = [];
  if (dec(input.wagesCents).times(input.periods).greaterThanOrEqualTo(ny.methodIIIThresholdCents)) {
    trace.push(`NY PIT: annualized wages at or above ${fmt(ny.methodIIIThresholdCents)}; Method III is not modeled in ${t.version}, using Method II`);
  }
  const tableA = nyTableA(status, exemptions, input.periods, t);
  const net = D.max(0, dec(input.wagesCents).minus(tableA));
  const table = nyPeriodTable(ny.tables[status], input.periods);
  let row = table[0]!;
  for (const r of table) if (net.greaterThanOrEqualTo(r.atLeastCents)) row = r;
  const tax = net.isZero() ? dec(0) : net.minus(row.atLeastCents).times(row.rate).plus(row.addCents);
  const cents = roundCents(tax.plus(extra));
  trace.push(`NY PIT (Method II, ${input.periods}/yr): ${fmt(input.wagesCents)} - Table A ${status} ${exemptions} = ${fmt(tableA)} -> net ${fmt(net)}; row ${fmt(row.atLeastCents)}: (${fmt(net)} - ${fmt(row.atLeastCents)}) x ${pct(row.rate)} + ${fmt(row.addCents)} = ${fmt(tax)}${extra ? ` + extra ${fmt(extra)}` : ""} -> ${fmt(cents)}`);
  return { amountCents: cents, trace };
}

/** PFL 0.432% of gross, capped at $411.91 a year through the YTD PFL amount. */
export function newYorkPfl(input: { wagesCents: number; ytdPflCents: number }, t: TaxTables): { line: TaxCalcLine; trace: string } {
  const p = t.states.NY.pfl;
  const raw = roundCents(dec(input.wagesCents).times(p.employeeRate));
  const room = Math.max(0, p.annualMaxCents - input.ytdPflCents);
  const amt = Math.min(raw, room);
  return {
    line: { code: "pfl", jurisdiction: "NY", payer: "employee", taxable_wages_cents: input.wagesCents, rate: p.employeeRate, amount_cents: amt },
    trace: `NY PFL: ${fmt(input.wagesCents)} x ${pct(p.employeeRate)} = ${fmt(raw)}${amt < raw ? `, capped by the ${fmt(p.annualMaxCents)} annual max (YTD ${fmt(input.ytdPflCents)})` : ""} -> ${fmt(amt)}`,
  };
}

/** DBL 0.5% up to $0.60 a week; the per-period cap is 0.60 x 52 / periods ($1.30 semi-monthly, simplified). */
export function nyDblPeriodCapCents(periods: number, t: TaxTables): number {
  return roundCents(dec(t.states.NY.dbl.weeklyMaxCents).times(52).dividedBy(periods));
}

export function newYorkDbl(input: { wagesCents: number; periods: number }, t: TaxTables): { line: TaxCalcLine; trace: string } {
  const d = t.states.NY.dbl;
  const raw = roundCents(dec(input.wagesCents).times(d.employeeRate));
  const cap = nyDblPeriodCapCents(input.periods, t);
  const amt = Math.min(raw, cap);
  return {
    line: { code: "dbl", jurisdiction: "NY", payer: "employee", taxable_wages_cents: input.wagesCents, rate: d.employeeRate, amount_cents: amt },
    trace: `NY DBL: ${fmt(input.wagesCents)} x ${pct(d.employeeRate)} = ${fmt(raw)}, per-period cap ${fmt(cap)} (${d.simplified}) -> ${fmt(amt)}`,
  };
}
