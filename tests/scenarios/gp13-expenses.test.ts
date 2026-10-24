// Scenario GP13 (docs/wave3.md 5): expense review to reimbursement. Owner: w3-expenses. Scripted provider
// (scenarios/rt_expense_review.json). The routine explains each needs-review item and proposes exactly one decision per
// item; nothing is decided until a person approves. Vic approves two proposals in the Inbox; the open draft carries
// their reimbursements on Mateo's paycheck outside gross, and processing the run marks them Paid out.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { PayrollRun, type AgentRunRow, type RoutineRun } from "@weft/contracts";
import { actions, expenses, paychecks, proposals } from "@weft/db";
import { BUDGETS } from "../../packages/agent/src/loop";
import { EXPENSE_REVIEW_MAX_ITEMS, RT_EXPENSE_REVIEW, reviewBatchPlan } from "../../packages/routines/src/wave3/expenses";
import { createTestWeft, type TestWeft } from "./helpers";

let weft: TestWeft;
beforeAll(async () => {
  weft = await createTestWeft();
  await (weft.routines as unknown as { ensurePrebuilt(): Promise<void> }).ensurePrebuilt();
});
afterAll(async () => {
  for (let i = 0; i < 10; i++) {
    const runs = await weft.db.all<{ id: string }>(sql`SELECT id FROM agent_runs WHERE status IN ('queued', 'running')`);
    const open = await weft.db.all<{ id: string }>(sql`SELECT id FROM routine_runs WHERE status IN ('queued', 'running')`);
    if (!runs.length && !open.length) break;
    for (const r of runs) await (weft.agent as unknown as { settled(id: string): Promise<unknown> }).settled(r.id);
    for (const r of open) await (weft.routines as unknown as { settled(id: string): Promise<unknown> }).settled(r.id);
  }
  await weft.close();
});
const call = async (method: string, path: string, body?: unknown, who = "usr_dana") => {
  const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};
const RUN = "pay_2026_10_30";
const decideProposals = async () => (await weft.db.select().from(proposals)).filter((p) => p.command === "expenses.decide");

describe("GP13 expense review to reimbursement", () => {
  it("Expenses shows the four bands with the seeded counts", async () => {
    expect((await call("GET", "/v1/expenses")).json.bands).toEqual({ needs_review: 8, approved: 4, paid_out: 0, declined: 2 });
    expect(RT_EXPENSE_REVIEW.tools).toHaveLength(8);
    expect(RT_EXPENSE_REVIEW.enabled).toBe(false);
    // One run's decisions fit in one model turn, so the recipe's second turn never runs into CALL_BUDGET.
    expect(EXPENSE_REVIEW_MAX_ITEMS).toBeLessThanOrEqual(BUDGETS.routine.toolCallsPerStep);
  });

  it("rt_expense_review explains each item and proposes exactly one decision per item; nothing executes", async () => {
    const { routineRunId } = (await call("POST", "/v1/routines/rt_expense_review/trigger", {})).json as { routineRunId: string };
    let rr = await (weft.routines as unknown as { settled(id: string): Promise<RoutineRun> }).settled(routineRunId);
    expect(rr.agentRunId, JSON.stringify(rr)).toBeTruthy();
    const agentRun = await (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(rr.agentRunId!);
    rr = await (weft.routines as unknown as { settled(id: string): Promise<RoutineRun> }).settled(routineRunId);
    expect(agentRun.status, JSON.stringify(agentRun)).not.toBe("failed");
    const props = await decideProposals();
    const byItem = Object.fromEntries(props.map((p) => { const a = JSON.parse(p.argsJson!) as { expense_id: string; decision: string; reason_code?: string }; return [a.expense_id, `${a.decision}${a.reason_code ? `:${a.reason_code}` : ""}`]; }));
    expect(props).toHaveLength(8);
    expect(byItem).toEqual({
      exp_0001: "approve", exp_0002: "return", exp_0003: "approve", exp_0004: "approve",
      exp_0005: "return", exp_0006: "approve", exp_0007: "decline:duplicate", exp_0008: "approve_taxable",
    });
    expect(props.every((p) => p.status === "pending" && p.subjectRef === `expense:${JSON.parse(p.argsJson!).expense_id}`)).toBe(true);
    // The CA over-limit item carries the human note, and nothing decided it.
    const e4 = props.find((p) => JSON.parse(p.argsJson!).expense_id === "exp_0004")!;
    expect(JSON.parse(e4.contentJson)[0].text).toMatch(/California workers must be reimbursed/);
    expect(e4.headline).toBe("Approve expense exp_0004 for Kofi Mensah (wrk_0018): $1,249.00 equipment on 2026-10-14");
    expect((await weft.db.select().from(actions)).filter((a) => a.command === "expenses.decide")).toHaveLength(0);
    const rows = await weft.db.select().from(expenses);
    expect(rows.filter((e) => e.id <= "exp_0008").every((e) => e.status === "needs_review" && e.explanation && e.explanationSource === "template")).toBe(true);
    expect(["waiting_approval", "done"]).toContain(rr.status);
    // The batched recipe: one expenses.explain call that carries all 8 items, then one turn with one expenses.decide
    // per item, then the summary. Three model steps, never one step per item.
    expect(agentRun.stepsUsed).toBe(3);
    const steps = await weft.db.all<{ parent_n: number | null; tool_name: string | null; tool_args_json: string | null }>(sql`SELECT parent_n, tool_name, tool_args_json FROM run_steps WHERE run_id = ${agentRun.id} AND kind = 'tool_call' ORDER BY n`);
    const explains = steps.filter((s) => s.tool_name === "expenses__explain");
    expect(explains).toHaveLength(1);
    expect((JSON.parse(explains[0]!.tool_args_json!) as { items: { expense_id: string }[] }).items.map((x) => x.expense_id)).toEqual(Object.keys(byItem).sort());
    const decides = steps.filter((s) => s.tool_name === "expenses__decide");
    expect(decides).toHaveLength(8);
    expect(new Set(decides.map((s) => s.parent_n)).size).toBe(1);
    expect(decides.every((s) => typeof (JSON.parse(s.tool_args_json!) as { expense_id: unknown }).expense_id === "string")).toBe(true);
    // The live model reads that trajectory from the derived batch_plan in its context pack.
    const pack = await weft.db.all<{ result_json: string }>(sql`SELECT result_json FROM run_steps WHERE run_id = ${agentRun.id} AND kind = 'context' AND result_json LIKE '%"pack"%'`);
    expect(pack[0]?.result_json).toContain(JSON.stringify(reviewBatchPlan(8)).slice(1, -1));
  });

  it("Vic approves two proposals; the draft carries them outside gross; processing marks them paid", async () => {
    const before = PayrollRun.parse((await call("GET", `/v1/payrolls/${RUN}`)).json).totals!;
    const mateo0 = (await weft.db.select().from(paychecks).where(eq(paychecks.payrollRunId, RUN))).find((p) => p.workerId === "wrk_0005")!;
    for (const id of ["exp_0001", "exp_0006"]) {
      const p = (await decideProposals()).find((x) => JSON.parse(x.argsJson!).expense_id === id)!;
      const res = await call("POST", `/v1/proposals/${p.id}/approve`, { reasonCode: null, note: null });
      expect(res.json.outcome, JSON.stringify(res.json).slice(0, 400)).toMatchObject({ ok: true, status: "done" });
    }
    const mateo = (await weft.db.select().from(paychecks).where(eq(paychecks.payrollRunId, RUN))).find((p) => p.workerId === "wrk_0005")!;
    expect(mateo.reimbursementsCents).toBe(47_622);
    expect([mateo.grossCents, mateo.netCents]).toEqual([mateo0.grossCents, mateo0.netCents]);
    const after = PayrollRun.parse((await call("GET", `/v1/payrolls/${RUN}`)).json).totals!;
    expect(after.grossPay.amount).toBe(before.grossPay.amount);
    expect(after.reimbursements.amount - before.reimbursements.amount).toBe(47_622);
    expect((await weft.db.select().from(expenses).where(eq(expenses.id, "exp_0001")))[0]).toMatchObject({ status: "scheduled", decidedBy: "usr_dana", payrollRunId: RUN });
    const sub = await weft.executor.human.exec({ principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui", keyScope: null }, "payroll.submit_run", { run_id: RUN, exclude_blocked: true });
    expect(sub.ok, JSON.stringify(sub)).toBe(true);
    await weft.clock.advance("2026-10-30T13:00:00.000Z");
    await weft.scheduler.tick();
    await weft.scheduler.tick();
    expect((await call("GET", "/v1/expenses?band=paid_out")).json.data.map((e: { id: string }) => e.id)).toEqual(["exp_0001", "exp_0006"]);
  });
});
