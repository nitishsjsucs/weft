// YTD ledger deltas (SPEC 6.2 ytd_ledger codes) from a paycheck's stored lines. Wage codes for capped taxes record the
// taxable (capped) wages, so a wage base is reached exactly once and SUI wages equal what the SUI rate applied to
// (the basis of a rate-change credit). The engine and the processed-run writer both use this one function.
import type { TaxCalcLine } from "./types";

export function ytdDeltasFromLines(input: { state: string; grossCents: number; taxes: TaxCalcLine[]; deductions: { code: string; amount_cents: number }[]; supplemental?: boolean }): Record<string, number> {
  const out: Record<string, number> = { gross: input.grossCents };
  const add = (k: string, v: number) => { out[k] = (out[k] ?? 0) + v; };
  const find = (code: string, payer: "employee" | "employer", j?: string) => input.taxes.find((x) => x.code === code && x.payer === payer && (!j || x.jurisdiction === j));
  const fit = find("fit", "employee", "US");
  if (fit) add("fit_wages", fit.taxable_wages_cents);
  const ss = find("ss", "employee", "US");
  if (ss) add("ss_wages", ss.taxable_wages_cents);
  const med = find("medicare", "employee", "US");
  if (med) add("medicare_wages", med.taxable_wages_cents);
  const futa = find("futa", "employer", "US");
  if (futa) add("futa_wages", futa.taxable_wages_cents);
  const st = input.state;
  const sui = find("sui", "employer", st);
  if (sui) add(`sui_wages:${st}`, sui.taxable_wages_cents);
  const pit = find("pit", "employee", st);
  if (pit) add(`state_pit_wages:${st}`, pit.taxable_wages_cents);
  const sdi = find("sdi", "employee", "CA");
  if (sdi) add("sdi_wages:CA", sdi.taxable_wages_cents);
  const pfl = find("pfl", "employee", "NY");
  if (pfl) add("pfl_wages:NY", pfl.taxable_wages_cents);
  const dbl = find("dbl", "employee", "NY");
  if (dbl) add("dbl_wages:NY", dbl.taxable_wages_cents);
  const famli = find("famli", "employee", "CO");
  if (famli) add("famli_wages:CO", famli.taxable_wages_cents);
  const k401 = input.deductions.filter((d) => d.code === "401k_traditional").reduce((s, d) => s + d.amount_cents, 0);
  if (k401) add("k401_deferral", k401);
  if (input.supplemental) add("supplemental", input.grossCents);
  for (const x of input.taxes) add(`tax:${x.jurisdiction}:${x.code}:${x.payer}`, x.amount_cents);
  return out;
}
