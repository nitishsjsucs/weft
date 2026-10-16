// Expenses on the seeded world (owner: w3-expenses, GP13): the four bands, the seeded hand-computed cases, one decision
// per call, reimbursements on the open draft outside gross (E10), approve as taxable inside gross (E11), paid on
// processing, after-deadline approvals on the next draft (E12) and paid is final (E14).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PayrollRun } from "@weft/contracts";
import { events, expenses, paychecks, payrollRuns } from "@weft/db";
import { W3ExpensesDetail, W3ExpensesPage } from "../../../packages/contracts/src/ext/w3-expenses";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft.close(); });
const get = (p: string, who = "usr_dana") => weft.app.request(p, { headers: weft.uiHeaders(who) });
const post = (p: string, body: unknown, who = "usr_dana") => weft.app.request(p, { method: "POST", headers: { ...weft.uiHeaders(who), "content-type": "application/json" }, body: JSON.stringify(body) });
const RUN = "pay_2026_10_30";
const page = async (q = "") => W3ExpensesPage.parse(await (await get(`/v1/expenses${q}`)).json());
const detail = async (id: string) => W3ExpensesDetail.parse(await (await get(`/v1/expenses/${id}`)).json());
const run = async () => PayrollRun.parse(await (await get(`/v1/payrolls/${RUN}`)).json());
const pc = async (workerId: string, runId = RUN) => (await weft.db.select().from(paychecks).where(eq(paychecks.payrollRunId, runId))).find((p) => p.workerId === workerId)!;
const taxOf = (p: { taxesJson: string }, code: string) => (JSON.parse(p.taxesJson) as { code: string; payer: string; amount_cents: number }[]).filter((t) => t.code === code && t.payer === "employee").reduce((s, t) => s + t.amount_cents, 0);

describe("expenses (GP13)", () => {
  let before: { totals: string; mateo: typeof paychecks.$inferSelect; wren: typeof paychecks.$inferSelect };

  it("seeds the four bands: 8 needs review, 4 approved, 0 paid out, 2 declined; nothing rides the open draft", async () => {
    const all = await page("?limit=100");
    expect(all.bands).toEqual({ needs_review: 8, approved: 4, paid_out: 0, declined: 2 });
    expect(all.data.every((e) => e.merchant.endsWith("(demo)") && e.workerName.endsWith("(demo)"))).toBe(true);
    expect((await page("?band=needs_review")).data.map((e) => e.id)).toEqual(["exp_0001", "exp_0002", "exp_0003", "exp_0004", "exp_0005", "exp_0006", "exp_0007", "exp_0008"]);
    const rules = Object.fromEntries((await page("?band=needs_review")).data.map((e) => [e.id, e.checks.map((c) => `${c.rule}:${c.severity}`).sort().join(",")]));
    expect(rules).toEqual({
      exp_0001: "", exp_0002: "MEALS_DETAIL_MISSING:review,OVER_CATEGORY_LIMIT:review", exp_0003: "RECEIPT_MISSING:info",
      exp_0004: "CA_NECESSARY_EXPENSE:info,OVER_CATEGORY_LIMIT:review,SECOND_APPROVER:info", exp_0005: "OVER_CATEGORY_LIMIT:review,RECEIPT_MISSING:block",
      exp_0006: "", exp_0007: "DUPLICATE:block,OVER_CATEGORY_LIMIT:review", exp_0008: "ACCOUNTABLE_WINDOW:review",
    });
    const suggestions = await Promise.all(["exp_0001", "exp_0002", "exp_0004", "exp_0005", "exp_0007", "exp_0008"].map(async (id) => (await detail(id)).suggestion?.decision));
    expect(suggestions).toEqual(["approve", "return", "approve", "return", "decline", "approve_taxable"]);
    // GP2 is unchanged: no reimbursements on the draft, and recomputing it gives the same totals.
    const r = await run();
    expect(r.totals!.reimbursements.amount).toBe(0);
    expect((await weft.db.select().from(paychecks).where(eq(paychecks.payrollRunId, RUN))).every((p) => p.reimbursementsCents === 0 && p.reimbursementsJson === "[]")).toBe(true);
    const totals = (await weft.db.select().from(payrollRuns).where(eq(payrollRuns.id, RUN)))[0]!.totalsJson!;
    expect((await post(`/v1/payrolls/${RUN}/preview`, {})).status).toBeLessThan(500);
    expect((await weft.db.select().from(payrollRuns).where(eq(payrollRuns.id, RUN)))[0]!.totalsJson).toBe(totals);
    before = { totals, mateo: await pc("wrk_0005"), wren: await pc("wrk_0019") };
  });

  it("refuses decisions the policy does not allow, a decline without a reason and an item already decided", async () => {
    const dup = await post("/v1/expenses/exp_0007/decide", { decision: "approve" });
    expect(dup.status).toBe(422);
    expect(await dup.json()).toMatchObject({ code: "DOMAIN_DECISION_NOT_ALLOWED" });
    expect(await (await post("/v1/expenses/exp_0008/decide", { decision: "approve" })).json()).toMatchObject({ code: "DOMAIN_DECISION_NOT_ALLOWED" });
    expect(await (await post("/v1/expenses/exp_0007/decide", { decision: "decline" })).json()).toMatchObject({ code: "DOMAIN_REASON_REQUIRED" });
    expect(await (await post("/v1/expenses/exp_0009/decide", { decision: "approve" })).json()).toMatchObject({ code: "DOMAIN_NOT_DECIDABLE" });
    expect((await post("/v1/expenses/exp_0001/decide", { decision: "approve", expenseIds: ["exp_0001", "exp_0006"] })).status).toBe(400);
  });

  it("E10: approving E1 and E6 puts $476.22 on Mateo's Oct 30 paycheck outside gross, inside the bank entry and the totals", async () => {
    for (const id of ["exp_0001", "exp_0006"]) {
      const res = await post(`/v1/expenses/${id}/decide`, { decision: "approve" });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, status: "done", data: { status: "scheduled", payroll_run_id: RUN } });
    }
    const m = await pc("wrk_0005");
    expect(m.reimbursementsCents).toBe(47_622);
    expect(JSON.parse(m.reimbursementsJson)).toEqual([{ expenseId: "exp_0001", category: "travel", amountCents: 41_238 }, { expenseId: "exp_0006", category: "mileage", amountCents: 6_384 }]);
    expect([m.grossCents, m.netCents, m.taxesJson]).toEqual([before.mateo.grossCents, before.mateo.netCents, before.mateo.taxesJson]);
    const t0 = JSON.parse(before.totals) as Record<string, { amount: number }>;
    const t1 = (await run()).totals!;
    expect(t1.reimbursements.amount).toBe(47_622);
    expect(t1.totalCost.amount - t0.totalCost!.amount).toBe(47_622);
    expect(t1.grossPay.amount).toBe(t0.grossPay!.amount);
    expect(t1.netPay.amount).toBe(t0.netPay!.amount);
    expect(t1.cashRequirement.amount).toBe(t1.totalCost.amount);
    const d = await detail("exp_0001");
    expect(d).toMatchObject({ status: "scheduled", band: "approved", payrollRunId: RUN, payrollRunStatus: "draft", decidedBy: "usr_dana", paycheckId: m.id });
    expect(d.trail.map((a) => a.command)).toEqual(["expenses.decide"]);
    expect((await weft.db.select().from(events).where(eq(events.type, "expense.decided"))).map((e) => e.subjectRef)).toEqual(["exp_0001", "exp_0006"]);
  });

  it("E11: approve as taxable (E8, 81 days late) adds a taxable_reimbursement earning inside gross", async () => {
    const res = await post("/v1/expenses/exp_0008/decide", { decision: "approve_taxable", note: "Late, paid as wages" });
    expect(await res.json()).toMatchObject({ ok: true, data: { status: "approved_taxable", payroll_run_id: RUN } });
    const w = await pc("wrk_0019");
    expect((JSON.parse(w.earningsJson) as { type: string; amountCents: number }[]).find((e) => e.type === "taxable_reimbursement")).toEqual({ type: "taxable_reimbursement", amountCents: 5_420, hoursX100: null });
    expect(w.grossCents - before.wren.grossCents).toBe(5_420);
    expect(w.reimbursementsCents).toBe(0);
    // Hand values: social security round(5,420 x 0.062) = 336, Medicare round(5,420 x 0.0145) = 79; the engine rounds the
    // whole paycheck's line once, so the change can differ from the separate rounding by a cent.
    expect(Math.abs(taxOf(w, "ss") - taxOf(before.wren, "ss") - 336)).toBeLessThanOrEqual(1);
    expect(Math.abs(taxOf(w, "medicare") - taxOf(before.wren, "medicare") - 79)).toBeLessThanOrEqual(1);
  });

  it("reopen takes an item off the draft until it is paid; returns and declines need their fields", async () => {
    expect(await (await post("/v1/expenses/exp_0008/reopen", {})).json()).toMatchObject({ ok: true, data: { before: "approved_taxable", detached_from: RUN } });
    expect((await pc("wrk_0019")).grossCents).toBe(before.wren.grossCents);
    expect(await (await post("/v1/expenses/exp_0002/decide", { decision: "return" })).json()).toMatchObject({ code: "DOMAIN_NOTE_REQUIRED" });
    expect(await (await post("/v1/expenses/exp_0002/decide", { decision: "return", note: "Please add who attended." })).json()).toMatchObject({ ok: true, data: { status: "returned" } });
    expect(await (await post("/v1/expenses/exp_0007/decide", { decision: "decline", reasonCode: "duplicate" })).json()).toMatchObject({ ok: true, data: { status: "declined" } });
    expect((await page()).bands).toEqual({ needs_review: 5, approved: 6, paid_out: 0, declined: 3 });
  });

  it("processing the run marks its reimbursements paid; E14 paid is final", async () => {
    const sub = await weft.executor.human.exec({ principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui", keyScope: null }, "payroll.submit_run", { run_id: RUN, exclude_blocked: true });
    expect(sub.ok, JSON.stringify(sub)).toBe(true);
    expect((await detail("exp_0001")).payrollRunStatus).toBe("processing");
    expect(await (await post("/v1/expenses/exp_0001/reopen", {})).json()).toMatchObject({ code: "DOMAIN_NOT_REVERSIBLE", message: `Not reversible: ${RUN} is processing` });
    await weft.clock.advance("2026-10-30T13:00:00.000Z");   // Fri Oct 30 06:00 PT
    await weft.scheduler.tick();
    await weft.scheduler.tick();
    expect((await run()).status).toBe("processed");
    const rows = await weft.db.select().from(expenses);
    expect(rows.filter((e) => e.status === "paid").map((e) => e.id)).toEqual(["exp_0001", "exp_0006"]);
    expect((await page()).bands.paid_out).toBe(2);
    expect((await weft.db.select().from(events).where(eq(events.type, "expense.paid"))).map((e) => e.subjectRef)).toEqual(["exp_0001", "exp_0006"]);
    const again = await post("/v1/expenses/exp_0001/reopen", {});
    expect(await again.json()).toMatchObject({ code: "DOMAIN_NOT_REVERSIBLE", message: `Not reversible: paid in ${RUN}` });
    expect((await detail("exp_0001")).reopenBlocker).toBe(`Not reversible: paid in ${RUN}`);
  });

  it("E12: an approval after the deadline waits for the next draft, and the next draft picks it up with the imported approvals", async () => {
    const res = await post("/v1/expenses/exp_0003/decide", { decision: "approve" });
    expect(await res.json()).toMatchObject({ ok: true, data: { status: "approved", payroll_run_id: null } });
    const created = await weft.executor.human.exec({ principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui", keyScope: null }, "payroll.create_draft", { pay_schedule_id: "ps_us_semimonthly", period_end: "2026-11-15" });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    await weft.scheduler.tick();
    const next = "pay_2026_11_13";
    const rows = await weft.db.select().from(expenses).where(eq(expenses.payrollRunId, next));
    expect(rows.map((e) => e.id).sort()).toEqual(["exp_0003", "exp_0009", "exp_0010", "exp_0011", "exp_0012"]);
    expect((await pc("wrk_0043", next)).reimbursementsCents).toBe(4_800);
    expect(PayrollRun.parse(await (await get(`/v1/payrolls/${next}`)).json()).totals!.reimbursements.amount).toBe(4_800 + 9_600 + 6_450 + 3_275 + 9_120);
  });

  it("people who are not admins see only their own expenses", async () => {
    expect((await page("")).count).toBeGreaterThan(0);
    const sam = W3ExpensesPage.parse(await (await get("/v1/expenses", "usr_sam")).json());
    expect(sam.data.every((e) => e.workerId === "wrk_0025")).toBe(true);
    expect((await get("/v1/expenses?workerId=wrk_0005", "usr_sam")).status).toBe(403);
    expect((await get("/v1/expenses/exp_0001", "usr_sam")).status).toBe(404);
    expect((await get("/v1/expenses/exp_0001/receipt", "usr_sam")).status).toBe(403);
  });

  it("serves the policy with its sources and the receipt to admins only", async () => {
    const p = (await (await get("/v1/expense-policy")).json()) as { version: number; rules: Record<string, number>; sources: unknown[] };
    expect(p.version).toBe(1);
    expect(p.rules.receiptRequiredAtCents).toBe(7_500);
    const img = await get("/v1/expenses/exp_0001/receipt");
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await img.arrayBuffer()).subarray(1, 4).toString()).toBe("PNG");
    expect((await get("/v1/expenses/exp_0003/receipt")).status).toBe(404);
  });
});
