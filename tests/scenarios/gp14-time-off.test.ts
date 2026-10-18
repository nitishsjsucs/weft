// Scenario GP14 (docs/wave3.md 5). Owner: w3-timeoff. Time off with a coverage conflict, end to end over HTTP on the
// scripted provider: Ruth's pending vacation shows COVERAGE_CONFLICT for Nov 23 to 25 (3 of 9 out) and
// INCLUDES_HOLIDAY for Nov 26 and 27, routed to Imani; rt_time_off_requests proposes a decision with the balance now
// and without the request; viewing as Imani she approves, the hold becomes use rows and the calendar marks the days. The TX request
// shows a pto line in the open draft with gross unchanged, and an accrual posts when that run processes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Proposal, ToolOutcome } from "@weft/contracts";
import { emitEvent } from "@weft/core";
import { routines, withWriteLock } from "@weft/db";
import { createTestWeft, type TestWeft } from "./helpers";

const RUTH_REQUEST = "tor_0003";
const LUCY = "wrk_0038";   // Lucy Harrow (demo), TX salaried, one approved vacation day on Oct 23

describe("GP14 time off with a coverage conflict", () => {
  let weft: TestWeft;
  beforeAll(async () => { weft = await createTestWeft(); });
  afterAll(async () => { await weft.close(); });

  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as unknown };
  };
  type Req = { status: string; approverPrincipalId: string; checks: { rule: string; severity: string; message: string }[] };

  it("Ruth's request carries its checks, the routine proposes a grounded decision and Imani approves it", async () => {
    const ruth = (await call("usr_imani", "GET", `/v1/time-off/requests/${RUTH_REQUEST}`)).json as Req;
    expect(ruth).toMatchObject({ status: "pending", approverPrincipalId: "usr_imani" });
    expect(ruth.checks.map((c) => [c.rule, c.severity])).toEqual([["COVERAGE_CONFLICT", "review"], ["INCLUDES_HOLIDAY", "info"]]);
    expect(ruth.checks[0]!.message).toBe("3 of 9 out (33.3%) on 2026-11-23, 2026-11-24, 2026-11-25");

    // The routine ships disabled; GP14 turns it on and replays the request's created event.
    await weft.scheduler.tick();   // the engine writes the prebuilt routine rows on its first tick
    await weft.db.update(routines).set({ enabled: true }).where(eq(routines.id, "rt_time_off_requests"));
    await withWriteLock(() => weft.db.transaction(async (tx) => {
      await emitEvent(tx, weft.clock, { body: { type: "time_off.request.created", payload: { request_id: RUTH_REQUEST, worker_id: "wrk_0010" } } as never, subjectRef: RUTH_REQUEST, attended: false, requestedBy: null });
    }));
    const settled = (id: string) => (weft.agent as unknown as { settled(id: string): Promise<{ status: string; tainted: boolean }> }).settled(id);
    let agentRunId: string | null = null;
    for (let i = 0; i < 20 && !agentRunId; i++) {
      await weft.scheduler.tick();
      const rows = await weft.db.all<{ agent_run_id: string | null; status: string }>(sql`SELECT agent_run_id, status FROM routine_runs WHERE routine_id = 'rt_time_off_requests' ORDER BY rowid`);
      agentRunId = rows.at(-1)?.agent_run_id ?? null;
      if (rows.at(-1)?.status === "skipped") throw new Error(`GP14: the routine skipped: ${JSON.stringify(await weft.db.all(sql`SELECT * FROM routine_runs WHERE routine_id = 'rt_time_off_requests'`))}`);
    }
    if (!agentRunId) throw new Error("GP14: time_off.request.created did not fire rt_time_off_requests");
    expect(await settled(agentRunId)).toMatchObject({ status: "waiting", tainted: false });
    const props = await weft.db.all<{ id: string; command: string; status: string; args_json: string }>(sql`SELECT id, command, status, args_json FROM proposals WHERE command = 'time_off.decide'`);
    expect(props).toHaveLength(1);
    const p = (await call("usr_dana", "GET", `/v1/proposals/${props[0]!.id}`)).json as Proposal;
    expect(p).toMatchObject({ status: "pending", command: "time_off.decide", risk: "R2" });
    expect(p.headline).toMatch(/^Approve Ruth Okoro \(demo\)'s vacation 2026-11-23 to 2026-11-27 \(24\.00 h\)/);
    const args = JSON.parse(props[0]!.args_json) as { decision: string; note: string };
    expect(args.decision).toBe("approve");
    expect(args.note).toMatch(/Larkspur Vacation available 89\.00 h now with every open request counted, 113\.00 h without this request/);
    expect(args.note).toContain("COVERAGE_CONFLICT");
    expect(args.note).toContain("2026-11-26, 2026-11-27 are charged 0 h");
    const posts = await weft.sims.chat.list("#people-ops");
    // The notice (no digits, grounded) and the proposal's approval card.
    expect(posts.map((m) => m.text).filter((t) => t.includes("Ruth"))).toEqual([
      "A time-off request from Ruth Okoro (demo) is ready for a decision in Time Off. Weft is proposing to approve it; please look at the coverage conflict first.",
      "Approval needed: Approve Ruth Okoro (demo)'s vacation 2026-11-23 to 2026-11-27 (24.00 h)",
    ]);

    // Viewing as Imani, she decides on the Requests screen (her own call runs; she manages Ruth).
    const before = ((await call("usr_imani", "GET", "/v1/time-off/balances?workerId=wrk_0010&asOf=2026-11-30")).json as { policyId: string; usedMinutes: number; availableMinutes: number }[]).find((b) => b.policyId === "top_vac_us")!;
    const ok = await call("usr_imani", "POST", `/v1/time-off/requests/${RUTH_REQUEST}/decide`, { decision: "approve", note: "Covered with the holiday week" });
    expect(ok.status).toBe(200);
    expect(ok.json as ToolOutcome).toMatchObject({ ok: true, status: "done" });
    const after = ((await call("usr_imani", "GET", "/v1/time-off/balances?workerId=wrk_0010&asOf=2026-11-30")).json as { policyId: string; usedMinutes: number; availableMinutes: number }[]).find((b) => b.policyId === "top_vac_us")!;
    expect(after.usedMinutes - before.usedMinutes).toBe(1_440);   // the hold became use rows on Nov 23 to 25
    const cal = (await call("usr_imani", "GET", "/v1/time-off/calendar?departmentId=dpt_hardware&from=2026-11-23&to=2026-11-25")).json as { days: { out: { requestId: string; status: string }[] }[] };
    expect(cal.days.every((d) => d.out.some((o) => o.requestId === RUTH_REQUEST && o.status === "approved"))).toBe(true);
  });

  it("the TX request is a pto line on the open draft with gross unchanged, and processing the run posts accruals", async () => {
    const [pc] = await weft.db.all<{ earnings_json: string; gross_cents: number }>(sql`SELECT earnings_json, gross_cents FROM paychecks WHERE payroll_run_id = 'pay_2026_10_30' AND worker_id = ${LUCY}`);
    const lines = JSON.parse(pc!.earnings_json) as { type: string; amountCents: number; hoursX100: number | null }[];
    // $114,000 / 24 = 475,000; 8 h at 11,400,000 / 2,080 = 43,846.15 -> 43,846; salary 431,154.
    expect(lines).toEqual([{ type: "salary", amountCents: 431_154, hoursX100: null }, { type: "pto", amountCents: 43_846, hoursX100: 800 }]);
    expect(pc!.gross_cents).toBe(475_000);

    const submit = await call("usr_dana", "POST", "/v1/payrolls/pay_2026_10_30/submit", { excludeBlocked: true });
    expect(submit.status).toBe(200);
    await weft.clock.advance("2026-10-30T13:00:00.000Z");
    await weft.scheduler.tick();
    const run = await weft.db.all<{ status: string }>(sql`SELECT status FROM payroll_runs WHERE id = 'pay_2026_10_30'`);
    expect(run[0]!.status).toBe("processed");
    const acc = await weft.db.all<{ worker_id: string; minutes: number }>(sql`SELECT worker_id, minutes FROM time_off_ledger WHERE kind = 'accrual' AND source_ref = 'pay_2026_10_30' AND policy_id = 'top_vac_us' AND worker_id IN (${LUCY}, 'wrk_0004', 'wrk_0010') ORDER BY worker_id`);
    expect(acc.map((a) => [a.worker_id, a.minutes])).toEqual([["wrk_0004", 360], ["wrk_0010", 300], [LUCY, 300]]);
    // Re-running the handler for the same run changes nothing.
    const n = (await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM time_off_ledger`))[0]!.n;
    await weft.executor.system.exec("svc_events", "time_off.post_accruals", { run_id: "pay_2026_10_30" }, { eventId: null, attended: false, requestedBy: null });
    expect((await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM time_off_ledger`))[0]!.n).toBe(n);
  });
});
