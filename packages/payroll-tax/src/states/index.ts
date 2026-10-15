// State taxes for the P0 jurisdictions (SPEC 7.2): CA, NY, TX, CO. WA, IL and FL are stretch; MA is out.
import type { TaxTables } from "../data/2026";
import type { EmployerRateInput, StateWithholdingInput, TaxCalcLine, W4Input } from "../types";
import { dec, fmt, pct, roundCents, underBase } from "../math";
import { californiaPit } from "./ca";
import { newYorkDbl, newYorkPfl, newYorkPit } from "./ny";
import { coloradoPit } from "./co";

export interface StateInput {
  state: string; periods: number;
  wages: { state_pit: number; sui: number; sdi: number; pfl: number; dbl: number; famli: number };
  ytd: Record<string, number>; w4: W4Input; withholding: StateWithholdingInput;
  employerRates: { sui: EmployerRateInput | null; ett: EmployerRateInput | null };
  supplemental: boolean; collectNyDbl: boolean;
}
export interface StateResult { lines: TaxCalcLine[]; trace: string[] }

export const SUPPORTED_STATES = ["CA", "NY", "TX", "CO"] as const;

/** Employer-specific SUI (and CA ETT) from employer_tax_rates, effective at payday; CO FAMLI comes from the tables. */
function employerRateLine(state: string, code: "sui" | "ett", wages: number, ytdWages: number, r: EmployerRateInput | null, trace: string[]): TaxCalcLine | null {
  if (!r) { trace.push(`${state} ${code.toUpperCase()}: no employer rate on file, no line`); return null; }
  const taxable = underBase(wages, ytdWages, r.wageBaseCents);
  const amt = roundCents(dec(taxable).times(r.rate));
  trace.push(`${state} ${code.toUpperCase()}: ${fmt(taxable)} (YTD ${fmt(ytdWages)} of ${fmt(r.wageBaseCents)} base) x ${pct(r.rate)} = ${fmt(amt)} (employer rate on file)`);
  return { code, jurisdiction: state, payer: "employer", taxable_wages_cents: taxable, rate: r.rate, amount_cents: amt };
}

export function stateTaxes(s: StateInput, t: TaxTables): StateResult {
  const trace: string[] = [];
  const lines: TaxCalcLine[] = [];
  const ytdSui = s.ytd[`sui_wages:${s.state}`] ?? 0;
  const push = (l: TaxCalcLine | null) => { if (l) lines.push(l); };
  switch (s.state) {
    case "CA": {
      const pit = californiaPit({ wagesCents: s.wages.state_pit, periods: s.periods, withholding: s.withholding, supplemental: s.supplemental }, t);
      trace.push(...pit.trace);
      lines.push({ code: "pit", jurisdiction: "CA", payer: "employee", taxable_wages_cents: s.wages.state_pit, rate: null, amount_cents: pit.amountCents });
      const sdi = t.states.CA.sdi;
      const sdiAmt = roundCents(dec(s.wages.sdi).times(sdi.employeeRate));
      trace.push(`CA SDI: ${fmt(s.wages.sdi)} x ${pct(sdi.employeeRate)} (no wage cap) = ${fmt(sdiAmt)}`);
      lines.push({ code: "sdi", jurisdiction: "CA", payer: "employee", taxable_wages_cents: s.wages.sdi, rate: sdi.employeeRate, amount_cents: sdiAmt });
      push(employerRateLine("CA", "sui", s.wages.sui, ytdSui, s.employerRates.sui, trace));
      push(employerRateLine("CA", "ett", s.wages.sui, ytdSui, s.employerRates.ett, trace));
      break;
    }
    case "NY": {
      const pit = newYorkPit({ wagesCents: s.wages.state_pit, periods: s.periods, withholding: s.withholding, supplemental: s.supplemental }, t);
      trace.push(...pit.trace);
      lines.push({ code: "pit", jurisdiction: "NY", payer: "employee", taxable_wages_cents: s.wages.state_pit, rate: null, amount_cents: pit.amountCents });
      const pfl = newYorkPfl({ wagesCents: s.wages.pfl, ytdPflCents: s.ytd["tax:NY:pfl:employee"] ?? 0 }, t);
      trace.push(pfl.trace);
      lines.push(pfl.line);
      if (s.collectNyDbl) {
        const dbl = newYorkDbl({ wagesCents: s.wages.dbl, periods: s.periods }, t);
        trace.push(dbl.trace);
        lines.push(dbl.line);
      }
      push(employerRateLine("NY", "sui", s.wages.sui, ytdSui, s.employerRates.sui, trace));
      break;
    }
    case "TX": {
      trace.push("TX: no state income tax and no employee payroll tax");
      push(employerRateLine("TX", "sui", s.wages.sui, ytdSui, s.employerRates.sui, trace));
      break;
    }
    case "CO": {
      const pit = coloradoPit({ wagesCents: s.wages.state_pit, periods: s.periods, w4: s.w4, withholding: s.withholding }, t);
      trace.push(...pit.trace);
      lines.push({ code: "pit", jurisdiction: "CO", payer: "employee", taxable_wages_cents: s.wages.state_pit, rate: t.states.CO.incomeTax.rate, amount_cents: pit.amountCents });
      const f = t.states.CO.famli;
      const ytdFamli = s.ytd["famli_wages:CO"] ?? 0;
      const taxable = underBase(s.wages.famli, ytdFamli, f.wageBaseCents);
      const ee = roundCents(dec(taxable).times(f.employeeRate));
      const er = roundCents(dec(taxable).times(f.employerRate));
      trace.push(`CO FAMLI: ${fmt(taxable)} (YTD ${fmt(ytdFamli)} of ${fmt(f.wageBaseCents)}) x ${pct(f.employeeRate)} = ${fmt(ee)} employee, ${fmt(er)} employer (statewide, from TAX_2026)`);
      lines.push({ code: "famli", jurisdiction: "CO", payer: "employee", taxable_wages_cents: taxable, rate: f.employeeRate, amount_cents: ee });
      lines.push({ code: "famli", jurisdiction: "CO", payer: "employer", taxable_wages_cents: taxable, rate: f.employerRate, amount_cents: er });
      push(employerRateLine("CO", "sui", s.wages.sui, ytdSui, s.employerRates.sui, trace));
      break;
    }
    default:
      throw new Error(`payroll-tax: work state ${s.state} is not supported in ${t.version} (P0: CA, NY, TX, CO)`);
  }
  return { lines, trace };
}
