// Scenario GP10 (docs/wave2.md). Owner: w2-offboarding. Off-cycle pay on the scripted provider: an MCP agent proposes
// payroll.propose_off_cycle for one employee whose raise took effect mid-period plus a bonus; the preview lists every
// earning line in cents; Dana approves; the off_cycle run goes to the bank simulator like a regular run.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { payRates } from "@weft/db";
import { formatCents, type Proposal } from "@weft/contracts";
import { createTestWeft, type TestWeft } from "./helpers";

const WORKER = "wrk_0042";   // Hollis Grey (demo), TX, $76,000.00 a year

describe("GP10 off-cycle pay with a mid-period raise and a supplemental bonus", () => {
  let weft: TestWeft;
  let mcpKey = "";
  beforeAll(async () => {
    weft = await createTestWeft();
    mcpKey = readFileSync(join(weft.dataDir, "demo-mcp-key.txt"), "utf8").trim();
    // Hollis's paycheck was held out of the Oct 1 to 15 run (excluded), so that period really was missed.
    await missPeriod(WORKER);
    // The raise to $82,000.00 took effect Oct 6, inside the Oct 1 to 15 period that was missed.
    const [current] = await weft.db.all<{ id: string; amount_cents: number }>(sql`SELECT id, amount_cents FROM pay_rates WHERE worker_id = ${WORKER} AND effective_to IS NULL`);
    expect(current!.amount_cents).toBe(7_600_000);
    await weft.db.run(sql`UPDATE pay_rates SET effective_to = '2026-10-05' WHERE id = ${current!.id}`);
    await weft.db.insert(payRates).values({ id: "prt_9001", workerId: WORKER, kind: "salary", amountCents: 8_200_000, currency: "USD", effectiveFrom: "2026-10-06", effectiveTo: null, createdActionSeq: null });
  });
  afterAll(async () => { await weft.close(); });

  /** Excludes the worker from the processed Oct 1 to 15 regular run and drops its YTD rows, as if never paid. */
  async function missPeriod(workerId: string) {
    const [run] = await weft.db.all<{ id: string }>(sql`SELECT id FROM payroll_runs WHERE subtype = 'regular' AND period_start = '2026-10-01' AND period_end = '2026-10-15'`);
    await weft.db.run(sql`UPDATE paychecks SET status = 'excluded' WHERE payroll_run_id = ${run!.id} AND worker_id = ${workerId}`);
    await weft.db.run(sql`DELETE FROM ytd_ledger WHERE worker_id = ${workerId} AND source = ${`payroll:${run!.id}`}`);
  }

  const req = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    weft.app.request(path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  it("the agent proposes, the preview shows each line, approval submits the off_cycle run to the bank", async () => {
    const args = { worker_ids: [WORKER], period_start: "2026-10-01", period_end: "2026-10-15", payday: "2026-10-27", reason: "missed_payroll", bonuses: [{ worker_id: WORKER, cents: 150_000 }] };
    const res = await req("POST", "/v1/tools/payroll.propose_off_cycle", { "x-api-key": mcpKey }, args);
    const out = (await res.json()) as { ok: boolean; status: string; proposalId: string };
    expect(res.status).toBe(200);
    expect(out).toMatchObject({ ok: true, status: "pending_approval" });

    const dana = weft.uiHeaders("usr_dana");
    const p = (await (await req("GET", `/v1/proposals/${out.proposalId}`, dana)).json()) as Proposal;
    expect(p).toMatchObject({ command: "payroll.propose_off_cycle", risk: "R4", status: "pending" });
    const line = (prefix: string) => p.diff.find((d) => d.label.startsWith(`Hollis Grey (demo) (${WORKER}): ${prefix}`));
    // Oct 1 to 15 is 15 days: 5 at $76,000.00 and 10 at $82,000.00, one half-up rounding per line.
    expect(line("Salary (5 of 15 days")?.after).toBe("$1,055.56");    // 7,600,000 / 24 x 5 / 15 = 105,555.56
    expect(line("Salary (10 of 15 days")?.after).toBe("$2,277.78");   // 8,200,000 / 24 x 10 / 15 = 227,777.78
    expect(line("Bonus")?.after).toBe("$1,500.00");
    expect(p.headline).toMatch(/^Off-cycle pay \(missed payroll\) for 1 worker, 2026-10-01 to 2026-10-15, payday 2026-10-27/);

    const decided = await req("POST", `/v1/proposals/${p.id}/approve`, dana, {});
    expect(decided.status).toBe(200);
    expect(((await decided.json()) as { proposal: Proposal }).proposal.status).toBe("executed");

    const runs = await weft.db.all<{ id: string; subtype: string; status: string; bank_batch_id: string }>(sql`SELECT id, subtype, status, bank_batch_id FROM payroll_runs WHERE subtype = 'off_cycle'`);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ subtype: "off_cycle", status: "processing" });
    const [pyc] = await weft.db.all<{ earnings_json: string; taxes_json: string; net_cents: number; gross_cents: number }>(sql`SELECT earnings_json, taxes_json, net_cents, gross_cents FROM paychecks WHERE payroll_run_id = ${runs[0]!.id}`);
    expect((JSON.parse(pyc!.earnings_json) as { type: string; amountCents: number }[]).map((e) => [e.type, e.amountCents])).toEqual([["salary", 105_556], ["salary", 227_778], ["bonus", 150_000]]);
    expect(pyc!.gross_cents).toBe(483_334);
    const [batch] = await weft.db.all<{ total_cents: number; status: string }>(sql`SELECT total_cents, status FROM sim_bank_batches WHERE id = ${runs[0]!.bank_batch_id}`);
    expect(batch!.total_cents).toBe(pyc!.net_cents);

    // Payday 06:00 PT: the batch settles, the run is processed and the bonus counts as supplemental YTD wages.
    await weft.clock.set("2026-10-27T14:00:00.000Z", 0);
    await weft.scheduler.tick();
    await weft.scheduler.tick();
    const [after] = await weft.db.all<{ status: string }>(sql`SELECT status FROM payroll_runs WHERE id = ${runs[0]!.id}`);
    expect(after!.status).toBe("processed");
    const ytd = await weft.db.all<{ amount_cents: number }>(sql`SELECT amount_cents FROM ytd_ledger WHERE worker_id = ${WORKER} AND code = 'supplemental' AND source = ${`payroll:${runs[0]!.id}`}`);
    expect(ytd.map((r) => r.amount_cents)).toEqual([150_000]);
  });

  it("a correction of a paid period pays only the raise difference", async () => {
    const [other] = await weft.db.all<{ worker_id: string; id: string; amount_cents: number; earnings_json: string }>(sql`SELECT p.worker_id, r.id, r.amount_cents, p.earnings_json FROM paychecks p JOIN payroll_runs pr ON pr.id = p.payroll_run_id JOIN pay_rates r ON r.worker_id = p.worker_id AND r.kind = 'salary' AND r.effective_to IS NULL WHERE pr.subtype = 'regular' AND pr.period_end = '2026-10-15' AND p.status = 'processed' AND p.worker_id != ${WORKER} ORDER BY p.worker_id LIMIT 1`);
    if (!other) return expect.unreachable("a salaried worker paid on Oct 15");
    const raised = other.amount_cents + 2_400_000;
    await weft.db.run(sql`UPDATE pay_rates SET effective_to = '2026-10-05' WHERE id = ${other.id}`);
    await weft.db.insert(payRates).values({ id: "prt_9002", workerId: other.worker_id, kind: "salary", amountCents: raised, currency: "USD", effectiveFrom: "2026-10-06", effectiveTo: null, createdActionSeq: null });
    const dana = weft.uiHeaders("usr_dana");
    const res = await req("POST", "/v1/payrolls/off-cycle", dana, { workerIds: [other.worker_id], periodStart: "2026-10-01", periodEnd: "2026-10-15", payday: "2026-10-30", reason: "correction" });
    expect(res.status).toBe(200);
    const p = (await (await req("GET", `/v1/proposals/${((await res.json()) as { proposalId: string }).proposalId}`, dana)).json()) as Proposal;
    const salary = p.diff.filter((d) => d.label.includes(": Salary ("));
    // Due: 5 of 15 days at the old rate plus 10 of 15 at the raised one, one rounding per line; less what Oct 15 paid.
    const due = Math.round((other.amount_cents * 5) / 360) + Math.round((raised * 10) / 360);
    const paid = (JSON.parse(other.earnings_json) as { type: string; amountCents: number }[]).filter((e) => e.type === "salary").reduce((n, e) => n + e.amountCents, 0);
    expect(salary).toHaveLength(1);
    expect(salary[0]!.label).toContain(`correction, ${formatCents(due)} due less ${formatCents(paid)} paid`);
    expect(salary[0]!.after).toBe(formatCents(due - paid));
  });

  it("a cli API key's off-cycle call is a proposal, never a direct payment", async () => {
    const created = await req("POST", "/v1/api-keys", weft.uiHeaders("usr_dana"), { label: "laptop cli", scope: "cli" });
    expect(created.status).toBe(201);
    const key = ((await created.json()) as { plaintext: string }).plaintext;
    const before = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM payroll_runs WHERE subtype = 'off_cycle'`);
    const res = await req("POST", "/v1/tools/payroll.propose_off_cycle", { "x-api-key": key }, { worker_ids: [WORKER], period_start: "2026-11-01", period_end: "2026-11-15", payday: "2026-11-13", reason: "bonus", bonuses: [{ worker_id: WORKER, cents: 90_000 }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "pending_approval" });
    const after = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM payroll_runs WHERE subtype = 'off_cycle'`);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("an off-cycle over the $10,000.00 per-call ceiling is refused, not proposed", async () => {
    const res = await req("POST", "/v1/tools/payroll.propose_off_cycle", { "x-api-key": mcpKey }, { worker_ids: [WORKER], period_start: "2026-10-16", period_end: "2026-10-31", payday: "2026-10-30", reason: "bonus", bonuses: [{ worker_id: WORKER, cents: 2_000_000 }] });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("OVER_CEILING");
  });

  it("the person route proposes too; hourly pay comes from the period's time entry", async () => {
    const dana = weft.uiHeaders("usr_dana");
    const res = await req("POST", "/v1/payrolls/off-cycle", dana, { workerIds: [WORKER], periodStart: "2026-10-16", periodEnd: "2026-10-31", payday: "2026-10-30", reason: "bonus", bonusCents: { [WORKER]: 100_000 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "pending_approval" });
    const [hourly] = await weft.db.all<{ worker_id: string; period_start: string; period_end: string }>(sql`SELECT t.worker_id, t.period_start, t.period_end FROM time_entries t JOIN pay_rates r ON r.worker_id = t.worker_id AND r.kind = 'hourly' AND r.effective_to IS NULL WHERE t.period_start = '2026-10-01' ORDER BY t.worker_id LIMIT 1`);
    // Paid in the Oct 15 run: missed_payroll is refused and a correction with nothing more due is empty.
    const paid = await req("POST", "/v1/payrolls/off-cycle", dana, { workerIds: [hourly!.worker_id], periodStart: hourly!.period_start, periodEnd: hourly!.period_end, payday: "2026-10-30", reason: "missed_payroll" });
    expect(paid.status).toBe(422);
    expect(((await paid.json()) as { code: string }).code).toBe("DOMAIN_ALREADY_PAID");
    const same = await req("POST", "/v1/payrolls/off-cycle", dana, { workerIds: [hourly!.worker_id], periodStart: hourly!.period_start, periodEnd: hourly!.period_end, payday: "2026-10-30", reason: "correction" });
    expect(same.status).toBe(422);
    expect(((await same.json()) as { code: string }).code).toBe("DOMAIN_EMPTY_RUN");
    await missPeriod(hourly!.worker_id);
    const ok = await req("POST", "/v1/payrolls/off-cycle", dana, { workerIds: [hourly!.worker_id], periodStart: hourly!.period_start, periodEnd: hourly!.period_end, payday: "2026-10-30", reason: "missed_payroll" });
    expect(ok.status).toBe(200);
    const p = (await (await req("GET", `/v1/proposals/${((await ok.json()) as { proposalId: string }).proposalId}`, dana)).json()) as Proposal;
    expect(p.diff.some((d) => d.label.includes(": Regular hours (15 of 15 days"))).toBe(true);
    const none = await req("POST", "/v1/payrolls/off-cycle", dana, { workerIds: [hourly!.worker_id], periodStart: "2026-11-01", periodEnd: "2026-11-15", payday: "2026-11-20", reason: "missed_payroll" });
    expect(none.status).toBe(422);
    expect(((await none.json()) as { code: string }).code).toBe("DOMAIN_NO_TIME_ENTRY");
  });
});
