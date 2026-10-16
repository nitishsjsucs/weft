// reports.query and GET /v1/reports/:metric (wave 3, w3-parity-chat). SQL per metric against the seed, a golden chart
// spec, the per-metric grant check and the range rules. Expense and time-off rows are inserted here because their own
// tracks seed them; the queries only read the frozen 0006 tables.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ChartSpec, formatCents, ReportResult, type ReportMetric } from "@weft/contracts";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft.close(); });

type Row = Record<string, string | number>;
async function report(metric: ReportMetric, q = "", who = "usr_dana") {
  const res = await weft.app.request(`/v1/reports/${metric}${q}`, { headers: weft.uiHeaders(who) });
  return { status: res.status, body: (await res.json()) as ReportResult & { group_by: string; rows: Row[] } & { code?: string } };
}

describe("reports.query against the seed", () => {
  it("payroll_cost_by_month sums the paid runs' stored totals by payday month, with the golden chart spec", async () => {
    const { status, body } = await report("payroll_cost_by_month", "?from=2026-01-01&to=2026-10-31");
    expect(status).toBe(200);
    expect(ReportResult.safeParse(body).success).toBe(true);
    // Independent arithmetic: the processed seed runs pay_2026_09_15, pay_2026_09_30 and pay_2026_10_15 (the Oct 30 draft is not paid).
    const runs = await weft.db.all<{ id: string; payday: string; totals_json: string }>(sql`SELECT id, payday, totals_json FROM payroll_runs WHERE status IN ('processing', 'processed') ORDER BY payday`);
    expect(runs.map((r) => r.id)).toEqual(["pay_2026_09_15", "pay_2026_09_30", "pay_2026_10_15"]);
    const amt = (r: { totals_json: string }, k: string) => (JSON.parse(r.totals_json) as Record<string, { amount: number }>)[k]!.amount;
    const sep = runs.filter((r) => r.payday.startsWith("2026-09")), oct = runs.filter((r) => r.payday.startsWith("2026-10"));
    const sum = (rs: typeof runs, k: string) => rs.reduce((a, r) => a + amt(r, k), 0);
    expect(body.rows.map((r) => r.period)).toEqual(["2026-09", "2026-10"]);
    expect(body.rows[0]).toMatchObject({ period_label: "Sep 2026", runs: 2, gross_cents: sum(sep, "grossPay"), employer_taxes_cents: sum(sep, "employerTaxes"), benefits_cents: sum(sep, "employerBenefitContributions"), total_cents: sum(sep, "totalCost"), contractor_cents: 0 });
    expect(body.rows[1]).toMatchObject({ period_label: "Oct 2026", runs: 1, gross_cents: sum(oct, "grossPay"), total_cents: sum(oct, "totalCost") });
    expect(body.rows[0]!.gross_display).toBe(formatCents(sum(sep, "grossPay")));
    // The stack adds up to the total (fees are $0.00 in the simulator).
    for (const r of body.rows) expect(Number(r.gross_cents) + Number(r.employer_taxes_cents) + Number(r.benefits_cents) + Number(r.reimbursements_cents) + Number(r.contractor_cents)).toBe(r.total_cents);
    const golden: ChartSpec = {
      kind: "stacked_bar", title: "Payroll cost by month", x: { key: "period", label: "Month" },
      series: [
        { key: "gross_cents", label: "Gross pay", unit: "cents" }, { key: "employer_taxes_cents", label: "Employer taxes", unit: "cents" },
        { key: "benefits_cents", label: "Employer benefits", unit: "cents" }, { key: "reimbursements_cents", label: "Reimbursements", unit: "cents" },
        { key: "contractor_cents", label: "Contractor payouts", unit: "cents" },
      ],
    };
    expect(body.chart).toEqual(golden);
    expect(body.artifactRef).toBeNull();
  });

  it("payroll cost by quarter folds September and October into Q3 and Q4", async () => {
    const m = (await report("payroll_cost_by_month", "?from=2026-01-01&to=2026-10-31")).body.rows;
    const { body } = await report("payroll_cost_by_month", "?from=2026-01-01&to=2026-10-31&groupBy=quarter");
    expect(body.rows.map((r) => [r.period, r.period_label, r.total_cents])).toEqual([["2026-Q3", "Q3 2026", m[0]!.total_cents], ["2026-Q4", "Q4 2026", m[1]!.total_cents]]);
    expect(body.chart.x).toEqual({ key: "period", label: "Quarter" });
  });

  it("headcount_by_state and headcount_by_department count employees on the roll on the as-of date", async () => {
    const asOf = "2026-10-20";
    const expected = await weft.db.all<{ k: string; c: number }>(sql`SELECT work_state AS k, count(*) AS c FROM workers WHERE type = 'employee' AND start_date <= ${asOf} AND (end_date IS NULL OR end_date >= ${asOf}) GROUP BY k`);
    const { body } = await report("headcount_by_state", `?to=${asOf}`);
    expect(Object.fromEntries(body.rows.map((r) => [r.state, r.employees]))).toEqual(Object.fromEntries(expected.map((e) => [e.k, e.c])));
    expect(body.rows.map((r) => r.state)).toEqual(["CA", "NY", "TX"]);   // most first
    expect(body.chart).toEqual({ kind: "bar", title: `Headcount by work state on ${asOf}`, x: { key: "state", label: "Work state" }, series: [{ key: "employees", label: "Employees", unit: "count" }] });
    const dept = (await report("headcount_by_department", `?to=${asOf}`)).body;
    expect(dept.rows.reduce((a, r) => a + Number(r.employees), 0)).toBe(expected.reduce((a, e) => a + e.c, 0));
    expect(dept.rows.find((r) => r.department === "Operations")?.employees).toBeGreaterThan(0);
  });

  it("a departure leaves the headcount after its last day (Owen ends 2026-10-23)", async () => {
    const before = (await report("headcount_by_state", "?to=2026-10-23")).body.rows.reduce((a, r) => a + Number(r.employees), 0);
    const after = (await report("headcount_by_state", "?to=2026-10-24")).body.rows.reduce((a, r) => a + Number(r.employees), 0);
    expect(before - after).toBe(1);
  });

  it("hires_and_departures_by_month lists every month in range, zeros included", async () => {
    const { body } = await report("hires_and_departures_by_month", "?from=2026-01-01&to=2026-10-31");
    expect(body.rows).toHaveLength(10);
    const hires = await weft.db.all<{ m: string; c: number }>(sql`SELECT substr(start_date, 1, 7) AS m, count(*) AS c FROM workers WHERE type = 'employee' AND start_date BETWEEN '2026-01-01' AND '2026-10-31' GROUP BY m`);
    for (const h of hires) expect(body.rows.find((r) => r.period === h.m)?.hires).toBe(h.c);
    expect(body.rows.find((r) => r.period === "2026-10")?.departures).toBe(1);
    expect(body.rows.reduce((a, r) => a + Number(r.hires), 0)).toBe(hires.reduce((a, h) => a + h.c, 0));
    expect(body.chart.series.map((s) => s.key)).toEqual(["hires", "departures"]);
  });

  it("turnover_rate divides departures by the average headcount, to two decimals", async () => {
    const { body } = await report("turnover_rate", "?from=2026-10-01&to=2026-10-31");
    const [oct] = body.rows;
    const start = Number((await weft.db.all<{ c: number }>(sql`SELECT count(*) AS c FROM workers WHERE type = 'employee' AND start_date <= '2026-10-01' AND (end_date IS NULL OR end_date >= '2026-10-01')`))[0]!.c);
    const end = Number((await weft.db.all<{ c: number }>(sql`SELECT count(*) AS c FROM workers WHERE type = 'employee' AND start_date <= '2026-10-31' AND (end_date IS NULL OR end_date >= '2026-10-31')`))[0]!.c);
    const pct = Math.round((1 / ((start + end) / 2)) * 10000) / 100;
    expect(oct).toMatchObject({ period: "2026-10", departures: 1, average_headcount: (start + end) / 2, turnover_pct: pct, turnover_display: `${pct.toFixed(2)}%` });
    expect(body.chart.kind).toBe("line");
  });

  it("time_off_minutes_by_month sums use rows only", async () => {
    await weft.db.run(sql`INSERT INTO time_off_ledger (id, assignment_id, worker_id, policy_id, kind, minutes, effective_date, created_at) VALUES
      ('tol_r001', 'tasn_r1', 'wrk_0001', 'top_r1', 'use', -480, '2026-09-14', '2026-09-14T00:00:00.000Z'),
      ('tol_r002', 'tasn_r1', 'wrk_0001', 'top_r1', 'use', -240, '2026-09-15', '2026-09-15T00:00:00.000Z'),
      ('tol_r003', 'tasn_r2', 'wrk_0002', 'top_r1', 'use', -480, '2026-10-02', '2026-10-02T00:00:00.000Z'),
      ('tol_r004', 'tasn_r2', 'wrk_0002', 'top_r1', 'accrual', 400, '2026-10-15', '2026-10-15T00:00:00.000Z'),
      ('tol_r005', 'tasn_r2', 'wrk_0002', 'top_r1', 'hold', -480, '2026-10-20', '2026-10-20T00:00:00.000Z')`);
    const { body } = await report("time_off_minutes_by_month", "?from=2026-09-01&to=2026-10-31");
    expect(body.rows).toEqual([
      { period: "2026-09", period_label: "Sep 2026", minutes_used: 720, hours_display: "12 h" },
      { period: "2026-10", period_label: "Oct 2026", minutes_used: 480, hours_display: "8 h" },
    ]);
    expect(body.chart.series).toEqual([{ key: "minutes_used", label: "Time off taken", unit: "minutes" }]);
  });

  it("expenses_by_category splits approved from awaiting review and leaves declined out", async () => {
    const ins = (id: string, cat: string, cents: number, status: string, day: string) => weft.db.run(sql`INSERT INTO expenses (id, company_id, worker_id, category, merchant, amount_cents, transaction_date, submitted_at, business_purpose, status)
      VALUES (${id}, 'cmp_larkspur', 'wrk_0003', ${cat}, 'Demo Merchant (demo)', ${cents}, ${day}, ${`${day}T12:00:00.000Z`}, 'Customer visit (demo)', ${status})`);
    await ins("exp_r001", "travel", 42_000, "approved", "2026-10-02");
    await ins("exp_r002", "travel", 18_050, "paid", "2026-09-20");
    await ins("exp_r003", "meals", 6_400, "needs_review", "2026-10-05");
    await ins("exp_r004", "meals", 9_900, "declined", "2026-10-06");
    await ins("exp_r005", "software", 1_200, "approved", "2025-01-06");   // out of range
    const { body } = await report("expenses_by_category", "?from=2026-09-01&to=2026-10-31");
    expect(body.rows).toEqual([
      { category: "Travel", items: 2, approved_cents: 60_050, approved_display: "$600.50", pending_cents: 0, pending_display: "$0.00" },
      { category: "Meals", items: 1, approved_cents: 0, approved_display: "$0.00", pending_cents: 6_400, pending_display: "$64.00" },
    ]);
  });
});

describe("reports.query rules", () => {
  it("refuses a payroll metric for someone without payroll access and allows people metrics", async () => {
    // usr_sam (HR manager) has payroll view in the seed; strip it for this check and restore it after.
    const [p] = await weft.db.all<{ grants_json: string }>(sql`SELECT grants_json FROM principals WHERE id = 'usr_sam'`);
    const g = JSON.parse(p!.grants_json) as Record<string, string>;
    await weft.db.run(sql`UPDATE principals SET grants_json = ${JSON.stringify({ ...g, payroll: "none" })} WHERE id = 'usr_sam'`);
    try {
      const denied = await report("payroll_cost_by_month", "", "usr_sam");
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe("NOT_PERMITTED");
      expect((await report("headcount_by_state", "", "usr_sam")).status).toBe(200);
    } finally {
      await weft.db.run(sql`UPDATE principals SET grants_json = ${p!.grants_json} WHERE id = 'usr_sam'`);
    }
  });

  it("validates the metric and the range", async () => {
    expect((await report("nope" as ReportMetric)).status).toBe(400);
    expect((await report("payroll_cost_by_month", "?from=2026-10-01&to=2026-09-01")).status).toBe(422);
    expect((await report("payroll_cost_by_month", "?from=2010-01-01&to=2026-10-01")).status).toBe(422);
    expect((await report("payroll_cost_by_month", "?groupBy=week")).status).toBe(400);
  });

  it("defaults to the last twelve calendar months ending today", async () => {
    const { body } = await report("hires_and_departures_by_month");
    expect(body.rows).toHaveLength(12);
    expect(body.from.endsWith("-01")).toBe(true);
    expect(body.rows[11]!.period).toBe(body.to.slice(0, 7));
  });
});
