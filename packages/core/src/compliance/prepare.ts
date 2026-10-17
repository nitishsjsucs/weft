// Filing preparation from processed payroll (wave 4 rank 1). Owner: w4-parity-compliance. Pure integer cents.
// Quarterly returns read the paychecks of processed runs whose payday falls in the quarter (wages are reported when
// paid). Annual returns read the YTD ledger, which holds the previous provider's import plus every Weft run, so the
// year is complete. Nothing here calls a model; every number traces to a paycheck tax line or a ledger row.
//
// Form 941 lines (IRS Form 941 instructions): 1 employees in the pay period that includes the 12th of the quarter's
// third month; 2 wages (federal income tax wages); 3 federal income tax withheld; 5a and 5c taxable Social Security
// and Medicare wages times 12.4% and 2.9%; 5d Additional Medicare wages times 0.9%; 5e their sum; 6 = 3 + 5e;
// 7 the fractions of cents adjustment (what was actually withheld and owed, less 5e, because each paycheck rounds);
// 10 = 6 + 7; 12 = 10 (no credits); 13 deposits; 14 balance due or 15 overpayment; 16 the liability by month.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { FilingForm } from "@weft/contracts";
import { contractorPayments, paychecks, payrollRuns, taxAccounts, workers, ytdLedger, type DbTx } from "@weft/db";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import { mulRateCents } from "../demo/define";
import { displayName } from "../people/names";
import { dueOn, periodBounds, RULE_BY_FORM } from "./rules";

export interface PreparedLine { line: string; label: string; cents: number | null; count: number | null }
export interface PreparedEmployee { worker_id: string; name: string; [k: string]: string | number | null }
export interface PreparedFiling {
  form: FilingForm; period: string; period_start: string; period_end: string; due_on: string;
  tax_account_id: string | null; account_number: string | null; agency: string; jurisdiction: string; source_url: string;
  /** Processed runs read (quarterly) or the ledger sources (annual). */
  runs: string[]; coverage: string;
  lines: PreparedLine[]; employees: PreparedEmployee[];
  total_due_cents: number; deposits_cents: number; balance_due_cents: number;
  prepared_hash: string;
}

const line = (l: string, label: string, cents: number | null, count: number | null = null): PreparedLine => ({ line: l, label, cents, count });

interface TaxLineJson { code: string; jurisdiction: string; payer: string; taxable_wages_cents: number; amount_cents: number }
const taxesOf = (json: unknown): TaxLineJson[] => {
  try { const v = typeof json === "string" ? JSON.parse(json) : json; return Array.isArray(v) ? (v as TaxLineJson[]) : []; } catch { return []; }
};

interface QuarterPay { runs: (typeof payrollRuns.$inferSelect)[]; checks: (typeof paychecks.$inferSelect & { payday: string; periodStart: string; periodEnd: string })[] }

/** Processed runs with a payday in [start, end] and their paychecks (excluded paychecks are not paid). */
async function quarterPay(tx: DbTx, companyId: string, start: string, end: string): Promise<QuarterPay> {
  const runs = (await tx.select().from(payrollRuns).where(and(eq(payrollRuns.companyId, companyId), eq(payrollRuns.status, "processed"))).orderBy(asc(payrollRuns.payday), asc(payrollRuns.id)))
    .filter((r) => r.payday >= start && r.payday <= end);
  if (!runs.length) return { runs, checks: [] };
  const byRun = new Map(runs.map((r) => [r.id, r]));
  const checks = (await tx.select().from(paychecks).where(inArray(paychecks.payrollRunId, runs.map((r) => r.id))).orderBy(asc(paychecks.id)))
    .filter((p) => p.status !== "excluded")
    .map((p) => { const r = byRun.get(p.payrollRunId)!; return { ...p, payday: r.payday, periodStart: r.periodStart, periodEnd: r.periodEnd }; });
  return { runs, checks };
}

function sum(checks: QuarterPay["checks"], f: (t: TaxLineJson) => boolean, pick: "amount_cents" | "taxable_wages_cents"): number {
  let s = 0;
  for (const p of checks) for (const t of taxesOf(p.taxesJson)) if (f(t)) s += t[pick];
  return s;
}
const is = (code: string, jurisdiction: string, payer?: string) => (t: TaxLineJson) => t.code === code && t.jurisdiction === jurisdiction && (payer === undefined || t.payer === payer);

/** Employees paid in the pay period that includes the 12th of `month` (YYYY-MM), or null when no Weft run covers it. */
function countOnThe12th(q: QuarterPay, month: string, filter: (p: QuarterPay["checks"][number]) => boolean = () => true): number | null {
  const d = `${month}-12`;
  const run = q.runs.find((r) => r.periodStart <= d && r.periodEnd >= d);
  if (!run) return null;
  return new Set(q.checks.filter((p) => p.payrollRunId === run.id && filter(p)).map((p) => p.workerId)).size;
}

async function account(tx: DbTx, companyId: string, agency: string) {
  const [a] = await tx.select().from(taxAccounts).where(and(eq(taxAccounts.companyId, companyId), eq(taxAccounts.agency, agency))).limit(1);
  return a ?? null;
}

async function names(tx: DbTx, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await tx.select({ id: workers.id, first: workers.firstName, last: workers.lastName }).from(workers).where(inArray(workers.id, ids));
  return new Map(rows.map((w) => [w.id, displayName(w.first, w.last)]));
}

function finish(base: Omit<PreparedFiling, "prepared_hash">): PreparedFiling {
  return { ...base, prepared_hash: sha256Hex(canonicalJson({ form: base.form, period: base.period, runs: base.runs, lines: base.lines, employees: base.employees })) };
}

const monthsOf = (start: string) => [0, 1, 2].map((i) => { const m = Number(start.slice(5, 7)) + i; return `${start.slice(0, 4)}-${String(m).padStart(2, "0")}`; });
const coverageQuarter = (runs: string[], start: string) => runs.length
  ? `Weft processed runs paid in the quarter: ${runs.join(", ")}.${start < "2026-09-01" ? " Pay before 2026-09-01 ran through the previous provider (the YTD import holds it as one year-to-date total, not by quarter), so reconcile those months with that provider's records before filing." : ""}`
  : "No processed Weft run was paid in this quarter.";

// ---------------------------------------------------------------- Form 941

export async function prepare941(tx: DbTx, companyId: string, period: string): Promise<PreparedFiling> {
  const { start, end } = periodBounds(period);
  const q = await quarterPay(tx, companyId, start, end);
  const acct = await account(tx, companyId, "irs");
  const c = q.checks;
  const months = monthsOf(start);
  const employees = countOnThe12th(q, months[2]!);
  const wages = sum(c, is("fit", "US", "employee"), "taxable_wages_cents");
  const fit = sum(c, is("fit", "US", "employee"), "amount_cents");
  const ssWages = sum(c, is("ss", "US", "employee"), "taxable_wages_cents");
  const medWages = sum(c, is("medicare", "US", "employee"), "taxable_wages_cents");
  const addlWages = sum(c, is("medicare_addl", "US", "employee"), "taxable_wages_cents");
  const ss = mulRateCents(ssWages, "0.124"), med = mulRateCents(medWages, "0.029"), addl = mulRateCents(addlWages, "0.009");
  const l5e = ss + med + addl;
  const l6 = fit + l5e;
  const actualFica = sum(c, (t) => t.jurisdiction === "US" && (t.code === "ss" || t.code === "medicare" || t.code === "medicare_addl"), "amount_cents");
  const l7 = actualFica - l5e;
  const l10 = l6 + l7;
  const l12 = l10;
  // The simulator remits each run's federal taxes when the run settles, so deposits are the run liabilities.
  const federal = (t: TaxLineJson) => t.jurisdiction === "US" && ["fit", "ss", "medicare", "medicare_addl"].includes(t.code);
  const deposits = sum(c, federal, "amount_cents");
  const monthly = months.map((m) => sum(c.filter((p) => p.payday.startsWith(m)), federal, "amount_cents"));
  const lines = [
    line("1", `Employees paid in the pay period including ${months[2]}-12`, null, employees),
    line("2", "Wages, tips and other compensation", wages),
    line("3", "Federal income tax withheld", fit),
    line("5a.1", "Taxable Social Security wages", ssWages), line("5a.2", "Social Security tax (12.4%)", ss),
    line("5c.1", "Taxable Medicare wages", medWages), line("5c.2", "Medicare tax (2.9%)", med),
    line("5d.1", "Wages subject to Additional Medicare Tax", addlWages), line("5d.2", "Additional Medicare Tax (0.9%)", addl),
    line("5e", "Total Social Security and Medicare taxes", l5e),
    line("6", "Total taxes before adjustments", l6),
    line("7", "Adjustment for fractions of cents", l7),
    line("10", "Total taxes after adjustments", l10),
    line("12", "Total taxes after adjustments and credits", l12),
    line("13", "Total deposits for this quarter", deposits),
    line("14", "Balance due", Math.max(l12 - deposits, 0)),
    line("15", "Overpayment", Math.max(deposits - l12, 0)),
    ...months.map((m, i) => line(`16.${i + 1}`, `Tax liability, ${m}`, monthly[i]!)),
    line("16.total", "Total liability for the quarter", monthly.reduce((a, b) => a + b, 0)),
  ];
  return finish({
    form: "941", period, period_start: start, period_end: end, due_on: dueOn("941", period), tax_account_id: acct?.id ?? null, account_number: acct?.accountNumber ?? null,
    agency: "irs", jurisdiction: "US", source_url: RULE_BY_FORM["941"].sourceUrl, runs: q.runs.map((r) => r.id), coverage: coverageQuarter(q.runs.map((r) => r.id), start),
    lines, employees: [], total_due_cents: l12, deposits_cents: deposits, balance_due_cents: l12 - deposits,
  });
}

// ---------------------------------------------------------------- state wage reports

const STATE_FORMS: Partial<Record<FilingForm, { state: string; agency: string; perEmployee: boolean }>> = {
  ca_de9: { state: "CA", agency: "ca_edd", perEmployee: false }, ca_de9c: { state: "CA", agency: "ca_edd", perEmployee: true },
  ny_nys45: { state: "NY", agency: "ny_dtf", perEmployee: true }, tx_c3: { state: "TX", agency: "tx_twc", perEmployee: true },
  co_uitr1: { state: "CO", agency: "co_cdle", perEmployee: true },
};

/**
 * Quarterly state wage and contribution report. Per employee: gross pay, subject wages (CA: SDI wages, which have no
 * wage limit, so they equal UI subject wages; other states: gross pay), state income tax wages and withholding, UI
 * taxable wages, and the contributions. CA DE 9 is the totals; DE 9C, NYS-45, C-3 and UITR-1 also list employees.
 */
export async function prepareStateReport(tx: DbTx, companyId: string, form: FilingForm, period: string): Promise<PreparedFiling> {
  const def = STATE_FORMS[form];
  if (!def) throw new Error(`prepareStateReport: ${form}`);
  const { start, end } = periodBounds(period);
  const q = await quarterPay(tx, companyId, start, end);
  const s = def.state;
  const inState = q.checks.filter((p) => taxesOf(p.taxesJson).some((t) => t.jurisdiction === s));
  const acct = await account(tx, companyId, def.agency);
  const ids = [...new Set(inState.map((p) => p.workerId))].sort();
  const nm = await names(tx, ids);
  const per = ids.map((id) => {
    const mine = inState.filter((p) => p.workerId === id);
    const gross = mine.reduce((a, p) => a + p.grossCents, 0);
    const subject = s === "CA" ? sum(mine, is("sdi", "CA", "employee"), "taxable_wages_cents") : gross;
    return {
      worker_id: id, name: nm.get(id) ?? id, gross_cents: gross, subject_wages_cents: subject,
      pit_wages_cents: sum(mine, is("pit", s, "employee"), "taxable_wages_cents"), pit_withheld_cents: sum(mine, is("pit", s, "employee"), "amount_cents"),
      ui_taxable_wages_cents: sum(mine, is("sui", s, "employer"), "taxable_wages_cents"), ui_cents: sum(mine, is("sui", s, "employer"), "amount_cents"),
      ett_cents: sum(mine, is("ett", s, "employer"), "amount_cents"), sdi_cents: sum(mine, is("sdi", s, "employee"), "amount_cents"),
    };
  });
  const tot = (k: keyof (typeof per)[number]) => per.reduce((a, p) => a + (p[k] as number), 0);
  const months = monthsOf(start);
  const counts = months.map((m) => countOnThe12th(q, m, (p) => taxesOf(p.taxesJson).some((t) => t.jurisdiction === s)));
  const ui = tot("ui_cents"), ett = tot("ett_cents"), sdi = tot("sdi_cents"), pit = tot("pit_withheld_cents");
  const due = form === "tx_c3" || form === "co_uitr1" ? ui : ui + ett + sdi + pit;
  const lines = [
    ...months.map((m, i) => line(`emp.${i + 1}`, `Employees paid in the pay period including ${m}-12`, null, counts[i] ?? null)),
    line("gross", "Total wages paid", tot("gross_cents")),
    line("subject", s === "CA" ? "Total subject wages" : "Total remuneration", tot("subject_wages_cents")),
    line("ui_taxable", "UI taxable wages", tot("ui_taxable_wages_cents")),
    line("ui", "UI contributions", ui),
    ...(s === "CA" ? [line("ett", "Employment Training Tax", ett), line("sdi_wages", "SDI taxable wages", tot("subject_wages_cents")), line("sdi", "SDI withheld", sdi)] : []),
    ...(form === "tx_c3" || form === "co_uitr1" ? [] : [line("pit_wages", "State income tax wages", tot("pit_wages_cents")), line("pit", "State income tax withheld", pit)]),
    line("total", "Total due for the quarter", due),
    line("deposits", "Less contributions and withholding deposited", due),
    line("balance", "Balance due", 0),
  ];
  return finish({
    form, period, period_start: start, period_end: end, due_on: dueOn(form, period), tax_account_id: acct?.id ?? null, account_number: acct?.accountNumber ?? null,
    agency: def.agency, jurisdiction: s, source_url: RULE_BY_FORM[form].sourceUrl, runs: q.runs.map((r) => r.id), coverage: coverageQuarter(q.runs.map((r) => r.id), start),
    lines, employees: def.perEmployee ? per : [], total_due_cents: due, deposits_cents: due, balance_due_cents: 0,
  });
}

// ---------------------------------------------------------------- annual returns (YTD ledger)

async function ledger(tx: DbTx, year: number) {
  return tx.select().from(ytdLedger).where(eq(ytdLedger.year, year));
}

export async function prepare940(tx: DbTx, companyId: string, period: string): Promise<PreparedFiling> {
  const year = Number(period);
  const rows = (await ledger(tx, year)).filter((r) => r.workerId.startsWith("wrk_"));
  const acct = await account(tx, companyId, "irs");
  const s = (code: string) => rows.filter((r) => r.code === code).reduce((a, r) => a + r.amountCents, 0);
  const gross = s("gross"), futaWages = s("futa_wages");
  const tax = mulRateCents(futaWages, "0.006");
  const deposits = s("tax:US:futa:employer");
  const lines = [
    line("3", "Total payments to all employees", gross),
    line("4-5", "Payments exempt from FUTA and over the $7,000 wage base", gross - futaWages),
    line("7", "Total taxable FUTA wages", futaWages),
    line("8", "FUTA tax before adjustments (0.6%)", tax),
    line("12", "Total FUTA tax after adjustments", tax),
    line("13", "FUTA tax deposited for the year", deposits),
    line("14", "Balance due", Math.max(tax - deposits, 0)),
    line("15", "Overpayment", Math.max(deposits - tax, 0)),
  ];
  return finish({
    form: "940", period, period_start: `${year}-01-01`, period_end: `${year}-12-31`, due_on: dueOn("940", period), tax_account_id: acct?.id ?? null, account_number: acct?.accountNumber ?? null,
    agency: "irs", jurisdiction: "US", source_url: RULE_BY_FORM["940"].sourceUrl, runs: [...new Set(rows.map((r) => r.source))].sort(),
    coverage: "Year to date from the ledger: the previous provider's import plus every Weft run. Credit reduction states: none on file.",
    lines, employees: [], total_due_cents: tax, deposits_cents: deposits, balance_due_cents: tax - deposits,
  });
}

export async function prepareW2W3(tx: DbTx, companyId: string, period: string): Promise<PreparedFiling> {
  const year = Number(period);
  const rows = await ledger(tx, year);
  const acct = await account(tx, companyId, "irs");
  const ids = [...new Set(rows.filter((r) => r.code === "gross").map((r) => r.workerId))].sort();
  const nm = await names(tx, ids);
  const v = (id: string, code: string) => rows.filter((r) => r.workerId === id && r.code === code).reduce((a, r) => a + r.amountCents, 0);
  const per = ids.map((id) => {
    const state = (["CA", "NY", "CO"].find((st) => rows.some((r) => r.workerId === id && r.code === `state_pit_wages:${st}`)) ?? null);
    return {
      worker_id: id, name: nm.get(id) ?? id,
      box1_cents: v(id, "fit_wages"), box2_cents: v(id, "tax:US:fit:employee"), box3_cents: v(id, "ss_wages"), box4_cents: v(id, "tax:US:ss:employee"),
      box5_cents: v(id, "medicare_wages"), box6_cents: v(id, "tax:US:medicare:employee"), box12d_cents: v(id, "k401_deferral"),
      state, box16_cents: state ? v(id, `state_pit_wages:${state}`) : 0, box17_cents: state ? v(id, `tax:${state}:pit:employee`) : 0,
    };
  });
  const tot = (k: string) => per.reduce((a, p) => a + Number(p[k as keyof typeof p] ?? 0), 0);
  const lines = [
    line("c", "Forms W-2 (count)", null, per.length),
    line("1", "Wages, tips, other compensation", tot("box1_cents")), line("2", "Federal income tax withheld", tot("box2_cents")),
    line("3", "Social Security wages", tot("box3_cents")), line("4", "Social Security tax withheld", tot("box4_cents")),
    line("5", "Medicare wages and tips", tot("box5_cents")), line("6", "Medicare tax withheld", tot("box6_cents")),
    line("12a", "Deferred compensation (401(k), code D)", tot("box12d_cents")),
    line("16", "State wages", tot("box16_cents")), line("17", "State income tax", tot("box17_cents")),
  ];
  return finish({
    form: "w2_w3", period, period_start: `${year}-01-01`, period_end: `${year}-12-31`, due_on: dueOn("w2_w3", period), tax_account_id: acct?.id ?? null, account_number: acct?.accountNumber ?? null,
    agency: "irs", jurisdiction: "US", source_url: RULE_BY_FORM.w2_w3.sourceUrl, runs: [...new Set(rows.map((r) => r.source))].sort(),
    coverage: "Year to date from the ledger: the previous provider's import plus every Weft run.", lines, employees: per, total_due_cents: 0, deposits_cents: 0, balance_due_cents: 0,
  });
}

/** Payments made in 2026 and later are reported at $2,000 or more (the threshold rose from $600; confirm each year). */
export const NEC_THRESHOLD_CENTS = 200_000;

export async function prepare1099Nec(tx: DbTx, companyId: string, period: string): Promise<PreparedFiling> {
  const year = Number(period);
  const people = (await tx.select().from(workers).where(and(eq(workers.companyId, companyId), eq(workers.type, "contractor")))).filter((w) => w.country === "US");
  const pays = people.length ? await tx.select().from(contractorPayments).where(inArray(contractorPayments.workerId, people.map((p) => p.id))) : [];
  const paid = pays.filter((p) => p.scheduledFor.startsWith(String(year)) && (p.railStatus === "delivered" || p.status === "paid"));
  const per = people.map((w) => ({ worker_id: w.id, name: displayName(w.firstName, w.lastName), box1_cents: paid.filter((p) => p.workerId === w.id).reduce((a, p) => a + p.usdCents, 0) }))
    .filter((p) => p.box1_cents >= NEC_THRESHOLD_CENTS).sort((a, b) => (a.worker_id < b.worker_id ? -1 : 1));
  const acct = await account(tx, companyId, "irs");
  const lines = [line("count", "Forms 1099-NEC (count)", null, per.length), line("1", "Nonemployee compensation", per.reduce((a, p) => a + p.box1_cents, 0))];
  return finish({
    form: "1099_nec", period, period_start: `${year}-01-01`, period_end: `${year}-12-31`, due_on: dueOn("1099_nec", period), tax_account_id: acct?.id ?? null, account_number: acct?.accountNumber ?? null,
    agency: "irs", jurisdiction: "US", source_url: RULE_BY_FORM["1099_nec"].sourceUrl, runs: [],
    coverage: `US contractors paid at least $${NEC_THRESHOLD_CENTS / 100} in the year. Contractors abroad file a W-8 and get no 1099-NEC.`,
    lines, employees: per, total_due_cents: 0, deposits_cents: 0, balance_due_cents: 0,
  });
}

export async function prepareFiling(tx: DbTx, companyId: string, form: FilingForm, period: string): Promise<PreparedFiling> {
  if (form === "941") return prepare941(tx, companyId, period);
  if (form === "940") return prepare940(tx, companyId, period);
  if (form === "w2_w3") return prepareW2W3(tx, companyId, period);
  if (form === "1099_nec") return prepare1099Nec(tx, companyId, period);
  if (STATE_FORMS[form]) return prepareStateReport(tx, companyId, form, period);
  throw new Error(`prepareFiling: ${form} is not prepared by Weft yet`);
}

export const isPreparable = (form: FilingForm) => form === "941" || form === "940" || form === "w2_w3" || form === "1099_nec" || !!STATE_FORMS[form];
