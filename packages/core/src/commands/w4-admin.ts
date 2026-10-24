// Wave 4 commands (docs/wave4.md, W4_PLANNED_COMMANDS in packages/contracts/src/wave4.ts). Owner: w4-parity-admin.
// Planned: routines.gallery, settings.permission_matrix, settings.set_agent_action_override. Append here only; commands/index.ts concatenates it, so the other namespace files stay untouched.
// Honest risk and approval from the planned table, zod inputs with no z.record (strict schemas), preview for anything
// that proposes, access "human_only" for a person's own submissions. Update the registry snapshot test in the same commit.
//
// Beyond the planned table (docs/tracks/w4-parity-admin.md, contract request):
// - reports.breakdown (R0): the four ReportMetricW4 metrics. The wave 3 reports.query stays frozen, so its seven
//   metrics keep their command and these four get their own, with the same row and ChartSpec shape.
// - comms.send_report (R3, approval always): the Reports screen's "Email this report". comms.send_message grounds
//   its text against a fixed fact sheet (headcounts, open approvals), which holds no report figure, so a report
//   text would be refused UNGROUNDED on approval. This command writes the text in code from the report rows and
//   grounds it against them, as comms.send_exec_report does for the exec report.
import { and, eq, sql } from "drizzle-orm";
import { Cron } from "croner";
import { z } from "zod";
import { formatCents, Refused, ReportMetric, ReportMetricW4, type ChartSpec, type ExecContext, type PermissionMatrixRow, type RoutineGalleryRow } from "@weft/contracts";
import { agentActionOverrides, agentGrants, principals, routines, type DbTx } from "@weft/db";
import { check } from "@weft/grounding";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import type { WeftCommand } from "../shared/deps";
import { DomainRefusal, ptDateOf, readCommand, riskOf, writeCommand } from "../demo/define";
import { defaultRange, METRIC_DOMAIN, METRIC_TITLE, periodsOf, runReport, SNAPSHOT_METRICS, validateRange, type ReportGroupBy, type ReportRow } from "../reports/query";

// ------------------------------------------------------------------------------------------------ the catalog

export type AnyMetric = ReportMetric | ReportMetricW4;
export type MetricDomain = "payroll" | "people" | "tax";
export type MetricUnit = ChartSpec["series"][number]["unit"];

export const W4_METRIC_DOMAIN: Record<ReportMetricW4, MetricDomain> = {
  payroll_cost_by_state: "payroll", headcount_and_cost_by_state: "payroll", contractor_vs_employee_cost_by_month: "payroll", compliance_due_by_month: "tax",
};
export const W4_METRIC_TITLE: Record<ReportMetricW4, string> = {
  payroll_cost_by_state: "Payroll cost by work state", headcount_and_cost_by_state: "Headcount and payroll cost by state",
  contractor_vs_employee_cost_by_month: "Employee and contractor cost", compliance_due_by_month: "Compliance items due",
};
/** Snapshot metrics have one row per category over the range (no periods); the rest are series over periods. */
export const W4_SNAPSHOT_METRICS: ReadonlySet<ReportMetricW4> = new Set(["payroll_cost_by_state", "headcount_and_cost_by_state"]);

const W3_UNIT: Record<ReportMetric, MetricUnit> = {
  payroll_cost_by_month: "cents", headcount_by_state: "count", headcount_by_department: "count", hires_and_departures_by_month: "count",
  turnover_rate: "pct", time_off_minutes_by_month: "minutes", expenses_by_category: "cents",
};
const W4_UNIT: Record<ReportMetricW4, MetricUnit> = {
  payroll_cost_by_state: "cents", headcount_and_cost_by_state: "cents", contractor_vs_employee_cost_by_month: "cents", compliance_due_by_month: "count",
};

export interface CatalogEntry { metric: AnyMetric; label: string; unit: MetricUnit; domain: MetricDomain; snapshot: boolean; source: "reports.query" | "reports.breakdown" }

/** Every metric the Reports screen offers: the seven wave 3 metrics, then the four wave 4 ones. */
export const REPORT_CATALOG: readonly CatalogEntry[] = [
  ...ReportMetric.options.map((m): CatalogEntry => ({ metric: m, label: METRIC_TITLE[m], unit: W3_UNIT[m], domain: METRIC_DOMAIN[m], snapshot: SNAPSHOT_METRICS.has(m), source: "reports.query" })),
  ...ReportMetricW4.options.map((m): CatalogEntry => ({ metric: m, label: W4_METRIC_TITLE[m], unit: W4_UNIT[m], domain: W4_METRIC_DOMAIN[m], snapshot: W4_SNAPSHOT_METRICS.has(m), source: "reports.breakdown" })),
];
export const isW4Metric = (m: string): m is ReportMetricW4 => (ReportMetricW4.options as readonly string[]).includes(m);
export const isW3Metric = (m: string): m is ReportMetric => (ReportMetric.options as readonly string[]).includes(m);
export const metricDomain = (m: AnyMetric): MetricDomain => (isW4Metric(m) ? W4_METRIC_DOMAIN[m] : METRIC_DOMAIN[m]);
export const metricTitle = (m: AnyMetric): string => (isW4Metric(m) ? W4_METRIC_TITLE[m] : METRIC_TITLE[m]);

// ------------------------------------------------------------------------------------------------ wave 4 metrics

export interface ReportQueryW4 { companyId: string; metric: ReportMetricW4; from: string; to: string; groupBy: ReportGroupBy }
export interface ReportOutputW4 { metric: ReportMetricW4; from: string; to: string; groupBy: ReportGroupBy; rows: ReportRow[]; chart: ChartSpec; artifactRef: null; summary: string }

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : Number(v ?? 0) || 0);
const PAID_RUN = sql`r.status IN ('processing', 'processed')`;

/**
 * Employer cost per paycheck, by the worker's work state: gross, employer taxes (taxes_json rows with payer
 * employer), employer benefit contributions (benefits_json employerCents) and reimbursements. The state is the
 * worker's current work state; Weft keeps no work-state history yet, so a mover's earlier pay counts where they work now.
 */
async function costByState(tx: DbTx, q: { companyId: string; from: string; to: string }) {
  return tx.all<{ state: string | null; people: number; paychecks: number; gross: number; er_tax: number; er_benefits: number; reimb: number }>(sql`
    SELECT w.work_state AS state, count(DISTINCT pc.worker_id) AS people, count(*) AS paychecks,
      sum(pc.gross_cents) AS gross,
      sum(coalesce((SELECT sum(json_extract(t.value, '$.amount_cents')) FROM json_each(pc.taxes_json) t WHERE json_extract(t.value, '$.payer') = 'employer'), 0)) AS er_tax,
      sum(coalesce((SELECT sum(json_extract(b.value, '$.employerCents')) FROM json_each(pc.benefits_json) b), 0)) AS er_benefits,
      sum(pc.reimbursements_cents) AS reimb
    FROM paychecks pc JOIN payroll_runs r ON r.id = pc.payroll_run_id JOIN workers w ON w.id = pc.worker_id
    WHERE r.company_id = ${q.companyId} AND ${PAID_RUN} AND r.payday BETWEEN ${q.from} AND ${q.to}
    GROUP BY w.work_state`);
}

function stateRow(r: Awaited<ReturnType<typeof costByState>>[number]): ReportRow {
  const gross = num(r.gross), tax = num(r.er_tax), ben = num(r.er_benefits), reimb = num(r.reimb), total = gross + tax + ben + reimb;
  return {
    state: r.state ?? "None", people_paid: num(r.people), paychecks: num(r.paychecks),
    gross_cents: gross, gross_display: formatCents(gross), employer_taxes_cents: tax, employer_taxes_display: formatCents(tax),
    benefits_cents: ben, benefits_display: formatCents(ben), reimbursements_cents: reimb, reimbursements_display: formatCents(reimb),
    total_cents: total, total_display: formatCents(total),
  };
}
const byTotal = (a: ReportRow, b: ReportRow) => num(b.total_cents) - num(a.total_cents) || String(a.state).localeCompare(String(b.state));

async function payrollCostByState(tx: DbTx, q: ReportQueryW4) {
  const rows = (await costByState(tx, q)).map(stateRow).sort(byTotal);
  const total = rows.reduce((a, r) => a + num(r.total_cents), 0);
  const chart: ChartSpec = { kind: "stacked_bar", title: `${W4_METRIC_TITLE[q.metric]}, ${q.from} to ${q.to}`, x: { key: "state", label: "Work state" }, series: [
    { key: "gross_cents", label: "Gross pay", unit: "cents" }, { key: "employer_taxes_cents", label: "Employer taxes", unit: "cents" },
    { key: "benefits_cents", label: "Employer benefits", unit: "cents" }, { key: "reimbursements_cents", label: "Reimbursements", unit: "cents" },
  ] };
  const summary = rows.length === 0 ? `Payroll cost by work state ${q.from} to ${q.to}: no paid runs in this range`
    : `Payroll cost by work state, ${q.from} to ${q.to}: ${formatCents(total)} across ${rows.length} states`;
  return { rows, chart, summary };
}

/** Employees on the roll on a date (the wave 3 rule): started on or before it, not past their last day, not a draft. */
const onRoll = (d: string) => sql`w.type = 'employee' AND w.status NOT IN ('draft') AND w.start_date <= ${d} AND (w.end_date IS NULL OR w.end_date >= ${d})`;

async function headcountAndCostByState(tx: DbTx, q: ReportQueryW4) {
  const heads = await tx.all<{ state: string | null; c: number }>(sql`SELECT w.work_state AS state, count(*) AS c FROM workers w WHERE w.company_id = ${q.companyId} AND ${onRoll(q.to)} GROUP BY w.work_state`);
  const cost = new Map((await costByState(tx, q)).map((r) => [r.state ?? "None", stateRow(r)]));
  const states = new Set([...heads.map((h) => h.state ?? "None"), ...cost.keys()]);
  const rows: ReportRow[] = [...states].map((state) => {
    const employees = num(heads.find((h) => (h.state ?? "None") === state)?.c);
    const total = num(cost.get(state)?.total_cents);
    const per = employees > 0 ? Math.round(total / employees) : 0;
    return { state, employees, total_cents: total, total_display: formatCents(total), cost_per_employee_cents: per, cost_per_employee_display: formatCents(per) };
  }).sort(byTotal);
  const employees = rows.reduce((a, r) => a + num(r.employees), 0), total = rows.reduce((a, r) => a + num(r.total_cents), 0);
  const chart: ChartSpec = { kind: "bar", title: `${W4_METRIC_TITLE[q.metric]}, ${q.from} to ${q.to}`, x: { key: "state", label: "Work state" }, series: [
    { key: "total_cents", label: "Payroll cost", unit: "cents" },
  ] };
  return { rows, chart, summary: `Headcount and payroll cost by state, ${q.from} to ${q.to}: ${employees} employees on ${q.to}, payroll cost ${formatCents(total)} across ${rows.length} states` };
}

async function contractorVsEmployee(tx: DbTx, q: ReportQueryW4) {
  const runs = await tx.all<{ m: string; total: number }>(sql`
    SELECT substr(r.payday, 1, 7) AS m, sum(coalesce(json_extract(r.totals_json, '$.totalCost.amount'), 0)) AS total
    FROM payroll_runs r WHERE r.company_id = ${q.companyId} AND ${PAID_RUN} AND r.payday BETWEEN ${q.from} AND ${q.to} GROUP BY m`);
  const paid = await tx.all<{ m: string; usd: number; people: number }>(sql`
    SELECT substr(cp.scheduled_for, 1, 7) AS m, sum(cp.usd_cents) AS usd, count(DISTINCT cp.worker_id) AS people
    FROM contractor_payments cp JOIN workers w ON w.id = cp.worker_id
    WHERE w.company_id = ${q.companyId} AND cp.status = 'paid' AND cp.scheduled_for BETWEEN ${q.from} AND ${q.to} GROUP BY m`);
  const R = new Map(runs.map((r) => [r.m, num(r.total)])), C = new Map(paid.map((r) => [r.m, num(r.usd)]));
  const rows: ReportRow[] = [];
  for (const p of periodsOf(q.from, q.to, q.groupBy)) {
    const emp = p.months.reduce((a, m) => a + (R.get(m) ?? 0), 0), con = p.months.reduce((a, m) => a + (C.get(m) ?? 0), 0);
    if (emp === 0 && con === 0) continue;   // nothing paid: a zero row would read as "cost nothing"
    const all = emp + con, share = all > 0 ? Math.round((con / all) * 10000) / 100 : 0;
    rows.push({
      period: p.key, period_label: p.label, period_start: p.start, period_end: p.end,
      employee_cents: emp, employee_display: formatCents(emp), contractor_cents: con, contractor_display: formatCents(con),
      total_cents: all, total_display: formatCents(all), contractor_share_pct: share, contractor_share_display: `${share.toFixed(2)}%`,
    });
  }
  const chart: ChartSpec = { kind: "stacked_bar", title: `${W4_METRIC_TITLE[q.metric]} by ${q.groupBy}`, x: { key: "period", label: q.groupBy === "quarter" ? "Quarter" : "Month" }, series: [
    { key: "employee_cents", label: "Employee payroll", unit: "cents" }, { key: "contractor_cents", label: "Contractor payouts", unit: "cents" },
  ] };
  const emp = rows.reduce((a, r) => a + num(r.employee_cents), 0), con = rows.reduce((a, r) => a + num(r.contractor_cents), 0);
  return { rows, chart, summary: `Employee and contractor cost by ${q.groupBy}, ${q.from} to ${q.to}: employees ${formatCents(emp)}, contractors ${formatCents(con)}` };
}

/** Compliance calendar items by due month: done (or waived), open and overdue (past due and not done). */
async function complianceDue(tx: DbTx, q: ReportQueryW4, today: string) {
  const items = await tx.all<{ m: string; done: number; overdue: number; open: number }>(sql`
    SELECT substr(due_on, 1, 7) AS m,
      sum(CASE WHEN status IN ('done', 'waived') THEN 1 ELSE 0 END) AS done,
      sum(CASE WHEN status NOT IN ('done', 'waived') AND (status = 'overdue' OR due_on < ${today}) THEN 1 ELSE 0 END) AS overdue,
      sum(CASE WHEN status NOT IN ('done', 'waived', 'overdue') AND due_on >= ${today} THEN 1 ELSE 0 END) AS open
    FROM compliance_items WHERE company_id = ${q.companyId} AND due_on BETWEEN ${q.from} AND ${q.to} GROUP BY m`);
  const I = new Map(items.map((i) => [i.m, i]));
  const rows: ReportRow[] = periodsOf(q.from, q.to, q.groupBy).map((p) => {
    const sum = (k: "done" | "overdue" | "open") => p.months.reduce((a, m) => a + num(I.get(m)?.[k]), 0);
    const done = sum("done"), overdue = sum("overdue"), open = sum("open");
    return { period: p.key, period_label: p.label, period_start: p.start, period_end: p.end, items: done + overdue + open, done, open, overdue };
  });
  const chart: ChartSpec = { kind: "stacked_bar", title: `${W4_METRIC_TITLE[q.metric]} by ${q.groupBy}`, x: { key: "period", label: q.groupBy === "quarter" ? "Quarter" : "Month" }, series: [
    { key: "done", label: "Done", unit: "count" }, { key: "open", label: "Open", unit: "count" }, { key: "overdue", label: "Overdue", unit: "count" },
  ] };
  const n = rows.reduce((a, r) => a + num(r.items), 0), late = rows.reduce((a, r) => a + num(r.overdue), 0);
  return { rows, chart, summary: `Compliance items due by ${q.groupBy}, ${q.from} to ${q.to}: ${n} items, ${late} overdue` };
}

/** Runs one wave 4 report. Pure over the transaction and `today`: same rows in, same result out. */
export async function runReportW4(tx: DbTx, q: ReportQueryW4, today: string): Promise<ReportOutputW4> {
  validateRange(q.from, q.to);
  const r = q.metric === "payroll_cost_by_state" ? await payrollCostByState(tx, q)
    : q.metric === "headcount_and_cost_by_state" ? await headcountAndCostByState(tx, q)
    : q.metric === "contractor_vs_employee_cost_by_month" ? await contractorVsEmployee(tx, q)
    : await complianceDue(tx, q, today);
  return { metric: q.metric, from: q.from, to: q.to, groupBy: q.groupBy, rows: r.rows, chart: r.chart, artifactRef: null, summary: r.summary };
}

// ------------------------------------------------------------------------------------------------ grants

async function grantsOf(tx: DbTx, principalId: string): Promise<Record<string, string> | null> {
  const [p] = await tx.select({ grantsJson: principals.grantsJson }).from(principals).where(eq(principals.id, principalId)).limit(1);
  if (!p) return null;
  try { return JSON.parse(p.grantsJson) as Record<string, string>; } catch { return {}; }
}

/** The human this call acts for has view (or better) on the metric's data domain (the wave 3 reports.query rule). */
async function assertMetricGrant(tx: DbTx, ctx: ExecContext, metric: AnyMetric): Promise<void> {
  const who = ctx.onBehalfOf ?? (ctx.principal.kind === "human" ? ctx.principal.id : null);
  if (!who) return;   // system callers: the executor's own grant check already applied
  const grants = await grantsOf(tx, who);
  if (!grants) return;
  const domain = metricDomain(metric);
  const level = grants[domain];
  if (!level || level === "none") throw new Refused("NOT_PERMITTED", `${metric} needs view access to ${domain}, which ${who} does not have`);
}

// ------------------------------------------------------------------------------------------------ reports.breakdown

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const GroupBy = z.enum(["month", "quarter"]);
export const ReportsBreakdownInput = z.object({ metric: ReportMetricW4, from: Day.optional(), to: Day.optional(), group_by: GroupBy.optional() });
export type ReportsBreakdownInput = z.infer<typeof ReportsBreakdownInput>;

function rangeOf(i: { from?: string | undefined; to?: string | undefined }, now: string): { from: string; to: string } {
  const today = ptDateOf(now);
  const to = i.to ?? today;
  return { from: i.from ?? defaultRange(to).from, to };
}

/** Money columns summed over the range, with display strings (the wave 3 range_totals rule). */
function rangeTotals(rows: ReportRow[]): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const row of rows) for (const [k, v] of Object.entries(row)) if (k.endsWith("_cents") && !k.startsWith("cost_per_") && typeof v === "number") out[k] = Number(out[k] ?? 0) + v;
  for (const k of Object.keys(out)) out[`${k.slice(0, -"_cents".length)}_display`] = formatCents(out[k] as number);
  return out;
}

export const reportsBreakdownCommand = readCommand<ReportsBreakdownInput, Record<string, unknown>>({
  name: "reports.breakdown", domain: "company",
  summary: "Payroll cost by state, headcount and cost by state, employee vs contractor cost, compliance items due",
  description: "Rows plus a chart for four breakdowns reports.query does not cover: payroll_cost_by_state, headcount_and_cost_by_state (headcount on `to`, cost over the range), contractor_vs_employee_cost_by_month and compliance_due_by_month. range_totals sums money columns. Example: {\"metric\": \"headcount_and_cost_by_state\"}.",
  compactDescription: "Report rows plus a chart: cost by state, headcount and cost by state, contractor vs employee, compliance due.",
  input: ReportsBreakdownInput,
  async run(i, ctx, deps) {
    await assertMetricGrant(deps.tx, ctx, i.metric);
    const range = rangeOf(i, ctx.now);
    const r = await runReportW4(deps.tx, { companyId: ctx.companyId, metric: i.metric, from: range.from, to: range.to, groupBy: i.group_by ?? "month" }, ptDateOf(ctx.now));
    return { data: { metric: r.metric, from: r.from, to: r.to, group_by: r.groupBy, rows: r.rows, range_totals: rangeTotals(r.rows), chart: r.chart, artifactRef: null }, summary: r.summary };
  },
});
reportsBreakdownCommand.errorHints = {
  INVALID_INPUT: { hint: "Use dates in YYYY-MM-DD form with from on or before to, at most 120 months apart; leave both out for the last twelve months.", example: { metric: "payroll_cost_by_state" } },
  NOT_PERMITTED: { hint: "Ask about a metric the person you act for can see, or say who can.", example: { metric: "compliance_due_by_month" } },
};

// ------------------------------------------------------------------------------------------------ comms.send_report

/** Recipients are simulated mailboxes only (the email simulator refuses anything that is not *.example). */
const EXAMPLE_EMAIL = /^[^@\s]+@([a-z0-9-]+\.)*example$/i;
export const REPORT_FROM_EMAIL = "reports@larkspur.example";
export const MAX_REPORT_RECIPIENTS = 10;
export const MAX_REPORT_LINES = 24;
const AnyMetricInput = z.union([ReportMetric, ReportMetricW4]);
export const SendReportInput = z.object({
  metric: AnyMetricInput, from: Day, to: Day, group_by: GroupBy.optional(),
  recipients: z.array(z.string().regex(EXAMPLE_EMAIL, "recipients are *.example addresses")).min(1).max(MAX_REPORT_RECIPIENTS),
});
export type SendReportInput = z.infer<typeof SendReportInput>;

export interface BuiltReport { metric: AnyMetric; from: string; to: string; groupBy: ReportGroupBy; rows: ReportRow[]; chart: ChartSpec; summary: string }

/** Any catalog metric through its own engine: wave 3 metrics through the frozen runReport, wave 4 through runReportW4. */
export async function buildReport(tx: DbTx, companyId: string, metric: AnyMetric, from: string, to: string, groupBy: ReportGroupBy, today: string): Promise<BuiltReport> {
  const r = isW4Metric(metric) ? await runReportW4(tx, { companyId, metric, from, to, groupBy }, today) : await runReport(tx, { companyId, metric, from, to, groupBy });
  return { metric, from: r.from, to: r.to, groupBy: r.groupBy, rows: r.rows, chart: r.chart, summary: r.summary };
}

const cell = (row: ReportRow, key: string, unit: MetricUnit): string => {
  const shown = row[`${key.replace(/_cents$/, "")}_display`];
  if (typeof shown === "string" && unit === "cents") return shown;
  const v = num(row[key]);
  return unit === "cents" ? formatCents(v) : unit === "pct" ? `${v.toFixed(2)}%` : unit === "minutes" ? `${v} minutes` : String(v);
};

/** The email text, written in code from the rows only, so every number in it is grounded in the report. */
export function reportText(r: BuiltReport): { subject: string; body: string } {
  const title = metricTitle(r.metric);
  const subject = `${title}, ${r.from} to ${r.to}`;
  const xLabel = (row: ReportRow) => String(row[`${r.chart.x.key}_label`] ?? row[r.chart.x.key] ?? "");
  const lines = r.rows.slice(0, MAX_REPORT_LINES).map((row) => `${xLabel(row)}: ${r.chart.series.map((s) => `${s.label.toLowerCase()} ${cell(row, s.key, s.unit)}`).join(", ")}`);
  const more = r.rows.length > MAX_REPORT_LINES ? [`(${r.rows.length - MAX_REPORT_LINES} more rows in Weft Reports)`] : [];
  const totals = rangeTotals(r.rows);
  const totalLine = typeof totals.total_display === "string" ? [`Total: ${totals.total_display}`] : [];
  const body = [
    `${title}, ${r.from} to ${r.to}${isSnapshotOf(r.metric) ? "" : `, by ${r.groupBy}`}.`, "",
    ...(lines.length ? lines : ["No rows in this range."]), ...more, ...totalLine, "",
    "Sent from Weft Reports. Figures are computed from the company's own records.",
  ].join("\n");
  return { subject, body };
}
const isSnapshotOf = (m: AnyMetric) => (isW4Metric(m) ? W4_SNAPSHOT_METRICS.has(m) : SNAPSHOT_METRICS.has(m));

async function composed(i: SendReportInput, ctx: ExecContext, tx: DbTx) {
  await assertMetricGrant(tx, ctx, i.metric);
  validateRange(i.from, i.to);
  const r = await buildReport(tx, ctx.companyId, i.metric, i.from, i.to, i.group_by ?? "month", ptDateOf(ctx.now));
  const text = reportText(r);
  const g = check(`${text.subject}\n${text.body}`, [{ from: r.from, to: r.to, rows: r.rows, totals: rangeTotals(r.rows) }]);
  if (!g.ok) throw new Refused("UNGROUNDED", `Ungrounded numbers in the report text: ${g.offending.join(", ")}`, { hint: "The text is written from the report rows only", example: null });
  const recipients = [...new Set(i.recipients.map((x) => x.toLowerCase()))].sort();
  return { r, text, recipients };
}

export const sendReportCommand = writeCommand<SendReportInput>({
  name: "comms.send_report", summary: "Email a report (rows and totals) to simulated *.example recipients",
  description: "Email one Reports screen report (any reports.query or reports.breakdown metric over from and to) to up to ten *.example addresses. The text is written in code from the report rows, so every number is grounded. R3 and always a proposal: nothing is sent until a person approves.",
  input: SendReportInput, domain: "comms", needs: "edit", effect: "external", risk: riskOf("R3"), approval: "always", autoAllow: "never",
  afterPending: "propose", reversible: false, tiers: { main: "executable", task: "delegated" },
  async preview(i, ctx, deps) {
    const { r, text, recipients } = await composed(i, ctx, deps.tx);
    return {
      title: `Email "${text.subject}" to ${recipients.length === 1 ? recipients[0] : `${recipients.length} recipients`}`, diff: [],
      content: [{ label: "Recipients", text: recipients.join(", ") }, { label: "Subject", text: text.subject }, { label: "Content to be sent", text: text.body }],
      moneyCents: null, subjectRef: `report:${r.metric}`,
      subjectHash: sha256Hex(canonicalJson({ metric: r.metric, from: r.from, to: r.to, group_by: r.groupBy, recipients, body: sha256Hex(text.body) })), evidence: [],
    };
  },
  async run(i, ctx, deps) {
    const { r, text, recipients } = await composed(i, ctx, deps.tx);
    const ids: string[] = [];
    for (const to of recipients) ids.push((await deps.sims.email.send({ to, from: REPORT_FROM_EMAIL, subject: text.subject, body: text.body, kind: "generic", relatedRef: `report:${r.metric}` })).id);
    return { data: { email_ids: ids, recipients, metric: r.metric, from: r.from, to: r.to }, summary: `Emailed ${text.subject} to ${recipients.join(", ")}` };
  },
});

// ------------------------------------------------------------------------------------------------ permissions

export const MATRIX_DOMAINS = ["people", "payroll", "tax", "benefits", "it", "comms", "company"] as const;
type Level = "none" | "view" | "edit" | "approve";
const RANK: Record<Level, number> = { none: 0, view: 1, edit: 2, approve: 3 };
const asLevel = (v: unknown): Level => (v === "view" || v === "edit" || v === "approve" ? v : "none");
const minLevel = (a: Level, b: Level): Level => (RANK[a] <= RANK[b] ? a : b);
/** Approve is never effective for the agent (SPEC 5.2). */
const capped = (l: Level): Level => (l === "approve" ? "edit" : l);

/**
 * One row per person and one for the agent itself. `domains` is the person's own grant; `agentDomains` is what the
 * agent can do when it acts for that person (the agent grant intersected with theirs, approve capped at edit), which
 * is the executor's runGrants rule. The agent's row shows the company-wide agent grant in both. Overrides narrow the
 * agent further, per command, below these domain grants.
 */
export async function permissionMatrix(tx: DbTx, companyId: string): Promise<PermissionMatrixRow[]> {
  const ps = await tx.select().from(principals).where(eq(principals.companyId, companyId));
  const ag = await tx.select().from(agentGrants).where(eq(agentGrants.companyId, companyId));
  const agent: Record<string, Level> = Object.fromEntries(MATRIX_DOMAINS.map((d) => [d, capped(asLevel(ag.find((g) => g.domain === d)?.level))]));
  const ov = await tx.select().from(agentActionOverrides).where(eq(agentActionOverrides.companyId, companyId));
  const overridesOf = (id: string) => ov.filter((o) => o.principalId === id).sort((a, b) => a.command.localeCompare(b.command))
    .map((o) => ({ id: o.id, principalId: o.principalId, command: o.command, mode: o.mode as "deny" | "propose_only", setBy: o.setBy, setAt: o.setAt }));
  const parse = (j: string): Record<string, unknown> => { try { return JSON.parse(j) as Record<string, unknown>; } catch { return {}; } };
  const rows: PermissionMatrixRow[] = [];
  for (const p of ps.filter((x) => x.kind === "human").sort((a, b) => a.id.localeCompare(b.id))) {
    const g = parse(p.grantsJson);
    const domains = Object.fromEntries(MATRIX_DOMAINS.map((d) => [d, asLevel(g[d])]));
    const agentDomains = Object.fromEntries(MATRIX_DOMAINS.map((d) => [d, capped(minLevel(agent[d]!, asLevel(g[d])))]));
    rows.push({ principalId: p.id, name: p.display, role: p.role ?? "member", domains, agentDomains, overrides: overridesOf(p.id) });
  }
  const a = ps.find((x) => x.kind === "agent");
  if (a) rows.push({ principalId: a.id, name: a.display, role: "agent", domains: { ...agent }, agentDomains: { ...agent }, overrides: overridesOf(a.id) });
  return rows;
}

const PermissionMatrixInput = z.object({});
export const permissionMatrixCommand = readCommand<z.infer<typeof PermissionMatrixInput>, Record<string, unknown>>({
  name: "settings.permission_matrix", domain: "company",
  summary: "View, Edit and Approve per domain for each person and for the agent, with per-action overrides",
  description: "The permissions matrix: each person's View, Edit or Approve level per domain, what the agent can do when it acts for them (approve is capped at edit), the agent's own row, and per-action overrides (deny or propose_only) that narrow the agent per command.",
  input: PermissionMatrixInput,
  async run(_i, ctx, deps) {
    const rows = await permissionMatrix(deps.tx, ctx.companyId);
    const n = rows.reduce((a, r) => a + r.overrides.length, 0);
    return { data: { rows }, summary: `Permissions for ${rows.length - 1} people and the agent, ${n} per-action overrides` };
  },
});

export const OverrideMode = z.enum(["deny", "propose_only", "clear"]);
export const SetOverrideInput = z.object({ principal_id: z.string().min(1), command: z.string().regex(/^[a-z_]+\.[a-z_]+$/), mode: OverrideMode });
export type SetOverrideInput = z.infer<typeof SetOverrideInput>;

/** The commands an agent could ever call (callable on a main or task tier); only these can be narrowed. */
async function agentCallable(name: string): Promise<{ ok: boolean; effect: string | null }> {
  const { commands } = await import("./index");   // lazy: index imports this file
  const d = commands.find((c) => c.name === name);
  if (!d) return { ok: false, effect: null };
  const callable = d.access === "all" && (d.tiers.main !== "unavailable" || d.tiers.task !== "unavailable");
  return { ok: callable, effect: d.effect };
}

async function overrideTarget(i: SetOverrideInput, ctx: ExecContext, tx: DbTx) {
  const [p] = await tx.select().from(principals).where(and(eq(principals.id, i.principal_id), eq(principals.companyId, ctx.companyId))).limit(1);
  if (!p || (p.kind !== "human" && p.kind !== "agent")) throw new DomainRefusal("DOMAIN_NOT_FOUND", `No person or agent ${i.principal_id} in this company`, "Use a principalId from the permissions matrix", null);
  const c = await agentCallable(i.command);
  if (!c.effect) throw new DomainRefusal("DOMAIN_NOT_FOUND", `No command named ${i.command}`, "Use a command name from the tool list", null);
  if (!c.ok) throw new DomainRefusal("DOMAIN_NOT_AGENT_CALLABLE", `${i.command} is never available to the agent, so there is nothing to narrow`, null, null);
  if (i.mode === "propose_only" && c.effect === "read") throw new DomainRefusal("DOMAIN_READ_ONLY", `${i.command} is a read; reads never propose, so use deny to hide it`, null, null);
  const [cur] = await tx.select().from(agentActionOverrides)
    .where(and(eq(agentActionOverrides.companyId, ctx.companyId), eq(agentActionOverrides.principalId, i.principal_id), eq(agentActionOverrides.command, i.command))).limit(1);
  return { p, current: (cur?.mode ?? null) as "deny" | "propose_only" | null, row: cur ?? null };
}

const MODE_TEXT = { deny: "hidden from the agent", propose_only: "always a proposal", clear: "no override" } as const;

export const setAgentActionOverrideCommand = writeCommand<SetOverrideInput>({
  name: "settings.set_agent_action_override", summary: "Narrow the agent for one command: deny, propose_only or clear",
  description: "Set a per-action override that narrows the agent below its domain grant, for one person (when the agent acts for them) or for the agent itself (every run): deny hides the command, propose_only makes every call a proposal, clear removes the override. Always a proposal.",
  input: SetOverrideInput, domain: "company", needs: "approve", effect: "write", risk: riskOf("R2"), approval: "always", reversible: false,
  tiers: { main: "unavailable", task: "unavailable" }, mcp: "propose",
  async preview(i, ctx, deps) {
    const { p, current } = await overrideTarget(i, ctx, deps.tx);
    const who = p.kind === "agent" ? "every agent run" : `the agent acting for ${p.display}`;
    return {
      title: `${i.mode === "clear" ? "Clear the override on" : i.mode === "deny" ? "Deny" : "Require approval for"} ${i.command} for ${who}`,
      diff: [{ label: `override ${i.command}`, before: MODE_TEXT[current ?? "clear"], after: MODE_TEXT[i.mode] }],
      content: [], moneyCents: null, subjectRef: `override:${i.principal_id}:${i.command}`,
      subjectHash: sha256Hex(canonicalJson({ principal: i.principal_id, command: i.command, current, mode: i.mode })), evidence: [{ label: "principal", ref: i.principal_id }],
    };
  },
  async run(i, ctx, deps) {
    const { row } = await overrideTarget(i, ctx, deps.tx);
    const by = ctx.principal.id;
    if (i.mode === "clear") {
      if (row) await deps.tx.delete(agentActionOverrides).where(eq(agentActionOverrides.id, row.id));
      return { data: { principal_id: i.principal_id, command: i.command, mode: null }, summary: `Cleared the override on ${i.command} for ${i.principal_id}` };
    }
    const id = row?.id ?? await deps.newId("aov_");
    await deps.tx.insert(agentActionOverrides).values({ id, companyId: ctx.companyId, principalId: i.principal_id, command: i.command, mode: i.mode, setBy: by, setAt: ctx.now, proposalId: ctx.approvedProposalId })
      .onConflictDoUpdate({ target: [agentActionOverrides.companyId, agentActionOverrides.principalId, agentActionOverrides.command], set: { mode: i.mode, setBy: by, setAt: ctx.now, proposalId: ctx.approvedProposalId } });
    return { data: { id, principal_id: i.principal_id, command: i.command, mode: i.mode }, summary: `${i.command} is now ${MODE_TEXT[i.mode]} for ${i.principal_id}` };
  },
});

// ------------------------------------------------------------------------------------------------ routine gallery (G10, G7, G8)

/** Proposal statuses counted as a person approving the routine's work, and as a person overriding it. */
export const GALLERY_APPROVED: readonly string[] = ["approved", "executed", "failed"];
export const GALLERY_OVERRIDDEN: readonly string[] = ["denied", "superseded", "dismissed"];

/** A gallery row with the display fields the screen needs beside the RoutineGalleryRow contract. */
export type GalleryRow = RoutineGalleryRow & { createdByName: string | null; schedule: string; pending: number };

type Trigger = { type: "cron"; cron: string; tz?: string } | { type: "event"; event: string } | { type: string };
const parseJson = <T>(j: unknown, fallback: T): T => {
  if (typeof j !== "string") return (j as T) ?? fallback;
  try { return JSON.parse(j) as T; } catch { return fallback; }
};

/** The next cron slot strictly after `from` (croner, in the routine's time zone), the engine's nextRunAt rule. */
export function nextCronRun(t: Trigger, enabled: boolean, from: string): string | null {
  if (!enabled || t.type !== "cron" || !("cron" in t)) return null;
  const c = new Cron(t.cron, { timezone: t.tz ?? "America/Los_Angeles", paused: true });
  try { return c.nextRun(new Date(from))?.toISOString() ?? null; } catch { return null; } finally { c.stop(); }
}

function scheduleOf(t: Trigger): string {
  if (t.type === "cron" && "cron" in t) return `cron ${t.cron}${t.tz ? ` (${t.tz})` : ""}`;
  if (t.type === "event" && "event" in t) return `on ${t.event}`;
  return t.type;
}

/**
 * Every routine with who created it (the person whose request drafted it, from routine.drafted; prebuilt routines
 * have none), when it was last enabled (the latest routine.enabled after any routine.disabled, or its creation for a
 * routine that shipped enabled), its last run, its next cron slot after `now` (enabled cron routines only), and the
 * decision counts on the proposals its runs filed: approved (approved, executed, failed after approval) and
 * overridden (denied, edited and so superseded, or a dismissed suggestion), the same mapping as the learned
 * approval preferences in memory.
 */
export async function routineGallery(tx: DbTx, companyId: string, now: string): Promise<GalleryRow[]> {
  const rs = await tx.select().from(routines).where(eq(routines.companyId, companyId));
  const names = new Map((await tx.select({ id: principals.id, display: principals.display }).from(principals).where(eq(principals.companyId, companyId))).map((p) => [p.id, p.display]));
  const evs = await tx.all<{ type: string; ts: string; rid: string; by: string | null }>(sql`
    SELECT type, ts, json_extract(payload_json, '$.routine_id') AS rid, requested_by AS by FROM events
    WHERE type IN ('routine.drafted', 'routine.enabled', 'routine.disabled') ORDER BY ts, id`);
  const last = await tx.all<{ rid: string; at: string | null; status: string }>(sql`
    SELECT routine_id AS rid, coalesce(started_at, ended_at) AS at, status FROM (
      SELECT routine_id, started_at, ended_at, status, row_number() OVER (PARTITION BY routine_id ORDER BY coalesce(started_at, ended_at) DESC, id DESC) AS k
      FROM routine_runs) WHERE k = 1`);
  const counts = await tx.all<{ rid: string; status: string; n: number }>(sql`
    SELECT rr.routine_id AS rid, p.status AS status, count(*) AS n FROM proposals p JOIN routine_runs rr ON rr.id = p.routine_run_id
    WHERE p.company_id = ${companyId} GROUP BY rr.routine_id, p.status`);
  const rows: GalleryRow[] = [];
  for (const r of [...rs].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))) {
    const mine = evs.filter((e) => e.rid === r.id);
    const drafted = mine.find((e) => e.type === "routine.drafted") ?? null;
    const createdBy = r.source === "custom" ? (drafted?.by ?? r.ownerPrincipalId) : null;
    const toggles = mine.filter((e) => e.type !== "routine.drafted");
    const lastToggle = toggles.at(-1) ?? null;
    const enabledAt = !r.enabled ? null : lastToggle?.type === "routine.enabled" ? lastToggle.ts : r.createdAt;
    const lr = last.find((x) => x.rid === r.id) ?? null;
    const of = (statuses: readonly string[]) => counts.filter((c) => c.rid === r.id && statuses.includes(c.status)).reduce((a, c) => a + Number(c.n), 0);
    const trigger = parseJson<Trigger>(r.triggerJson, { type: "manual" });
    rows.push({
      routineId: r.id, name: r.name, enabled: r.enabled, autonomy: (r.autonomy === "recommend" || r.autonomy === "auto" ? r.autonomy : "approve"),
      source: r.source === "custom" ? "custom" : "prebuilt", createdBy, createdByName: createdBy ? (names.get(createdBy) ?? createdBy) : null, enabledAt,
      lastRunAt: lr?.at ?? null, lastRunStatus: lr?.status ?? null, nextRunAt: nextCronRun(trigger, r.enabled, now),
      approvals: of(GALLERY_APPROVED), overrides: of(GALLERY_OVERRIDDEN), pending: of(["pending"]), schedule: scheduleOf(trigger),
    });
  }
  return rows;
}

const GalleryInput = z.object({});
export const routineGalleryCommand = readCommand<z.infer<typeof GalleryInput>, Record<string, unknown>>({
  name: "routines.gallery", domain: "company",
  summary: "Every routine with created by, enabled at, last and next run, and approval and override counts",
  description: "The routine gallery: each routine with who created it, when it was enabled, its last run and status, its next scheduled run (enabled cron routines), and how many of its proposals people approved or overrode (denied, edited or dismissed).",
  input: GalleryInput,
  async run(_i, ctx, deps) {
    const rows = await routineGallery(deps.tx, ctx.companyId, ctx.now);
    return { data: { rows }, summary: `${rows.length} routines, ${rows.filter((r) => r.enabled).length} enabled` };
  },
});

export const w4AdminCommands: WeftCommand[] = [reportsBreakdownCommand, sendReportCommand, permissionMatrixCommand, setAgentActionOverrideCommand, routineGalleryCommand];
