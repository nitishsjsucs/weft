// reports.* commands (wave 3, docs/wave3.md). Owner: w3-parity-chat. Append WeftCommand definitions to this array; commands/index.ts
// concatenates it. Names, risk classes and access are fixed by W3_PLANNED_COMMANDS in packages/contracts/src/wave3.ts.
//
// reports.query is R0: deterministic SQL over the company's rows (packages/core/src/reports/query.ts), rows plus a
// ChartSpec. The command's own domain is `company` (every admin can read it); each metric also needs view on its data
// domain for the person the call acts for, so a payroll figure never reaches someone without payroll access. A result
// over 8,000 characters is offloaded to a run artifact by the executor (harness 7.4); the panel reads it from
// GET /v1/agent/runs/:id/artifacts/:ref.
import { eq } from "drizzle-orm";
import { z } from "zod";
import { formatCents, ReportMetric, Refused, type ExecContext } from "@weft/contracts";
import { principals, type DbTx } from "@weft/db";
import type { WeftCommand } from "../shared/deps";
import { ptDateOf } from "../demo/define";
import { defaultRange, METRIC_DOMAIN, runReport, type ReportGroupBy } from "../reports/query";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const ReportsQueryInput = z.object({
  metric: ReportMetric,
  from: Day.optional(),
  to: Day.optional(),
  group_by: z.enum(["month", "quarter"]).optional(),
});
export type ReportsQueryInput = z.infer<typeof ReportsQueryInput>;

/** The human this call acts for has view (or better) on the metric's data domain. */
async function assertMetricGrant(tx: DbTx, ctx: ExecContext, metric: ReportMetric): Promise<void> {
  const who = ctx.onBehalfOf ?? (ctx.principal.kind === "human" ? ctx.principal.id : null);
  if (!who) return;   // system callers: the executor's own grant check already applied
  const [p] = await tx.select({ grantsJson: principals.grantsJson }).from(principals).where(eq(principals.id, who)).limit(1);
  if (!p) return;
  let grants: Record<string, string> = {};
  try { grants = JSON.parse(p.grantsJson) as Record<string, string>; } catch { grants = {}; }
  const domain = METRIC_DOMAIN[metric];
  const level = grants[domain];
  if (!level || level === "none") throw new Refused("NOT_PERMITTED", `${metric} needs view access to ${domain}, which ${who} does not have`);
}

/**
 * The sum of every money column over the whole range, with display strings. A person asking for cost by month often
 * wants the total as well; without it the model adds the rows itself and the grounding check rejects the sum
 * (live L7, wave 3). Only *_cents columns are summed: counts, minutes and rates do not add up across rows.
 */
export function rangeTotals(rows: Record<string, unknown>[]): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const row of rows) for (const [k, v] of Object.entries(row)) if (k.endsWith("_cents") && typeof v === "number") out[k] = Number(out[k] ?? 0) + v;
  for (const k of Object.keys(out)) out[`${k.slice(0, -"_cents".length)}_display`] = formatCents(out[k] as number);
  return out;
}

export const reportsQueryCommand: WeftCommand<ReportsQueryInput> = {
  name: "reports.query", namespace: "reports", summary: "Run a report and return rows plus a chart",
  description: "Aggregates company data into a report with rows and a chart the panel draws. Metrics: payroll_cost_by_month (gross, employer taxes, benefits, reimbursements, contractors, plus workers_paid, hires and departures per period), headcount_by_state, headcount_by_department, hires_and_departures_by_month, turnover_rate, time_off_minutes_by_month, expenses_by_category. range_totals sums money columns. Example: {\"metric\": \"payroll_cost_by_month\"}.",
  compactDescription: "Report rows plus a chart for one of seven company metrics.",
  input: ReportsQueryInput, domain: "company", needs: "view", effect: "read", risk: () => "R0", approval: "never", autoAllow: "never",
  amountCents: null, ceilingKey: null, reversible: false, lease: null, tiers: { main: "executable", task: "executable" }, mcp: "read", sandbox: "read",
  access: "all", untrustedFields: [], afterPending: "run", preview: null,
  errorHints: {
    INVALID_INPUT: { hint: "Use dates in YYYY-MM-DD form with from on or before to, at most 120 months apart; leave both out for the last twelve months.", example: { metric: "payroll_cost_by_month" } },
    NOT_PERMITTED: { hint: "Ask about a metric the person you act for can see, or say who can.", example: { metric: "headcount_by_state" } },
  },
  async run(i, ctx, deps) {
    await assertMetricGrant(deps.tx, ctx, i.metric);
    const today = ptDateOf(ctx.now);
    const range = defaultRange(i.to ?? today);
    const r = await runReport(deps.tx, { companyId: ctx.companyId, metric: i.metric, from: i.from ?? range.from, to: i.to ?? today, groupBy: (i.group_by ?? "month") as ReportGroupBy });
    const data = { metric: r.metric, from: r.from, to: r.to, group_by: r.groupBy, rows: r.rows, range_totals: rangeTotals(r.rows), chart: r.chart, artifactRef: r.artifactRef };
    return { data, summary: r.summary };
  },
};

export const reportsCommands: WeftCommand[] = [reportsQueryCommand];
