// /v1/time-off routes (wave 3, w3-timeoff) over the seeded world: requests with checks and routing, balances from
// the ledger, decisions by the manager (direct reports only), agents only propose, accruals idempotent per run.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { ToolOutcome } from "@weft/contracts";
import { createTestWeft, type TestWeft } from "../src/testing";
import { timeOffYearEnd } from "../src/time-off/year-end";

type Req = { id: string; workerId: string; status: string; requestedMinutes: number; approverPrincipalId: string | null; checks: { rule: string; severity: string; message: string; evidence: { label: string; ref: string }[] }[]; days: { date: string; minutes: number; holiday: boolean }[]; routing: { principalId: string | null; why: string }[] };

describe("time-off routes", () => {
  let weft: TestWeft;
  let mcpKey = "";
  beforeAll(async () => {
    weft = await createTestWeft();
    mcpKey = readFileSync(join(weft.dataDir, "demo-mcp-key.txt"), "utf8").trim();
  });
  afterAll(async () => { await weft.close(); });

  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const headers = who.startsWith("key:") ? { "x-api-key": who.slice(4) } : weft.uiHeaders(who);
    const res = await weft.app.request(path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as unknown };
  };
  const request = async (id: string) => (await call("usr_dana", "GET", `/v1/time-off/requests/${id}`)).json as Req;

  it("lists policies, holidays and the seeded requests with their checks and routing", async () => {
    const pols = (await call("usr_dana", "GET", "/v1/time-off/policies")).json as { id: string; sources: unknown[] }[];
    expect(pols.map((p) => p.id)).toEqual(["top_prenatal_ny", "top_sick_ca", "top_sick_co", "top_sick_ny", "top_sick_tx", "top_unpaid_nyc", "top_vac_us"]);
    expect(pols.every((p) => p.sources.length > 0)).toBe(true);
    const hol = (await call("usr_dana", "GET", "/v1/time-off/holidays?year=2026")).json as { date: string }[];
    expect(hol.map((h) => h.date)).toContain("2026-11-27");

    const page = (await call("usr_dana", "GET", "/v1/time-off/requests?status=pending")).json as { data: Req[] };
    expect(page.data.map((r) => r.id)).toEqual(["tor_0003", "tor_0004", "tor_0005"]);

    // R-B: Ruth, Nov 23 to 27: 3 of 9 out in Hardware on Nov 23 to 25 (33.3% over 30%), holidays Nov 26 and 27, routed to Imani.
    const ruth = await request("tor_0003");
    expect(ruth).toMatchObject({ workerId: "wrk_0010", status: "pending", requestedMinutes: 1_440, approverPrincipalId: "usr_imani" });
    expect(ruth.days.filter((d) => d.holiday).map((d) => d.date)).toEqual(["2026-11-26", "2026-11-27"]);
    const cov = ruth.checks.find((c) => c.rule === "COVERAGE_CONFLICT")!;
    expect(cov).toMatchObject({ severity: "review", message: "3 of 9 out (33.3%) on 2026-11-23, 2026-11-24, 2026-11-25" });
    expect(cov.evidence.filter((e) => e.label === "also out").map((e) => e.ref)).toEqual(["tor_0001", "tor_0002"]);
    expect(ruth.checks.find((c) => c.rule === "INCLUDES_HOLIDAY")?.severity).toBe("info");

    // R-D: Ben started Oct 1; CA sick has a 90-day wait.
    const ben = await request("tor_0005");
    expect(ben.checks.map((c) => [c.rule, c.severity])).toEqual([["WAITING_PERIOD", "block"]]);
    // R-C: a NY sick half day, clean, routed past a manager with no login to Vic.
    const kenji = await request("tor_0004");
    expect(kenji).toMatchObject({ requestedMinutes: 240, approverPrincipalId: "usr_dana", checks: [] });
    expect(kenji.routing.map((s) => s.principalId)).toEqual([null, "usr_dana"]);
  });

  it("derives balances from the ledger; Imani's imported vacation is 5,063 minutes", async () => {
    const b = (await call("usr_dana", "GET", "/v1/time-off/balances?workerId=wrk_0004")).json as { policyId: string; availableMinutes: number; accruedUnlockedMinutes: number }[];
    expect(b.find((x) => x.policyId === "top_vac_us")).toMatchObject({ accruedUnlockedMinutes: 5_063, availableMinutes: 5_063 });
    const ben = (await call("usr_dana", "GET", "/v1/time-off/balances?workerId=wrk_0021")).json as { policyId: string; accruedLockedMinutes: number; accruedUnlockedMinutes: number }[];
    expect(ben.find((x) => x.policyId === "top_sick_ca")).toMatchObject({ accruedUnlockedMinutes: 0 });
    expect(ben.find((x) => x.policyId === "top_sick_ca")!.accruedLockedMinutes).toBeGreaterThan(0);
    const all = (await call("usr_dana", "GET", "/v1/time-off/balances")).json as unknown[];
    expect(all.length).toBeGreaterThan(48);
    const cal = (await call("usr_dana", "GET", "/v1/time-off/calendar?departmentId=dpt_hardware&from=2026-11-23&to=2026-11-27")).json as { days: { date: string; outPct: number; overLimit: boolean; holiday: string | null }[] };
    expect(cal.days.map((d) => [d.date, d.outPct, d.overLimit])).toEqual([["2026-11-23", 33.3, true], ["2026-11-24", 33.3, true], ["2026-11-25", 33.3, true], ["2026-11-26", 0, false], ["2026-11-27", 0, false]]);
  });

  it("an agent's decide is a proposal; a forged approval by the agent principal is refused", async () => {
    const out = (await call(`key:${mcpKey}`, "POST", "/v1/tools/time_off.decide", { request_id: "tor_0004", decision: "approve", note: "Clean half day" })).json as ToolOutcome & { proposalId: string };
    expect(out).toMatchObject({ ok: true, status: "pending_approval" });
    expect((await request("tor_0004")).status).toBe("pending");
    const forged = await call("agt_weft", "POST", `/v1/proposals/${out.proposalId}/approve`, {});
    expect(JSON.stringify(forged.json)).toMatch(/AGENT_PRINCIPAL|WRONG_ROLE|Unauthorized|Forbidden/);
    expect((await request("tor_0004")).status).toBe("pending");
  });

  it("the manager decides only for direct reports; block checks refuse approval", async () => {
    const notMine = await call("usr_imani", "POST", "/v1/time-off/requests/tor_0004/decide", { decision: "approve", note: "" });
    expect(notMine.status).toBe(422);
    expect((notMine.json as { code: string }).code).toBe("DOMAIN_NOT_DIRECT_REPORT");
    const theo = await call("usr_theo", "POST", "/v1/time-off/requests/tor_0003/decide", { decision: "approve", note: "" });
    expect((theo.json as { code: string }).code).toBe("DOMAIN_NOT_APPROVER");
    const blocked = await call("usr_imani", "POST", "/v1/time-off/requests/tor_0005/decide", { decision: "approve", note: "" });
    expect((blocked.json as { code: string }).code).toBe("DOMAIN_REQUEST_BLOCKED");

    const before = ((await call("usr_dana", "GET", "/v1/time-off/balances?workerId=wrk_0010")).json as { policyId: string; availableMinutes: number; holdsMinutes: number }[]).find((b) => b.policyId === "top_vac_us")!;
    const ok = await call("usr_imani", "POST", "/v1/time-off/requests/tor_0003/decide", { decision: "approve", note: "Covered with the holiday week" });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, status: "done" });
    expect((await request("tor_0003")).status).toBe("approved");
    const after = ((await call("usr_dana", "GET", "/v1/time-off/balances?workerId=wrk_0010")).json as { policyId: string; availableMinutes: number; holdsMinutes: number }[]).find((b) => b.policyId === "top_vac_us")!;
    // The hold became future use rows: still held until taken, so available does not move twice.
    expect(after.availableMinutes).toBe(before.availableMinutes);
    const ledger = (await call("usr_dana", "GET", "/v1/time-off/ledger?workerId=wrk_0010&policyId=top_vac_us")).json as { kind: string; minutes: number; effective_date: string; source_ref: string | null }[];
    expect(ledger.filter((l) => l.kind === "use" && l.source_ref === "tor_0003").map((l) => [l.effective_date, l.minutes])).toEqual([["2026-11-23", -480], ["2026-11-24", -480], ["2026-11-25", -480]]);
    // A second decide on R-B is refused: by the same person it is no longer pending; anyone else meets the lease first.
    const again = await call("usr_imani", "POST", "/v1/time-off/requests/tor_0003/decide", { decision: "deny", note: "" });
    expect(["DOMAIN_NOT_PENDING", "LEASE_HELD"]).toContain((again.json as { code: string }).code);
  });

  it("submits a request from the dates, holds the balance and routes it; cancel releases the hold", async () => {
    const res = await call("usr_dana", "POST", "/v1/time-off/requests?workerId=wrk_0011", { policyId: "top_vac_us", startDate: "2026-12-21", endDate: "2026-12-25", reason: "Year-end break" });
    expect(res.status).toBe(200);
    const out = res.json as { data: { request_id: string; requested_minutes: number; approver: string } };
    expect(out.data).toMatchObject({ requested_minutes: 1_920, approver: "usr_imani" });   // Dec 25 is a holiday
    const cancel = await call("usr_dana", "POST", `/v1/time-off/requests/${out.data.request_id}/cancel`);
    expect(cancel.status).toBe(200);
    const ledger = (await call("usr_dana", "GET", "/v1/time-off/ledger?workerId=wrk_0011&policyId=top_vac_us")).json as { minutes: number; source_ref: string | null }[];
    expect(ledger.filter((l) => l.source_ref === out.data.request_id).reduce((s, l) => s + l.minutes, 0)).toBe(0);
    const typed = await call("usr_dana", "POST", "/v1/time-off/requests?workerId=wrk_0011", { policyId: "top_vac_us", startDate: "2026-12-21", endDate: "2026-12-21", requestedMinutes: 9_999 });
    expect(typed.status).toBe(400);   // the employee never types an amount
  });

  it("separation of duties: an HR manager files their own request but cannot decide it", async () => {
    const [sam] = await weft.db.all<{ worker_id: string }>(sql`SELECT worker_id FROM principals WHERE id = 'usr_sam'`);
    const res = await call("usr_sam", "POST", `/v1/time-off/requests?workerId=${sam!.worker_id}`, { policyId: "top_vac_us", startDate: "2026-12-14", endDate: "2026-12-14" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const id = (res.json as { data: { request_id: string } }).data.request_id;
    const self = await call("usr_sam", "POST", `/v1/time-off/requests/${id}/decide`, { decision: "approve", note: "" });
    expect([self.status, (self.json as { code: string }).code]).toEqual([422, "DOMAIN_SELF_APPROVAL"]);
    expect((await call("usr_sam", "POST", `/v1/time-off/requests/${id}/cancel`)).status).toBe(200);
  });

  it("flags time off on the open draft: PTO_LINE for the approved TX day, pending requests as info, review counts unchanged", async () => {
    type Pc = { workerId: string; reviewGroup: string; flags: { rule: string; severity: string; message: string; evidence: Record<string, unknown> }[] };
    const checks = async () => (await weft.db.all<{ worker_id: string; review_group: string; flags_json: string }>(sql`SELECT worker_id, review_group, flags_json FROM paychecks WHERE payroll_run_id = 'pay_2026_10_30' ORDER BY worker_id`))
      .map((r) => ({ workerId: r.worker_id, reviewGroup: r.review_group, flags: JSON.parse(r.flags_json) }) as Pc);
    const pcs = await checks();
    const lucy = pcs.find((p) => p.flags.some((f) => f.rule === "PTO_LINE"))!;
    expect(lucy.flags.find((f) => f.rule === "PTO_LINE")).toMatchObject({ severity: "info", message: "Paid leave on this paycheck: 8.00 h pto (tor_0006)", evidence: { request_ids: ["tor_0006"], gross_cents: 475_000 } });
    const pending = pcs.flatMap((p) => p.flags.filter((f) => f.rule === "PENDING_TIME_OFF_IN_PERIOD").map((f) => [p.workerId, f.severity, f.evidence.request_id]));
    // Kenji's NY sick half day (salaried: hours move, gross does not) and Ben's blocked CA sick day are info.
    expect(pending).toEqual([["wrk_0021", "info", "tor_0005"], ["wrk_0034", "info", "tor_0004"]]);
    expect(pcs.find((p) => p.workerId === "wrk_0021")!.flags.find((f) => f.rule === "PENDING_TIME_OFF_IN_PERIOD")!.message).toContain("blocked by WAITING_PERIOD");
    expect(pcs.filter((p) => p.reviewGroup === "needs_review")).toHaveLength(4);   // GP2 and S2 still see four

    // A new request inside the period refreshes the draft at once; cancelling it clears the flag again.
    const res = await call("usr_dana", "POST", "/v1/time-off/requests?workerId=wrk_0011", { policyId: "top_vac_us", startDate: "2026-10-27", endDate: "2026-10-27", reason: "Errand" });
    const id = (res.json as { data: { request_id: string } }).data.request_id;
    expect((await checks()).find((p) => p.workerId === "wrk_0011")!.flags.map((f) => f.rule)).toContain("PENDING_TIME_OFF_IN_PERIOD");
    await call("usr_dana", "POST", `/v1/time-off/requests/${id}/cancel`);
    expect((await checks()).find((p) => p.workerId === "wrk_0011")!.flags.map((f) => f.rule)).not.toContain("PENDING_TIME_OFF_IN_PERIOD");
  });

  it("a request imported from Workday is read-only: decide, cancel, reopen and the checks refuse it", async () => {
    await weft.db.run(sql`INSERT INTO time_off_requests (id, company_id, worker_id, policy_id, status, start_at, end_at, range_type, time_zone, requested_minutes, days_json, reason, approver_principal_id, routing_json, checks_json, source, ext_ref, created_at)
      SELECT 'tor_0900', company_id, worker_id, policy_id, 'approved', '2026-12-14', '2026-12-14', 'date', time_zone, 480, '[{"date":"2026-12-14","minutes":480,"holiday":false}]', '', NULL, '[]', '[]', 'workday', 'a1b2c3d4e5f60718293a4b5c6d7e8f90', created_at FROM time_off_requests WHERE id = 'tor_0004'`);
    const row = (await call("usr_dana", "GET", "/v1/time-off/requests/tor_0900")).json as Req & { source: string; extRef: string };
    expect(row).toMatchObject({ source: "workday", status: "approved" });
    for (const [path, body] of [["/v1/time-off/requests/tor_0900/decide", { decision: "deny", note: "" }], ["/v1/time-off/requests/tor_0900/cancel", undefined], ["/v1/tools/time_off.reopen", { request_id: "tor_0900" }], ["/v1/tools/time_off.check_request", { request_id: "tor_0900" }]] as const) {
      const out = await call("usr_dana", "POST", path, body);
      expect((out.json as { code: string }).code, path).toBe("DOMAIN_MANAGED_EXTERNALLY");
    }
    expect((await request("tor_0900")).status).toBe("approved");
    await weft.db.run(sql`DELETE FROM time_off_requests WHERE id = 'tor_0900'`);
  });

  it("a hire after the seed gets the policies of their state on the first request, with the on-hire front load", async () => {
    // A TX employee starting Oct 19, written the way an accepted offer writes a worker: no time-off assignments yet.
    const cols = (await weft.db.all<{ name: string }>(sql`PRAGMA table_info(workers)`)).map((c) => c.name);
    const pick = cols.map((c) => (c === "id" ? "'wrk_0900'" : c === "first_name" ? "'Rowan'" : c === "last_name" ? "'Pell'" : c === "preferred_name" ? "NULL" : c === "work_email" ? "'rowan.pell@larkspur.example'" : c === "start_date" ? "'2026-10-19'" : c === "end_date" ? "NULL" : c)).join(", ");
    await weft.db.run(sql.raw(`INSERT INTO workers (${cols.join(", ")}) SELECT ${pick} FROM workers WHERE id = 'wrk_0038'`));
    expect((await weft.db.all(sql`SELECT id FROM time_off_assignments WHERE worker_id = 'wrk_0900'`))).toHaveLength(0);
    const res = await call("usr_dana", "POST", "/v1/time-off/requests?workerId=wrk_0900", { policyId: "top_sick_tx", startDate: "2026-11-04", endDate: "2026-11-04", reason: "Clinic visit" });
    expect(res.status).toBe(200);
    const asn = await weft.db.all<{ policy_id: string; effective_from: string }>(sql`SELECT policy_id, effective_from FROM time_off_assignments WHERE worker_id = 'wrk_0900' ORDER BY policy_id`);
    expect(asn).toEqual([{ policy_id: "top_sick_tx", effective_from: "2026-10-19" }, { policy_id: "top_vac_us", effective_from: "2026-10-19" }]);
    const b = (await call("usr_dana", "GET", "/v1/time-off/balances?workerId=wrk_0900")).json as { policyId: string; accruedUnlockedMinutes: number; holdsMinutes: number; availableMinutes: number }[];
    expect(b.find((x) => x.policyId === "top_sick_tx")).toMatchObject({ accruedUnlockedMinutes: 2_400, holdsMinutes: 480, availableMinutes: 1_920 });
    expect(b.find((x) => x.policyId === "top_vac_us")).toMatchObject({ accruedUnlockedMinutes: 0 });
    // A second request does not assign again.
    await call("usr_dana", "POST", "/v1/time-off/requests?workerId=wrk_0900", { policyId: "top_sick_tx", startDate: "2026-11-05", endDate: "2026-11-05" });
    expect((await weft.db.all(sql`SELECT id FROM time_off_assignments WHERE worker_id = 'wrk_0900'`))).toHaveLength(2);
    await weft.db.run(sql`DELETE FROM time_off_ledger WHERE worker_id = 'wrk_0900'`);
    await weft.db.run(sql`DELETE FROM time_off_requests WHERE worker_id = 'wrk_0900'`);
    await weft.db.run(sql`DELETE FROM time_off_assignments WHERE worker_id = 'wrk_0900'`);
    await weft.db.run(sql`DELETE FROM workers WHERE id = 'wrk_0900'`);
  });

  it("posts accruals once per processed regular run and assignment; re-running changes nothing", async () => {
    await weft.db.run(sql`UPDATE payroll_runs SET status = 'processed' WHERE id = 'pay_2026_10_30'`);
    const count = async () => (await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM time_off_ledger`))[0]!.n;
    const n0 = await count();
    const src = { eventId: null, attended: false, requestedBy: null };
    const first = await weft.executor.system.exec("svc_events", "time_off.post_accruals", { run_id: "pay_2026_10_30" }, src);
    expect(first).toMatchObject({ ok: true });
    const n1 = await count();
    expect(n1).toBeGreaterThan(n0);
    const second = await weft.executor.system.exec("svc_events", "time_off.post_accruals", { run_id: "pay_2026_10_30" }, src);
    expect(second).toMatchObject({ ok: true });
    expect(await count()).toBe(n1);
    // Imani (42 months) gets the 360-minute tier; Mira (hired Oct 19, no import) accrues from her first run.
    const rows = await weft.db.all<{ worker_id: string; minutes: number; run_key: string }>(sql`SELECT worker_id, minutes, run_key FROM time_off_ledger WHERE kind = 'accrual' AND policy_id = 'top_vac_us' AND worker_id IN ('wrk_0004', 'wrk_0022') ORDER BY worker_id`);
    expect(rows.map((r) => [r.worker_id, r.minutes])).toEqual([["wrk_0004", 360], ["wrk_0022", 300]]);
    expect(rows.every((r) => r.run_key.startsWith("pay_2026_10_30:tasn_"))).toBe(true);
  });

  it("closes the year on the first tick of the next one: carryover caps, forfeits and front loads, once (T16)", async () => {
    const forfeits = async () => weft.db.all<{ policy_id: string; n: number; m: number }>(sql`SELECT policy_id, COUNT(*) AS n, SUM(minutes) AS m FROM time_off_ledger WHERE kind = 'carryover_forfeit' GROUP BY policy_id ORDER BY policy_id`);
    expect(await forfeits()).toEqual([]);
    const tick = () => timeOffYearEnd({ db: weft.db, clock: weft.clock, executor: weft.executor, now: "2027-01-01T16:00:00.000Z" });
    await tick();
    const after = await forfeits();
    // Vacation and CA sick carry everything; the TX and NYC banks and the prenatal bank never carry; NY sick carries 40 h.
    expect(after.map((r) => r.policy_id)).toEqual(["top_prenatal_ny", "top_sick_ny", "top_sick_tx", "top_unpaid_nyc"]);
    // Every NY sick balance over the cap ends the year at exactly the 2,400-minute carryover cap.
    const ny = await weft.db.all<{ worker_id: string; bal: number }>(sql`SELECT worker_id, SUM(minutes) AS bal FROM time_off_ledger WHERE policy_id = 'top_sick_ny' AND kind NOT IN ('hold', 'hold_release') AND effective_date <= '2026-12-31' AND worker_id IN (SELECT worker_id FROM time_off_ledger WHERE kind = 'carryover_forfeit' AND policy_id = 'top_sick_ny') GROUP BY worker_id`);
    expect(ny.length).toBeGreaterThan(0);
    expect(ny.every((r) => r.bal === 2_400)).toBe(true);
    const fronts = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM time_off_ledger WHERE kind = 'front_load' AND effective_date = '2027-01-01'`);
    expect(fronts[0]!.n).toBeGreaterThan(0);
    const n = (await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM time_off_ledger`))[0]!.n;
    await tick();
    expect((await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM time_off_ledger`))[0]!.n).toBe(n);
  });

  it("adjusts a balance (a proposal for agents, never below zero) and reopens a decided request", async () => {
    const viaMcp = (await call(`key:${mcpKey}`, "POST", "/v1/tools/time_off.adjust_balance", { worker_id: "wrk_0011", policy_id: "top_vac_us", minutes: 480, reason: "Import missed a day" })).json as ToolOutcome;
    expect(viaMcp).toMatchObject({ ok: true, status: "pending_approval" });
    const bal = async () => ((await call("usr_dana", "GET", "/v1/time-off/balances?workerId=wrk_0011")).json as { policyId: string; availableMinutes: number }[]).find((b) => b.policyId === "top_vac_us")!.availableMinutes;
    const before = await bal();
    const direct = await call("usr_dana", "POST", "/v1/tools/time_off.adjust_balance", { worker_id: "wrk_0011", policy_id: "top_vac_us", minutes: 480, reason: "Import missed a day" });
    expect(direct.status).toBe(200);
    expect(await bal()).toBe(before + 480);
    const over = await call("usr_dana", "POST", "/v1/tools/time_off.adjust_balance", { worker_id: "wrk_0011", policy_id: "top_vac_us", minutes: -(before + 481), reason: "Too much" });
    expect((over.json as { code: string }).code).toBe("DOMAIN_NEGATIVE_BALANCE");

    // Ruth's approved request (earlier test) has not started: reopening returns the use rows and puts the hold back.
    const reopened = await call("usr_dana", "POST", "/v1/tools/time_off.reopen", { request_id: "tor_0003" });
    expect(reopened.status).toBe(200);
    expect((await request("tor_0003")).status).toBe("pending");
    const ledger = (await call("usr_dana", "GET", "/v1/time-off/ledger?workerId=wrk_0010&policyId=top_vac_us")).json as { kind: string; minutes: number; source_ref: string | null }[];
    const mine = ledger.filter((l) => l.source_ref === "tor_0003");
    expect(mine.filter((l) => l.kind === "use").reduce((s, l) => s + l.minutes, 0)).toBe(0);
    expect(mine.filter((l) => l.kind === "hold" || l.kind === "hold_release").reduce((s, l) => s + l.minutes, 0)).toBe(-1_440);
  });
});
