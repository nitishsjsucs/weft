// reports.query (wave 3, research/wave3/agent-parity.md 5.4). Owner: w3-parity-chat. Seven deterministic metrics, one
// SQL statement family each, over the company's own rows. Money is integer cents with a display string beside it; time
// off is integer minutes. Every result carries a ChartSpec the agent panel renders; the model never builds the chart.
import { sql } from "drizzle-orm";
import { formatCents, Refused, type ChartSpec, type ReportMetric, type ReportResult } from "@weft/contracts";
import type { DbTx } from "@weft/db";

export type ReportGroupBy = "month" | "quarter";
export type ReportRow = Record<string, string | number>;
export interface ReportQuery { companyId: string; metric: ReportMetric; from: string; to: string; groupBy: ReportGroupBy }
export interface ReportOutput extends ReportResult { summary: string; groupBy: ReportGroupBy }

/** The grant domain a person needs at view level to read each metric (checked on top of the command's own domain). */
export const METRIC_DOMAIN: Record<ReportMetric, "payroll" | "people"> = {
  payroll_cost_by_month: "payroll", expenses_by_category: "payroll",
  headcount_by_state: "people", headcount_by_department: "people", hires_and_departures_by_month: "people", turnover_rate: "people", time_off_minutes_by_month: "people",
};
export const METRIC_TITLE: Record<ReportMetric, string> = {
  payroll_cost_by_month: "Payroll cost", headcount_by_state: "Headcount by work state", headcount_by_department: "Headcount by department",
  hires_and_departures_by_month: "Hires and departures", turnover_rate: "Turnover rate", time_off_minutes_by_month: "Time off taken", expenses_by_category: "Expenses by category",
};
/** Snapshot metrics read one date (`to`); the rest are time series over periods from `from` to `to`. */
export const SNAPSHOT_METRICS: ReadonlySet<ReportMetric> = new Set(["headcount_by_state", "headcount_by_department", "expenses_by_category"]);
export const MAX_RANGE_MONTHS = 120;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CATEGORY_LABEL: Record<string, string> = {
  travel: "Travel", lodging: "Lodging", meals: "Meals", mileage: "Mileage", equipment: "Equipment", software: "Software", office: "Office", supplies: "Supplies",
};

/** Default window: the first day of the month eleven months back through today (twelve calendar months). */
export function defaultRange(today: string): { from: string; to: string } {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const back = y * 12 + (m - 1) - 11;
  return { from: `${Math.floor(back / 12)}-${String((back % 12) + 1).padStart(2, "0")}-01`, to: today };
}

export function validateRange(from: string, to: string): void {
  if (!DATE.test(from) || !DATE.test(to)) throw new Refused("INVALID_INPUT", "from and to are dates in YYYY-MM-DD form");
  if (from > to) throw new Refused("INVALID_INPUT", `from (${from}) is after to (${to})`);
  if (monthIndex(to) - monthIndex(from) + 1 > MAX_RANGE_MONTHS) throw new Refused("INVALID_INPUT", `A report covers at most ${MAX_RANGE_MONTHS} months`);
}

const monthIndex = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
const monthKey = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
const lastDay = (key: string) => { const [y, m] = key.split("-").map(Number); return `${key}-${String(new Date(Date.UTC(y!, m!, 0)).getUTCDate()).padStart(2, "0")}`; };

interface Period { key: string; label: string; months: string[]; start: string; end: string }

/** Calendar periods covering [from, to]; a period's start and end are clipped to the range. */
export function periodsOf(from: string, to: string, groupBy: ReportGroupBy): Period[] {
  const out: Period[] = [];
  for (let i = monthIndex(from); i <= monthIndex(to); i++) {
    const mk = monthKey(i);
    const y = Math.floor(i / 12), q = Math.floor((i % 12) / 3) + 1;
    const key = groupBy === "quarter" ? `${y}-Q${q}` : mk;
    let p = out[out.length - 1];
    if (!p || p.key !== key) {
      p = { key, label: groupBy === "quarter" ? `Q${q} ${y}` : `${MONTHS[i % 12]} ${y}`, months: [], start: `${mk}-01` < from ? from : `${mk}-01`, end: "" };
      out.push(p);
    }
    p.months.push(mk);
    p.end = lastDay(mk) > to ? to : lastDay(mk);
  }
  return out;
}

const n = (v: unknown) => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : Number(v ?? 0) || 0);
const pctDisplay = (v: number) => `${v.toFixed(2)}%`;
const hours = (minutes: number) => `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)} h`;

function byMonth<T extends Record<string, unknown>>(rows: T[], key: keyof T): Map<string, T> { return new Map(rows.map((r) => [String(r[key]), r])); }

function seriesChart(metric: ReportMetric, kind: ChartSpec["kind"], groupBy: ReportGroupBy, series: ChartSpec["series"]): ChartSpec {
  return { kind, title: `${METRIC_TITLE[metric]} by ${groupBy}`, x: { key: "period", label: groupBy === "quarter" ? "Quarter" : "Month" }, series };
}

// ------------------------------------------------------------------------------------------------ metrics

async function payrollCost(tx: DbTx, q: ReportQuery): Promise<{ rows: ReportRow[]; chart: ChartSpec; summary: string }> {
  // Runs that moved money (submitted to the bank or settled), by payday; amounts are the run's own stored totals.
  const runs = await tx.all<{ m: string; runs: number; gross: number; er_tax: number; benefits: number; reimb: number; total: number }>(sql`
    SELECT substr(payday, 1, 7) AS m, count(*) AS runs,
      sum(coalesce(json_extract(totals_json, '$.grossPay.amount'), 0)) AS gross,
      sum(coalesce(json_extract(totals_json, '$.employerTaxes.amount'), 0)) AS er_tax,
      sum(coalesce(json_extract(totals_json, '$.employerBenefitContributions.amount'), 0)) AS benefits,
      sum(coalesce(json_extract(totals_json, '$.reimbursements.amount'), 0)) AS reimb,
      sum(coalesce(json_extract(totals_json, '$.totalCost.amount'), 0)) AS total
    FROM payroll_runs
    WHERE company_id = ${q.companyId} AND status IN ('processing', 'processed') AND payday BETWEEN ${q.from} AND ${q.to}
    GROUP BY m ORDER BY m`);
  const contractors = await tx.all<{ m: string; usd: number }>(sql`
    SELECT substr(cp.scheduled_for, 1, 7) AS m, sum(cp.usd_cents) AS usd
    FROM contractor_payments cp JOIN workers w ON w.id = cp.worker_id
    WHERE w.company_id = ${q.companyId} AND cp.status = 'paid' AND cp.scheduled_for BETWEEN ${q.from} AND ${q.to}
    GROUP BY m ORDER BY m`);
  const R = byMonth(runs, "m"), C = byMonth(contractors, "m");
  const rows: ReportRow[] = [];
  for (const p of periodsOf(q.from, q.to, q.groupBy)) {
    let count = 0, gross = 0, erTax = 0, benefits = 0, reimb = 0, total = 0, contractor = 0;
    for (const m of p.months) {
      const r = R.get(m), c = C.get(m);
      if (r) { count += n(r.runs); gross += n(r.gross); erTax += n(r.er_tax); benefits += n(r.benefits); reimb += n(r.reimb); total += n(r.total); }
      if (c) contractor += n(c.usd);
    }
    if (count === 0 && contractor === 0) continue;   // no paid runs: a zero here would read as "payroll cost nothing"
    rows.push({
      period: p.key, period_label: p.label, period_start: p.start, period_end: p.end, runs: count,
      gross_cents: gross, gross_display: formatCents(gross), employer_taxes_cents: erTax, employer_taxes_display: formatCents(erTax),
      benefits_cents: benefits, benefits_display: formatCents(benefits), reimbursements_cents: reimb, reimbursements_display: formatCents(reimb),
      contractor_cents: contractor, contractor_display: formatCents(contractor), total_cents: total + contractor, total_display: formatCents(total + contractor),
    });
  }
  const chart = seriesChart(q.metric, "stacked_bar", q.groupBy, [
    { key: "gross_cents", label: "Gross pay", unit: "cents" }, { key: "employer_taxes_cents", label: "Employer taxes", unit: "cents" },
    { key: "benefits_cents", label: "Employer benefits", unit: "cents" }, { key: "reimbursements_cents", label: "Reimbursements", unit: "cents" },
    { key: "contractor_cents", label: "Contractor payouts", unit: "cents" },
  ]);
  const sum = rows.reduce((a, r) => a + n(r.total_cents), 0);
  const summary = rows.length === 0 ? `Payroll cost ${q.from} to ${q.to}: no paid runs in this range`
    : `Payroll cost by ${q.groupBy}, ${q.from} to ${q.to}: ${rows.length} ${q.groupBy === "quarter" ? "quarters" : "months"} with paid runs, total ${formatCents(sum)}`;
  return { rows, chart, summary };
}

/** Employees counted on a date: started on or before it, not yet past their last day, not a draft record. */
const onRoll = (d: string) => sql`w.type = 'employee' AND w.status NOT IN ('draft') AND w.start_date <= ${d} AND (w.end_date IS NULL OR w.end_date >= ${d})`;

async function headcountOn(tx: DbTx, companyId: string, d: string): Promise<number> {
  const [r] = await tx.all<{ c: number }>(sql`SELECT count(*) AS c FROM workers w WHERE w.company_id = ${companyId} AND ${onRoll(d)}`);
  return n(r?.c);
}

async function headcountBy(tx: DbTx, q: ReportQuery, by: "state" | "department") {
  const rows = by === "state"
    ? await tx.all<{ k: string | null; c: number }>(sql`SELECT w.work_state AS k, count(*) AS c FROM workers w WHERE w.company_id = ${q.companyId} AND ${onRoll(q.to)} GROUP BY k ORDER BY c DESC, k`)
    : await tx.all<{ k: string | null; c: number }>(sql`SELECT d.name AS k, count(*) AS c FROM workers w LEFT JOIN departments d ON d.id = w.department_id WHERE w.company_id = ${q.companyId} AND ${onRoll(q.to)} GROUP BY k ORDER BY c DESC, k`);
  const out: ReportRow[] = rows.map((r) => ({ [by]: r.k ?? (by === "state" ? "None" : "No department"), employees: n(r.c) }));
  const total = out.reduce((a, r) => a + n(r.employees), 0);
  const chart: ChartSpec = { kind: "bar", title: `${METRIC_TITLE[q.metric]} on ${q.to}`, x: { key: by, label: by === "state" ? "Work state" : "Department" }, series: [{ key: "employees", label: "Employees", unit: "count" }] };
  return { rows: out, chart, summary: `${METRIC_TITLE[q.metric]} on ${q.to}: ${total} employees across ${out.length} ${by === "state" ? "states" : "departments"}` };
}

async function hiresDepartures(tx: DbTx, q: ReportQuery, turnover: boolean) {
  const hires = await tx.all<{ m: string; c: number }>(sql`
    SELECT substr(start_date, 1, 7) AS m, count(*) AS c FROM workers
    WHERE company_id = ${q.companyId} AND type = 'employee' AND status NOT IN ('draft') AND start_date BETWEEN ${q.from} AND ${q.to} GROUP BY m`);
  const leaves = await tx.all<{ m: string; c: number }>(sql`
    SELECT substr(end_date, 1, 7) AS m, count(*) AS c FROM workers
    WHERE company_id = ${q.companyId} AND type = 'employee' AND status NOT IN ('draft') AND end_date BETWEEN ${q.from} AND ${q.to} GROUP BY m`);
  const H = byMonth(hires, "m"), L = byMonth(leaves, "m");
  const rows: ReportRow[] = [];
  let hired = 0, left = 0;
  for (const p of periodsOf(q.from, q.to, q.groupBy)) {
    const h = p.months.reduce((a, m) => a + n(H.get(m)?.c), 0);
    const d = p.months.reduce((a, m) => a + n(L.get(m)?.c), 0);
    hired += h; left += d;
    const headStart = await headcountOn(tx, q.companyId, p.start);
    const headEnd = await headcountOn(tx, q.companyId, p.end);
    if (turnover) {
      const avg = (headStart + headEnd) / 2;
      const pct = avg > 0 ? Math.round((d / avg) * 10000) / 100 : 0;
      rows.push({ period: p.key, period_label: p.label, period_start: p.start, period_end: p.end, departures: d, average_headcount: avg, turnover_pct: pct, turnover_display: pctDisplay(pct) });
    } else {
      rows.push({ period: p.key, period_label: p.label, period_start: p.start, period_end: p.end, hires: h, departures: d, net: h - d, headcount_end: headEnd });
    }
  }
  if (turnover) {
    const chart = seriesChart(q.metric, "line", q.groupBy, [{ key: "turnover_pct", label: "Turnover", unit: "pct" }]);
    return { rows, chart, summary: `Turnover by ${q.groupBy}, ${q.from} to ${q.to}: ${left} departures over ${rows.length} periods` };
  }
  const chart = seriesChart(q.metric, "bar", q.groupBy, [{ key: "hires", label: "Hires", unit: "count" }, { key: "departures", label: "Departures", unit: "count" }]);
  return { rows, chart, summary: `Hires and departures by ${q.groupBy}, ${q.from} to ${q.to}: ${hired} hires, ${left} departures` };
}

async function timeOffMinutes(tx: DbTx, q: ReportQuery) {
  // `use` rows are signed (balances are sums), so the minutes taken are their absolute values.
  const used = await tx.all<{ m: string; minutes: number; people: number }>(sql`
    SELECT substr(l.effective_date, 1, 7) AS m, sum(abs(l.minutes)) AS minutes, count(DISTINCT l.worker_id) AS people
    FROM time_off_ledger l JOIN workers w ON w.id = l.worker_id
    WHERE w.company_id = ${q.companyId} AND l.kind = 'use' AND l.effective_date BETWEEN ${q.from} AND ${q.to} GROUP BY m`);
  const U = byMonth(used, "m");
  let total = 0;
  const rows: ReportRow[] = periodsOf(q.from, q.to, q.groupBy).map((p) => {
    const minutes = p.months.reduce((a, m) => a + n(U.get(m)?.minutes), 0);
    total += minutes;
    return { period: p.key, period_label: p.label, period_start: p.start, period_end: p.end, minutes_used: minutes, hours_display: hours(minutes) };
  });
  const chart = seriesChart(q.metric, "bar", q.groupBy, [{ key: "minutes_used", label: "Time off taken", unit: "minutes" }]);
  return { rows, chart, summary: `Time off taken by ${q.groupBy}, ${q.from} to ${q.to}: ${total} minutes (${hours(total)})` };
}

async function expensesByCategory(tx: DbTx, q: ReportQuery) {
  const rows = await tx.all<{ category: string; approved: number; pending: number; items: number }>(sql`
    SELECT category,
      sum(CASE WHEN status IN ('approved', 'approved_taxable', 'scheduled', 'paid') THEN amount_cents ELSE 0 END) AS approved,
      sum(CASE WHEN status IN ('submitted', 'needs_review') THEN amount_cents ELSE 0 END) AS pending,
      count(*) AS items
    FROM expenses
    WHERE company_id = ${q.companyId} AND status NOT IN ('declined', 'returned') AND transaction_date BETWEEN ${q.from} AND ${q.to}
    GROUP BY category ORDER BY approved + pending DESC, category`);
  const out: ReportRow[] = rows.map((r) => ({
    category: CATEGORY_LABEL[r.category] ?? r.category, items: n(r.items),
    approved_cents: n(r.approved), approved_display: formatCents(n(r.approved)), pending_cents: n(r.pending), pending_display: formatCents(n(r.pending)),
  }));
  const approved = out.reduce((a, r) => a + n(r.approved_cents), 0);
  const chart: ChartSpec = { kind: "stacked_bar", title: `${METRIC_TITLE[q.metric]}, ${q.from} to ${q.to}`, x: { key: "category", label: "Category" }, series: [
    { key: "approved_cents", label: "Approved", unit: "cents" }, { key: "pending_cents", label: "Awaiting review", unit: "cents" },
  ] };
  return { rows: out, chart, summary: `Expenses by category, ${q.from} to ${q.to}: ${formatCents(approved)} approved across ${out.length} categories` };
}

/** Runs one report. Pure over the transaction: same rows in, same result out. */
export async function runReport(tx: DbTx, q: ReportQuery): Promise<ReportOutput> {
  validateRange(q.from, q.to);
  const r = q.metric === "payroll_cost_by_month" ? await payrollCost(tx, q)
    : q.metric === "headcount_by_state" ? await headcountBy(tx, q, "state")
    : q.metric === "headcount_by_department" ? await headcountBy(tx, q, "department")
    : q.metric === "hires_and_departures_by_month" ? await hiresDepartures(tx, q, false)
    : q.metric === "turnover_rate" ? await hiresDepartures(tx, q, true)
    : q.metric === "time_off_minutes_by_month" ? await timeOffMinutes(tx, q)
    : await expensesByCategory(tx, q);
  return { metric: q.metric, from: q.from, to: q.to, groupBy: q.groupBy, rows: r.rows, chart: r.chart, artifactRef: null, summary: r.summary };
}
