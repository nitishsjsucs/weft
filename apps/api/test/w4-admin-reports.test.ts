// Reports screen, permissions matrix and per-action overrides (wave 4, w4-parity-admin). SQL per wave 4 metric
// against the seed with independent arithmetic, every catalog metric through its route, "email this report" as a
// proposal that sends nothing until approved, the matrix, and an override set by an approved proposal.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ChartSpec, PermissionMatrixRow, ReportMetric, ReportMetricW4 } from "@weft/contracts";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft.close(); });

type Row = Record<string, string | number>;
interface Out { metric: string; from: string; to: string; rows: Row[]; chart: ChartSpec; range_totals: Record<string, number | string> }
const json = { "content-type": "application/json" };
const post = (path: string, body: unknown, who = "usr_dana") => weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders(who), ...json }, body: JSON.stringify(body) });

async function w4(metric: string, args: Record<string, unknown> = {}, who = "usr_dana"): Promise<{ status: number; out: Out; raw: Record<string, unknown> }> {
  const res = await post("/v1/tools/reports.breakdown", { metric, ...args }, who);
  const raw = (await res.json()) as Record<string, unknown>;
  return { status: res.status, out: raw.data as Out, raw };
}
const sum = (rows: Row[], k: string) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);

describe("wave 4 report metrics against the seed", () => {
  it("payroll_cost_by_state splits the paid runs' cost by work state and adds back to the runs' stored totals", async () => {
    const { status, out } = await w4("payroll_cost_by_state", { from: "2026-09-01", to: "2026-10-31" });
    expect(status).toBe(200);
    expect(ChartSpec.safeParse(out.chart).success).toBe(true);
    expect(out.chart).toMatchObject({ kind: "stacked_bar", x: { key: "state", label: "Work state" } });
    // Independent arithmetic from the paychecks themselves.
    const pcs = await weft.db.all<{ state: string; gross: number; taxes: string; benefits: string; reimb: number }>(sql`
      SELECT w.work_state AS state, pc.gross_cents AS gross, pc.taxes_json AS taxes, pc.benefits_json AS benefits, pc.reimbursements_cents AS reimb
      FROM paychecks pc JOIN payroll_runs r ON r.id = pc.payroll_run_id JOIN workers w ON w.id = pc.worker_id
      WHERE r.status IN ('processing', 'processed') AND r.payday BETWEEN '2026-09-01' AND '2026-10-31'`);
    const expected = new Map<string, number>();
    for (const p of pcs) {
      const tax = (JSON.parse(p.taxes) as { payer: string; amount_cents: number }[]).filter((t) => t.payer === "employer").reduce((a, t) => a + t.amount_cents, 0);
      const ben = (JSON.parse(p.benefits) as { employerCents: number }[]).reduce((a, b) => a + b.employerCents, 0);
      expected.set(p.state, (expected.get(p.state) ?? 0) + p.gross + tax + ben + p.reimb);
    }
    expect(out.rows.map((r) => r.state).sort()).toEqual([...expected.keys()].sort());
    for (const r of out.rows) expect(r.total_cents).toBe(expected.get(String(r.state)));
    // Rows are sorted by total, largest first.
    expect(out.rows.map((r) => r.total_cents)).toEqual([...out.rows.map((r) => r.total_cents)].sort((a, b) => Number(b) - Number(a)));
    // The state split adds back to the runs' own totals (fees are $0.00 in the simulator).
    const runs = await weft.db.all<{ t: number }>(sql`SELECT sum(json_extract(totals_json, '$.totalCost.amount')) AS t FROM payroll_runs WHERE status IN ('processing', 'processed') AND payday BETWEEN '2026-09-01' AND '2026-10-31'`);
    expect(sum(out.rows, "total_cents")).toBe(runs[0]!.t);
    expect(out.range_totals.total_cents).toBe(runs[0]!.t);
    for (const r of out.rows) expect(Number(r.gross_cents) + Number(r.employer_taxes_cents) + Number(r.benefits_cents) + Number(r.reimbursements_cents)).toBe(r.total_cents);
  });

  it("headcount_and_cost_by_state counts the roll on `to` and carries the same cost per state", async () => {
    const { out } = await w4("headcount_and_cost_by_state", { from: "2026-09-01", to: "2026-10-31" });
    const heads = await weft.db.all<{ s: string; c: number }>(sql`SELECT work_state AS s, count(*) AS c FROM workers WHERE type = 'employee' AND status != 'draft' AND start_date <= '2026-10-31' AND (end_date IS NULL OR end_date >= '2026-10-31') GROUP BY s`);
    for (const h of heads) expect(out.rows.find((r) => r.state === h.s)?.employees).toBe(h.c);
    const cost = (await w4("payroll_cost_by_state", { from: "2026-09-01", to: "2026-10-31" })).out.rows;
    for (const r of out.rows) {
      expect(r.total_cents).toBe(cost.find((c) => c.state === r.state)?.total_cents ?? 0);
      expect(r.cost_per_employee_cents).toBe(Number(r.employees) > 0 ? Math.round(Number(r.total_cents) / Number(r.employees)) : 0);
    }
    expect(out.chart.series.map((s) => s.key)).toEqual(["total_cents"]);
  });

  it("contractor_vs_employee_cost_by_month puts paid contractor payouts beside the runs' total cost", async () => {
    const [c] = await weft.db.all<{ id: string }>(sql`SELECT id FROM workers WHERE type = 'contractor' ORDER BY id LIMIT 1`);
    await weft.db.run(sql`INSERT INTO contractor_payments (id, worker_id, amount_minor, currency, fx_rate, usd_cents, status, scheduled_for) VALUES
      ('ctp_w4a1', ${c!.id}, 400000, 'USD', '1', 400000, 'paid', '2026-09-20'),
      ('ctp_w4a2', ${c!.id}, 250000, 'USD', '1', 250000, 'paid', '2026-10-05'),
      ('ctp_w4a3', ${c!.id}, 999900, 'USD', '1', 999900, 'scheduled', '2026-10-20')`);
    const { out } = await w4("contractor_vs_employee_cost_by_month", { from: "2026-08-01", to: "2026-10-31" });
    expect(out.rows.map((r) => r.period)).toEqual(["2026-09", "2026-10"]);   // August paid nothing, so no row
    const runs = await weft.db.all<{ m: string; t: number }>(sql`SELECT substr(payday, 1, 7) AS m, sum(json_extract(totals_json, '$.totalCost.amount')) AS t FROM payroll_runs WHERE status IN ('processing', 'processed') GROUP BY m`);
    expect(out.rows[0]).toMatchObject({ employee_cents: runs.find((r) => r.m === "2026-09")!.t, contractor_cents: 400000 });
    expect(out.rows[1]).toMatchObject({ employee_cents: runs.find((r) => r.m === "2026-10")!.t, contractor_cents: 250000 });   // the scheduled payout is not paid yet
    for (const r of out.rows) expect(r.total_cents).toBe(Number(r.employee_cents) + Number(r.contractor_cents));
    const q = (await w4("contractor_vs_employee_cost_by_month", { from: "2026-08-01", to: "2026-10-31", group_by: "quarter" })).out;
    expect(q.rows.map((r) => [r.period, r.contractor_cents])).toEqual([["2026-Q3", 400000], ["2026-Q4", 250000]]);
    await weft.db.run(sql`DELETE FROM contractor_payments WHERE id LIKE 'ctp_w4a%'`);
  });

  it("compliance_due_by_month counts done, open and overdue items by due month", async () => {
    const today = (await weft.clock.now()).slice(0, 10);
    await weft.db.run(sql`INSERT INTO compliance_items (id, company_id, kind, title, form, period, due_on, status, created_at) VALUES
      ('cal_w4a1', 'cmp_larkspur', 'filing', 'Form 941 (demo)', '941', '2026-Q2', '2026-07-31', 'done', ${today}),
      ('cal_w4a2', 'cmp_larkspur', 'filing', 'DE 9 (demo)', 'DE9', '2026-Q2', '2026-07-31', 'upcoming', ${today}),
      ('cal_w4a3', 'cmp_larkspur', 'filing', 'Form 941 (demo)', '941', '2026-Q4', '2027-01-31', 'upcoming', ${today}),
      ('cal_w4a4', 'cmp_larkspur', 'deposit', 'Deposit (demo)', '941', '2026-12', '2027-01-15', 'waived', ${today})`);
    const { out } = await w4("compliance_due_by_month", { from: "2026-07-01", to: "2027-01-31" });
    const jul = out.rows.find((r) => r.period === "2026-07")!, jan = out.rows.find((r) => r.period === "2027-01")!;
    expect(jul).toMatchObject({ items: 2, done: 1, overdue: 1, open: 0 });   // past due and not done reads as overdue
    expect(jan).toMatchObject({ items: 2, done: 1, overdue: 0, open: 1 });
    expect(out.rows.length).toBe(7);   // every month in the range, so an empty month shows as zero
    await weft.db.run(sql`DELETE FROM compliance_items WHERE id LIKE 'cal_w4a%'`);
  });

  it("rejects a bad range with a hint", async () => {
    const res = await post("/v1/tools/reports.breakdown", { metric: "payroll_cost_by_state", from: "2026-10-01", to: "2026-09-01" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_INPUT");
  });
});

describe("the Reports catalog", () => {
  it("lists all eleven metrics, and every one renders rows and a valid chart", async () => {
    const cat = (await (await weft.app.request("/v1/reports", { headers: weft.uiHeaders("usr_dana") })).json()) as { metric: string; label: string; unit: string; allowed: boolean; source: string }[];
    expect(cat.map((c) => c.metric)).toEqual([...ReportMetric.options, ...ReportMetricW4.options]);
    expect(cat.every((c) => c.allowed && c.label.length > 0)).toBe(true);
    for (const c of cat) {
      const res = c.source === "reports.query"
        ? await weft.app.request(`/v1/reports/${c.metric}?from=2026-01-01&to=2026-10-31`, { headers: weft.uiHeaders("usr_dana") })
        : await post("/v1/tools/reports.breakdown", { metric: c.metric, from: "2026-01-01", to: "2026-10-31" });
      expect(res.status, c.metric).toBe(200);
      const b = (await res.json()) as Record<string, unknown>;
      const out = (c.source === "reports.query" ? b : b.data) as Out;
      expect(ChartSpec.safeParse(out.chart).success, c.metric).toBe(true);
      expect(Array.isArray(out.rows), c.metric).toBe(true);
      expect(out.chart.series[0]!.unit, c.metric).toBe(c.unit);
    }
  });
});

describe("email this report", () => {
  it("files a comms.send_report proposal and sends nothing until a person approves", async () => {
    const before = (await weft.sims.email.list("cfo@larkspur.example")).length;
    const res = await post("/v1/reports/payroll_cost_by_state/send", { from: "2026-09-01", to: "2026-10-31", recipients: ["cfo@larkspur.example"] });
    expect(res.status).toBe(200);
    const o = (await res.json()) as { ok: boolean; status: string; proposalId: string };
    expect(o).toMatchObject({ ok: true, status: "pending_approval" });
    expect((await weft.sims.email.list("cfo@larkspur.example")).length).toBe(before);   // nothing sent yet
    const p = (await (await weft.app.request(`/v1/proposals/${o.proposalId}`, { headers: weft.uiHeaders("usr_dana") })).json()) as { command: string; content: { label: string; text: string }[] };
    expect(p.command).toBe("comms.send_report");
    const text = p.content.find((x) => x.label === "Content to be sent")!.text;
    const cost = (await w4("payroll_cost_by_state", { from: "2026-09-01", to: "2026-10-31" })).out;
    expect(text).toContain(String(cost.range_totals.total_display));
    const dec = await post(`/v1/proposals/${o.proposalId}/approve`, { reasonCode: null, note: null });
    expect(dec.status).toBe(200);
    const mail = await weft.sims.email.list("cfo@larkspur.example");
    expect(mail.length).toBe(before + 1);
    expect(mail.at(-1)).toMatchObject({ from: "reports@larkspur.example", subject: "Payroll cost by work state, 2026-09-01 to 2026-10-31" });
    expect(mail.at(-1)!.body).toBe(text);
  });

  it("refuses a recipient outside the simulated *.example mailboxes", async () => {
    const res = await post("/v1/reports/payroll_cost_by_month/send", { from: "2026-09-01", to: "2026-10-31", recipients: ["cfo@real-company.com"] });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_INPUT");
  });
});

describe("permissions matrix and per-action overrides", () => {
  it("shows each person's levels, what the agent may do for them and the agent's own row", async () => {
    const res = await weft.app.request("/v1/permissions/matrix", { headers: weft.uiHeaders("usr_theo") });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as PermissionMatrixRow[];
    for (const r of rows) expect(PermissionMatrixRow.safeParse(r).success).toBe(true);
    const theo = rows.find((r) => r.principalId === "usr_theo")!;
    expect(theo.domains).toMatchObject({ payroll: "approve", benefits: "none", people: "view" });
    // The agent grant is payroll edit, so acting for Theo it gets edit (approve is capped), and nothing on benefits.
    expect(theo.agentDomains).toMatchObject({ payroll: "edit", benefits: "none", people: "view" });
    const agent = rows.at(-1)!;
    expect(agent).toMatchObject({ principalId: "agt_weft", role: "agent" });
    expect(Object.values(agent.agentDomains)).not.toContain("approve");
  });

  it("an override is a proposal, and approving it lands in the matrix", async () => {
    const res = await post("/v1/permissions/agent-actions", { principalId: "usr_sam", command: "comms.send_message", mode: "propose_only" });
    const o = (await res.json()) as { ok: boolean; status: string; proposalId: string };
    expect(o).toMatchObject({ ok: true, status: "pending_approval" });
    let rows = (await (await weft.app.request("/v1/permissions/matrix", { headers: weft.uiHeaders("usr_dana") })).json()) as PermissionMatrixRow[];
    expect(rows.find((r) => r.principalId === "usr_sam")!.overrides).toEqual([]);
    expect((await post(`/v1/proposals/${o.proposalId}/approve`, { reasonCode: null, note: null })).status).toBe(200);
    rows = (await (await weft.app.request("/v1/permissions/matrix", { headers: weft.uiHeaders("usr_dana") })).json()) as PermissionMatrixRow[];
    expect(rows.find((r) => r.principalId === "usr_sam")!.overrides).toMatchObject([{ command: "comms.send_message", mode: "propose_only", setBy: "usr_dana" }]);
    // Clearing is a proposal too.
    const clear = (await (await post("/v1/permissions/agent-actions", { principalId: "usr_sam", command: "comms.send_message", mode: "clear" })).json()) as { proposalId: string };
    await post(`/v1/proposals/${clear.proposalId}/approve`, { reasonCode: null, note: null });
    rows = (await (await weft.app.request("/v1/permissions/matrix", { headers: weft.uiHeaders("usr_dana") })).json()) as PermissionMatrixRow[];
    expect(rows.find((r) => r.principalId === "usr_sam")!.overrides).toEqual([]);
  });

  it("refuses an override on a command the agent can never call, or propose_only on a read", async () => {
    const human = (await (await post("/v1/permissions/agent-actions", { principalId: "usr_sam", command: "settings.set_agent_action_override", mode: "deny" })).json()) as { code: string };
    expect(human.code).toBe("DOMAIN_NOT_AGENT_CALLABLE");
    const read = (await (await post("/v1/permissions/agent-actions", { principalId: "usr_sam", command: "people.search", mode: "propose_only" })).json()) as { code: string };
    expect(read.code).toBe("DOMAIN_READ_ONLY");
  });

  it("a person without payroll view cannot read a payroll metric", async () => {
    await weft.db.run(sql`UPDATE principals SET grants_json = json_set(grants_json, '$.payroll', 'none') WHERE id = 'usr_sam'`);
    const { status, raw } = await w4("payroll_cost_by_state", {}, "usr_sam");
    expect(status).toBe(422);
    expect(raw.code).toBe("NOT_PERMITTED");
    const cat = (await (await weft.app.request("/v1/reports", { headers: weft.uiHeaders("usr_sam") })).json()) as { metric: string; allowed: boolean }[];
    expect(cat.find((c) => c.metric === "payroll_cost_by_state")!.allowed).toBe(false);
    expect(cat.find((c) => c.metric === "headcount_by_state")!.allowed).toBe(true);
    await weft.db.run(sql`UPDATE principals SET grants_json = json_set(grants_json, '$.payroll', 'view') WHERE id = 'usr_sam'`);
  });
});
