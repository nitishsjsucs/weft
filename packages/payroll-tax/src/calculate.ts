// calculatePaycheck (SPEC 7.2): pure, no I/O, integer cents, each per-period tax line rounded once, half up.
// Taxable wages per tax are computed before any tax, from the explicit reduces sets in data/2026.ts (SPEC 7.1).
import { TAX_2026, WAGE_BASES, type TaxTables, type WageBase } from "./data/2026";
import { federalIncomeTax } from "./federal";
import { fica } from "./fica";
import { futa } from "./futa";
import { fmt } from "./math";
import { stateTaxes } from "./states/index";
import type { PaycheckCalc, PaycheckInput, TaxCalcLine } from "./types";

function assertCents(label: string, v: number): void {
  if (!Number.isSafeInteger(v)) throw new Error(`payroll-tax: ${label} must be integer cents, got ${v}`);
}

export function taxableWages(gross: number, pretax: PaycheckInput["pretax"], t: TaxTables): Record<WageBase, number> {
  const out = Object.fromEntries(WAGE_BASES.map((b) => [b, gross])) as Record<WageBase, number>;
  for (const d of pretax) {
    const rule = t.pretax[d.code];
    if (!rule) throw new Error(`payroll-tax: unknown pre-tax deduction code ${d.code}`);
    for (const b of rule.reduces) out[b] -= d.amount_cents;
  }
  for (const b of WAGE_BASES) if (out[b] < 0) out[b] = 0;
  return out;
}

export function calculatePaycheck(input: PaycheckInput, tables: TaxTables = TAX_2026): PaycheckCalc {
  const t = tables;
  const periods = input.payPeriodsPerYear;
  if (!Number.isInteger(periods) || periods <= 0) throw new Error(`payroll-tax: bad payPeriodsPerYear ${periods}`);
  for (const e of input.earnings) assertCents(`earning ${e.type}`, e.amount_cents);
  for (const d of [...input.pretax, ...input.posttax]) assertCents(`deduction ${d.code}`, d.amount_cents);
  assertCents("reimbursements", input.reimbursements_cents);
  const ytd = (k: string) => input.ytd[k] ?? 0;
  const state = input.jurisdiction;
  const supplemental = input.supplemental ?? false;

  const gross = input.earnings.reduce((s, e) => s + e.amount_cents, 0);
  const pretaxTotal = input.pretax.reduce((s, d) => s + d.amount_cents, 0);
  const posttaxTotal = input.posttax.reduce((s, d) => s + d.amount_cents, 0);
  const w = taxableWages(gross, input.pretax, t);
  const trace: string[] = [`Gross ${fmt(gross)}; tables ${t.version} (${t.label}); pay date ${input.payDate}`];
  if (input.pretax.length) {
    trace.push(`Taxable wages: ${input.pretax.map((d) => `${d.code} ${fmt(d.amount_cents)} reduces ${t.pretax[d.code]!.reduces.join(", ") || "nothing"}`).join("; ")} (state income tax and SUI treatment is a modeling choice, SPEC 7.1)`);
  }

  const taxes: TaxCalcLine[] = [];
  const fit = federalIncomeTax({ fitWagesCents: w.fit, periods, w4: input.w4, supplemental, ytdSupplementalCents: ytd("supplemental") }, t);
  taxes.push({ code: "fit", jurisdiction: "US", payer: "employee", taxable_wages_cents: w.fit, rate: null, amount_cents: fit.amountCents });
  trace.push(...fit.trace);
  const f = fica({ ssWagesCents: w.ss, medicareWagesCents: w.medicare, ytdSsWagesCents: ytd("ss_wages"), ytdMedicareWagesCents: ytd("medicare_wages") }, t);
  taxes.push(...f.lines);
  trace.push(...f.trace);
  const fu = futa({ futaWagesCents: w.futa, ytdFutaWagesCents: ytd("futa_wages") }, t);
  taxes.push(fu.line);
  trace.push(fu.trace);
  const st = stateTaxes({
    state, periods, ytd: input.ytd, w4: input.w4, withholding: input.state, employerRates: input.employerRates, supplemental,
    wages: { state_pit: w.state_pit, sui: w.sui, sdi: w.sdi, pfl: w.pfl, dbl: w.dbl, famli: w.famli },
    collectNyDbl: input.collectNyDbl ?? true,
  }, t);
  taxes.push(...st.lines);
  trace.push(...st.trace);

  const employeeTaxes = taxes.filter((x) => x.payer === "employee").reduce((s, x) => s + x.amount_cents, 0);
  const employerTaxes = taxes.filter((x) => x.payer === "employer").reduce((s, x) => s + x.amount_cents, 0);
  const net = gross - employeeTaxes - pretaxTotal - posttaxTotal;
  trace.push(`Net ${fmt(gross)} - employee taxes ${fmt(employeeTaxes)} - pre-tax ${fmt(pretaxTotal)} - post-tax ${fmt(posttaxTotal)} = ${fmt(net)} (reimbursements ${fmt(input.reimbursements_cents)} paid on top)`);

  const ytdDeltas: Record<string, number> = {
    gross, fit_wages: w.fit, ss_wages: w.ss, medicare_wages: w.medicare, futa_wages: w.futa,
    [`sui_wages:${state}`]: w.sui, [`state_pit_wages:${state}`]: w.state_pit,
  };
  if (state === "CA") ytdDeltas["sdi_wages:CA"] = w.sdi;
  if (state === "NY") { ytdDeltas["pfl_wages:NY"] = w.pfl; ytdDeltas["dbl_wages:NY"] = w.dbl; }
  if (state === "CO") ytdDeltas["famli_wages:CO"] = w.famli;
  const k401 = input.pretax.filter((d) => d.code === "401k_traditional").reduce((s, d) => s + d.amount_cents, 0);
  if (k401) ytdDeltas.k401_deferral = k401;
  if (supplemental) ytdDeltas.supplemental = gross;
  for (const x of taxes) {
    const k = `tax:${x.jurisdiction}:${x.code}:${x.payer}`;
    ytdDeltas[k] = (ytdDeltas[k] ?? 0) + x.amount_cents;
  }

  return {
    gross_cents: gross, taxableWages: { ...w }, taxes,
    employee_deductions_cents: pretaxTotal + posttaxTotal,
    employee_taxes_cents: employeeTaxes, employer_taxes_cents: employerTaxes, pretax_cents: pretaxTotal, posttax_cents: posttaxTotal,
    net_cents: net, ytdDeltas, trace,
  };
}
