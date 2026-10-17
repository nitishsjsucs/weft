// The filing rule table (wave 4 rank 1, research/wave3/agent-parity.md T2 and S2). Owner: w4-parity-compliance.
// One row per form Weft prepares, each with the agency page that states the form and its due date. Due dates are
// computed in code from the period, never from model text. When a due date falls on a Saturday or Sunday the agencies
// accept the return on the next business day (IRS Publication 15, "Saturday, Sunday or legal holiday"; CA EDD and NY
// DTF state the same for their delinquency dates); holidays beyond weekends are left to a later wave (left.md).
import type { FilingForm, FilingRule } from "@weft/contracts";

export interface FilingRuleRow extends FilingRule {
  /** The tax account (agency) that files it: a form is due only while that account is active. */
  accountAgency: "irs" | "ca_edd" | "ny_dtf" | "ny_dol" | "tx_twc" | "co_cdle" | "co_dor";
  /** Display name, e.g. "Form 941". */
  label: string;
  /** What the return reports, one line. */
  covers: string;
}

const lastDayOfMonthAfterQuarter = "the last day of the month after the quarter ends";

export const FILING_RULES: readonly FilingRuleRow[] = [
  { form: "941", agency: "IRS", jurisdiction: "US", cadence: "quarterly", dueRule: lastDayOfMonthAfterQuarter, appliesTo: "employees", accountAgency: "irs",
    sourceUrl: "https://www.irs.gov/forms-pubs/about-form-941", label: "Form 941", covers: "Federal income tax withheld and Social Security and Medicare taxes for the quarter" },
  { form: "940", agency: "IRS", jurisdiction: "US", cadence: "annual", dueRule: "January 31 of the next year", appliesTo: "employees", accountAgency: "irs",
    sourceUrl: "https://www.irs.gov/forms-pubs/about-form-940", label: "Form 940", covers: "Federal unemployment (FUTA) tax for the year" },
  { form: "w2_w3", agency: "IRS and SSA", jurisdiction: "US", cadence: "annual", dueRule: "January 31 of the next year", appliesTo: "employees", accountAgency: "irs",
    sourceUrl: "https://www.irs.gov/forms-pubs/about-form-w-2", label: "Forms W-2 and W-3", covers: "Each employee's wages and taxes for the year, with the W-3 transmittal totals" },
  { form: "1099_nec", agency: "IRS", jurisdiction: "US", cadence: "annual", dueRule: "January 31 of the next year", appliesTo: "contractors", accountAgency: "irs",
    sourceUrl: "https://www.irs.gov/forms-pubs/about-form-1099-nec", label: "Form 1099-NEC", covers: "Nonemployee compensation paid to each US contractor for the year" },
  { form: "ca_de9", agency: "CA EDD", jurisdiction: "CA", cadence: "quarterly", dueRule: lastDayOfMonthAfterQuarter, appliesTo: "employees", accountAgency: "ca_edd",
    sourceUrl: "https://edd.ca.gov/en/payroll_taxes/due_dates_and_delinquency_dates/", label: "CA DE 9", covers: "California UI, ETT and SDI contributions and PIT withheld for the quarter" },
  { form: "ca_de9c", agency: "CA EDD", jurisdiction: "CA", cadence: "quarterly", dueRule: lastDayOfMonthAfterQuarter, appliesTo: "employees", accountAgency: "ca_edd",
    sourceUrl: "https://edd.ca.gov/en/payroll_taxes/due_dates_and_delinquency_dates/", label: "CA DE 9C", covers: "Each California employee's subject wages and PIT wages and withholding for the quarter" },
  { form: "ny_nys45", agency: "NY DTF", jurisdiction: "NY", cadence: "quarterly", dueRule: lastDayOfMonthAfterQuarter, appliesTo: "employees", accountAgency: "ny_dtf",
    sourceUrl: "https://www.tax.ny.gov/pdf/current_forms/wt/nys45i.pdf", label: "NY NYS-45", covers: "New York withholding, wage reporting and unemployment insurance for the quarter" },
  { form: "tx_c3", agency: "TX TWC", jurisdiction: "TX", cadence: "quarterly", dueRule: lastDayOfMonthAfterQuarter, appliesTo: "employees", accountAgency: "tx_twc",
    sourceUrl: "https://www.twc.texas.gov/businesses/unemployment-tax-reports", label: "TX C-3", covers: "Texas wages and unemployment tax for the quarter" },
  { form: "co_uitr1", agency: "CO CDLE", jurisdiction: "CO", cadence: "quarterly", dueRule: lastDayOfMonthAfterQuarter, appliesTo: "employees", accountAgency: "co_cdle",
    sourceUrl: "https://cdle.colorado.gov/employers/unemployment-insurance-premiums", label: "CO UITR-1", covers: "Colorado wages and unemployment insurance premiums for the quarter" },
  { form: "co_dr1094", agency: "CO DOR", jurisdiction: "CO", cadence: "quarterly", dueRule: lastDayOfMonthAfterQuarter, appliesTo: "employees", accountAgency: "co_dor",
    sourceUrl: "https://tax.colorado.gov/withholding-tax-filing", label: "CO DR 1094", covers: "Colorado wage withholding for the period" },
];

export const RULE_BY_FORM: Readonly<Record<FilingForm, FilingRuleRow>> = Object.fromEntries(FILING_RULES.map((r) => [r.form, r])) as Record<FilingForm, FilingRuleRow>;
export const QUARTERLY_FORMS = FILING_RULES.filter((r) => r.cadence === "quarterly").map((r) => r.form);
export const ANNUAL_FORMS = FILING_RULES.filter((r) => r.cadence === "annual").map((r) => r.form);

const PERIOD_Q = /^(\d{4})-Q([1-4])$/;
const PERIOD_Y = /^(\d{4})$/;

/** "2026-Q3" or "2026" to its first and last day. */
export function periodBounds(period: string): { start: string; end: string } {
  const q = PERIOD_Q.exec(period);
  if (q) {
    const y = Number(q[1]), n = Number(q[2]);
    const m0 = (n - 1) * 3 + 1, m2 = m0 + 2;
    return { start: `${y}-${String(m0).padStart(2, "0")}-01`, end: lastDayOfMonth(y, m2) };
  }
  const a = PERIOD_Y.exec(period);
  if (a) return { start: `${a[1]}-01-01`, end: `${a[1]}-12-31` };
  throw new Error(`periodBounds: ${period}`);
}

export function isPeriodFor(form: FilingForm, period: string): boolean {
  return RULE_BY_FORM[form].cadence === "annual" ? PERIOD_Y.test(period) : PERIOD_Q.test(period);
}

/** The period a date falls in for a form's cadence ("2026-10-26" is "2026-Q4" quarterly, "2026" annual). */
export function periodOf(form: FilingForm, date: string): string {
  const y = date.slice(0, 4), m = Number(date.slice(5, 7));
  return RULE_BY_FORM[form].cadence === "annual" ? y : `${y}-Q${Math.ceil(m / 3)}`;
}

export function previousPeriod(period: string): string {
  const q = PERIOD_Q.exec(period);
  if (q) return Number(q[2]) === 1 ? `${Number(q[1]) - 1}-Q4` : `${q[1]}-Q${Number(q[2]) - 1}`;
  return String(Number(period) - 1);
}

function lastDayOfMonth(y: number, m: number): string {
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Saturday or Sunday moves to the next Monday. */
export function nextBusinessDay(date: string): string {
  const t = Date.parse(`${date}T12:00:00.000Z`);
  const dow = new Date(t).getUTCDay();
  const add = dow === 6 ? 2 : dow === 0 ? 1 : 0;
  return new Date(t + add * 86_400_000).toISOString().slice(0, 10);
}

/** The statutory date before the weekend rule: the last day of the month after a quarter, or January 31 after a year. */
export function statutoryDueOn(form: FilingForm, period: string): string {
  const { end } = periodBounds(period);
  const y = Number(end.slice(0, 4)), m = Number(end.slice(5, 7));
  if (RULE_BY_FORM[form].cadence === "annual") return `${y + 1}-01-31`;
  return m === 12 ? `${y + 1}-01-31` : lastDayOfMonth(y, m + 1);
}

export function dueOn(form: FilingForm, period: string): string {
  return nextBusinessDay(statutoryDueOn(form, period));
}

/** Monthly depositors deposit federal employment taxes by the 15th of the next month (IRS Publication 15, section 11). */
export const DEPOSIT_SOURCE_URL = "https://www.irs.gov/publications/p15";
export function monthlyDepositDueOn(month: string): string {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const next = m === 12 ? `${y + 1}-01-15` : `${y}-${String(m + 1).padStart(2, "0")}-15`;
  return nextBusinessDay(next);
}

export const dayNumber = (d: string) => Math.round(Date.parse(`${d}T12:00:00.000Z`) / 86_400_000);
export const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);
