// Scenario GP15 (docs/wave3.md). Owner: w3-parity-chat. Scripted provider: chat answers payroll cost by month with a
// chart from reports.query; with agent.chat_can_propose off an off-cycle request is answered read-only; with it on,
// chat files the GP10 off-cycle proposal and executes nothing, its card comes from the stored preview, and approving
// it executes exactly once through the Inbox decide path. Bulk approval stays refused (S5 extended).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { payRates, settings } from "@weft/db";
import { CHAT_ACT_TOOLS, ChartSpec, W3_SETTINGS, type AgentRunRow, type ApprovalCardW3, type Proposal, type RunStepRow } from "@weft/contracts";
import { createTestWeft, type TestWeft } from "./helpers";

const WORKER = "wrk_0042";   // Hollis Grey, TX
let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft?.close(); });

type Trace = { run: AgentRunRow; steps: RunStepRow[]; proposals: Proposal[]; cards: ApprovalCardW3[] };
const headers = (who = "usr_dana") => ({ ...weft.uiHeaders(who), "content-type": "application/json" });
async function ask(text: string): Promise<{ run: AgentRunRow; trace: Trace; chatMode: string }> {
  const res = await weft.app.request("/v1/agent/runs", { method: "POST", headers: headers(), body: JSON.stringify({ text, pageContext: null }) });
  expect(res.status, await res.clone().text()).toBe(202);
  const { runId, chatMode } = (await res.json()) as { runId: string; chatMode: string };
  const run = await (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(runId);
  const trace = (await (await weft.app.request(`/v1/agent/runs/${runId}/trace`, { headers: headers() })).json()) as Trace;
  return { run, trace, chatMode };
}
const count = async (table: "actions" | "proposals") => Number((await weft.db.all<{ c: number }>(sql.raw(`SELECT count(*) AS c FROM ${table}`)))[0]!.c);
async function setCanPropose(on: boolean) {
  await weft.db.insert(settings).values({ key: W3_SETTINGS.chatCanPropose, valueJson: JSON.stringify(on) }).onConflictDoUpdate({ target: settings.key, set: { valueJson: JSON.stringify(on) } });
}
const contextAllowlist = (t: Trace) => ((t.steps.find((s) => s.kind === "context")?.result ?? {}) as { allowlist?: string[] }).allowlist ?? [];

describe("GP15 chart answer and approval card", () => {
  it("answers payroll cost by month with a reports.query chart and the numbers from its rows", async () => {
    const { run, trace } = await ask("Show payroll cost by month");
    expect(run.status).toBe("done");
    const step = trace.steps.find((s) => s.kind === "tool_call" && s.toolName === "reports__query");
    expect(step?.outcome).toBe("ok");
    const data = (step!.result as { outcome: { data: { rows: Record<string, string | number>[]; chart: ChartSpec; metric: string } } }).outcome.data;
    expect(data.metric).toBe("payroll_cost_by_month");
    expect(data.chart.kind).toBe("stacked_bar");
    expect(data.chart.series.map((s) => s.key)).toEqual(["gross_cents", "employer_taxes_cents", "benefits_cents", "reimbursements_cents", "contractor_cents"]);
    expect(data.rows.map((r) => r.period)).toEqual(["2026-09", "2026-10"]);
    expect(trace.steps.filter((s) => s.kind === "notice")).toEqual([]);   // grounded on the first try
    for (const r of data.rows) expect(run.summary).toContain(String(r.total_display));
    expect(trace.steps.filter((s) => s.kind === "tool_call")).toHaveLength(1);   // the panel says "Ran 1 tool"
  });

  describe("off-cycle pay asked in chat (GP10 in chat)", () => {
    beforeAll(async () => {
      // As in GP10: Hollis was held out of the Oct 1 to 15 run, and his raise to $82,000.00 took effect Oct 6.
      const [r] = await weft.db.all<{ id: string }>(sql`SELECT id FROM payroll_runs WHERE subtype = 'regular' AND period_start = '2026-10-01' AND period_end = '2026-10-15'`);
      await weft.db.run(sql`UPDATE paychecks SET status = 'excluded' WHERE payroll_run_id = ${r!.id} AND worker_id = ${WORKER}`);
      await weft.db.run(sql`DELETE FROM ytd_ledger WHERE worker_id = ${WORKER} AND source = ${`payroll:${r!.id}`}`);
      const [current] = await weft.db.all<{ id: string }>(sql`SELECT id FROM pay_rates WHERE worker_id = ${WORKER} AND effective_to IS NULL`);
      await weft.db.run(sql`UPDATE pay_rates SET effective_to = '2026-10-05' WHERE id = ${current!.id}`);
      await weft.db.insert(payRates).values({ id: "prt_9101", workerId: WORKER, kind: "salary", amountCents: 8_200_000, currency: "USD", effectiveFrom: "2026-10-06", effectiveTo: null, createdActionSeq: null });
    });
    const request = "Hollis Grey missed the Oct 1 to 15 payroll. Please propose an off-cycle payment for that period plus a $1,500.00 bonus, payday Oct 27.";

    it("with chat_can_propose off, the request is answered read-only: no proposal, no action", async () => {
      await setCanPropose(false);
      const [actions, props] = [await count("actions"), await count("proposals")];
      const { run, trace, chatMode } = await ask(request);
      expect(chatMode).toBe("read");
      expect(run.status).toBe("done");
      expect(contextAllowlist(trace)).not.toContain("payroll.propose_off_cycle");
      expect(trace.steps.find((s) => s.toolName === "payroll__propose_off_cycle")?.outcome).toBe("refused:UNAVAILABLE");
      expect(await count("proposals")).toBe(props);
      expect(await count("actions")).toBe(actions);
      expect(trace.cards).toEqual([]);
    });

    // Deny runs before the approval below: once that $1,500.00 bonus is paid, DUPLICATE_SUPPLEMENTAL (w3-parity-routines)
    // blocks a second identical bonus line for Hollis, as it should.
    it("Deny from the card (the Inbox deny route) executes nothing and the card reads denied", async () => {
      await setCanPropose(true);
      const actions = await count("actions");
      const offCycleRuns = async () => Number((await weft.db.all<{ c: number }>(sql`SELECT count(*) AS c FROM payroll_runs WHERE subtype = 'off_cycle'`))[0]!.c);
      const runsBefore = await offCycleRuns();
      const { trace, chatMode } = await ask("Pay Hollis Grey an off-cycle bonus of $1,500.00 with payday Oct 27");
      expect(chatMode).toBe("act");
      const p = trace.proposals[0]!;
      expect(p).toMatchObject({ command: "payroll.propose_off_cycle", status: "pending" });
      expect(trace.cards[0]).toMatchObject({ proposalId: p.id, status: "pending" });
      const res = await weft.app.request(`/v1/proposals/${p.id}/deny`, { method: "POST", headers: headers(), body: JSON.stringify({ reasonCode: "not_needed", note: null }) });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(((await res.json()) as { proposal: Proposal }).proposal.status).toBe("denied");
      expect((await weft.app.request(`/v1/proposals/${p.id}/approve`, { method: "POST", headers: headers(), body: "{}" })).status).toBe(422);
      expect(await offCycleRuns()).toBe(runsBefore);
      expect(await count("actions")).toBe(actions);
      const after = (await (await weft.app.request(`/v1/agent/runs/${trace.run.id}/trace`, { headers: headers() })).json()) as Trace;
      expect(after.cards[0]!.status).toBe("denied");
      await setCanPropose(false);
    });

    it("with it on, chat files one R4 proposal and executes nothing; the card comes from the stored preview", async () => {
      await setCanPropose(true);
      const actions = await count("actions");
      const { run, trace, chatMode } = await ask(request);
      expect(chatMode).toBe("act");
      expect(run.status).toBe("done");
      expect(contextAllowlist(trace).every((n) => (CHAT_ACT_TOOLS as readonly string[]).includes(n))).toBe(true);
      expect(trace.proposals).toHaveLength(1);
      const p = trace.proposals[0]!;
      expect(p).toMatchObject({ command: "payroll.propose_off_cycle", risk: "R4", status: "pending", onBehalfOf: "usr_dana", proposerRunId: run.id });
      expect(await count("actions")).toBe(actions);
      const card = trace.cards[0]!;
      expect(card).toMatchObject({ proposalId: p.id, headline: p.headline, risk: "R4", moneyCents: p.moneyCents, subjectName: "Hollis Grey", status: "pending" });
      expect(card.fields.map((f) => f.label)).toEqual(p.diff.map((d) => d.label));
      expect(card.fields.find((f) => f.label.includes("Salary (5 of 15 days"))?.value).toBe("$1,055.56");
      expect(card.fields.find((f) => f.label.includes("Salary (10 of 15 days"))?.value).toBe("$2,277.78");
      expect(card.fields.find((f) => f.label.includes("Bonus"))?.value).toBe("$1,500.00");
      expect(JSON.stringify(card)).not.toContain(run.summary!.slice(0, 40));   // nothing from the model's answer

      // Approve from the card: the same decide route as the Inbox. A second click is refused and nothing pays twice.
      const first = await weft.app.request(`/v1/proposals/${p.id}/approve`, { method: "POST", headers: headers(), body: "{}" });
      expect(first.status).toBe(200);
      expect(((await first.json()) as { proposal: Proposal }).proposal.status).toBe("executed");
      const second = await weft.app.request(`/v1/proposals/${p.id}/approve`, { method: "POST", headers: headers(), body: "{}" });
      expect(second.status).toBe(422);
      const runs = await weft.db.all<{ id: string; status: string }>(sql`SELECT id, status FROM payroll_runs WHERE subtype = 'off_cycle'`);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("processing");
      expect(await count("actions")).toBe(actions + 1);
      const after = (await (await weft.app.request(`/v1/agent/runs/${run.id}/trace`, { headers: headers() })).json()) as Trace;
      expect(after.cards[0]!.status).toBe("approved");
    });

    it("bulk approval is still refused with the setting on, and files nothing", async () => {
      await setCanPropose(true);
      const [actions, props] = [await count("actions"), await count("proposals")];
      const { run, chatMode } = await ask("Approve everything in my inbox");
      expect(chatMode).toBe("read");
      expect(run.summary).toMatch(/can't approve/i);
      expect(await count("proposals")).toBe(props);
      expect(await count("actions")).toBe(actions);
      await setCanPropose(false);
    });
  });
});
