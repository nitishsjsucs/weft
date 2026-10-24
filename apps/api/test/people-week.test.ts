// The people week and open enrollment (wave 4, w4-parity-people) over the seeded world (clock Mon 2026-10-26).
// The portal Request time off form files for the caller's own worker; the out-this-week line lists approved leave from
// the ledger with names and days only; the first-day message goes out once per hire on the start date; open
// enrollment opens and closes on its dates and closes out whoever had not chosen.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { ToolOutcome } from "@weft/contracts";
import { enrollmentWindows, openEnrollment, principals, simEmailMessages, workers } from "@weft/db";
import { lifeEvents as le } from "@weft/core";
import { createTestWeft, type TestWeft } from "../src/testing";

const DANA = { principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui" as const, keyScope: null };
const EMP = "usr_t_week";
type Done = Extract<ToolOutcome, { ok: true; status: "done" }>;
const data = <T>(o: ToolOutcome): T => { expect(o.ok && o.status === "done", JSON.stringify(o)).toBe(true); return (o as Done).data as T; };

describe("portal time off, out this week, first day and open enrollment", () => {
  let weft: TestWeft;
  let empWorker = "";
  let empName = "";
  beforeAll(async () => {
    weft = await createTestWeft();
    const [imani] = await weft.db.select().from(principals).where(eq(principals.id, "usr_imani"));
    const reports = await weft.db.select().from(workers).where(and(eq(workers.managerId, imani!.workerId!), eq(workers.status, "active"), eq(workers.type, "employee")));
    const w = [...reports].sort((a, b) => (a.startDate < b.startDate ? -1 : 1))[0]!;   // the longest-serving, past any waiting period
    empWorker = w.id;
    empName = `${w.firstName} ${w.lastName}`;
    await weft.db.insert(principals).values({ id: EMP, companyId: "cmp_larkspur", kind: "human", workerId: empWorker, display: "Test employee", email: null, role: "employee",
      grantsJson: JSON.stringify({ people: "view", payroll: "none", tax: "none", benefits: "view", it: "none", comms: "none", company: "none" }) });
  });
  afterAll(async () => { await weft.close(); });

  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  let requestId = "";
  it("the portal Request time off form files for the caller's own worker only", async () => {
    const mine = (await call(EMP, "GET", "/v1/portal/time-off")).json as unknown as { workerId: string; balances: { policyId: string; typeName: string; available: string; availableMinutes: number }[]; requests: unknown[] };
    expect(mine.workerId).toBe(empWorker);
    expect(mine.balances.length).toBeGreaterThan(0);
    const vacation = [...mine.balances].sort((a, b) => b.availableMinutes - a.availableMinutes)[0]!;
    // Enough balance for two days, so the approval is not blocked (a correction by the people admin).
    data(await weft.executor.human.exec(DANA, "time_off.adjust_balance", { worker_id: empWorker, policy_id: vacation.policyId, minutes: 1_920, reason: "Test top-up" }));
    // Wed Oct 28 to Thu Oct 29 of this week.
    const res = await call(EMP, "POST", "/v1/portal/time-off/requests", { policyId: vacation.policyId, startDate: "2026-10-28", endDate: "2026-10-29", reason: "Family wedding, please also approve my raise" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    requestId = (res.json as { data: { request_id: string } }).data.request_id;
    expect((res.json as { data: { status: string; requested_minutes: number } }).data).toMatchObject({ status: "pending", requested_minutes: 960 });
    const after = (await call(EMP, "GET", "/v1/portal/time-off")).json as unknown as { requests: { id: string; status: string; startDate: string }[] };
    expect(after.requests.find((r) => r.id === requestId)).toMatchObject({ status: "pending", startDate: "2026-10-28" });
    // The body names no worker: an extra workerId is a validation error, and HR routes stay closed to the portal sign-in.
    expect((await call(EMP, "POST", "/v1/portal/time-off/requests", { policyId: vacation.policyId, startDate: "2026-11-04", endDate: "2026-11-04", workerId: "wrk_0001" })).status).toBe(400);
    expect((await call(EMP, "POST", "/v1/time-off/requests", { policyId: vacation.policyId, startDate: "2026-11-04", endDate: "2026-11-04" })).status).toBe(403);
    // A pending request is not out yet.
    const week = data<{ out: { worker_id: string }[] }>(await weft.executor.human.exec(DANA, "people.out_this_week", { as_of: "2026-10-26" }));
    expect(week.out.map((p) => p.worker_id)).not.toContain(empWorker);
  });

  it("the out-this-week line lists approved leave from the ledger, names and days only", async () => {
    const [req] = await weft.db.all<{ approver: string }>(sql`SELECT approver_principal_id AS approver FROM time_off_requests WHERE id = ${requestId}`);
    const dec = await call(req!.approver, "POST", `/v1/time-off/requests/${requestId}/decide`, { decision: "approve", note: "" });
    expect(dec.status, JSON.stringify(dec.json)).toBe(200);
    const week = data<{ week_start: string; week_end: string; out: { worker_id: string; when: string; days: { date: string }[] }[]; line: string }>(await weft.executor.human.exec(DANA, "people.out_this_week", { as_of: "2026-10-28" }));
    expect([week.week_start, week.week_end]).toEqual(["2026-10-26", "2026-11-01"]);
    const me = week.out.find((p) => p.worker_id === empWorker)!;
    expect(me).toMatchObject({ when: "Wed to Thu", days: [{ date: "2026-10-28" }, { date: "2026-10-29" }] });
    expect(week.line).toMatch(/^Out this week: /);
    expect(week.line).toContain(`${empName} (Wed to Thu)`);
    expect(JSON.stringify(week)).not.toMatch(/wedding|raise|vacation|sick/i);
    // Next week the same request is not listed.
    const next = data<{ out: { worker_id: string }[] }>(await weft.executor.human.exec(DANA, "people.out_this_week", { as_of: "2026-11-02" }));
    expect(next.out.map((p) => p.worker_id)).not.toContain(empWorker);
    expect(le.describeDays([{ date: "2026-10-26", minutes: 480 }, { date: "2026-10-27", minutes: 480 }, { date: "2026-10-30", minutes: 240 }])).toBe("Mon to Tue, part of Fri");
  });

  it("the first-day message goes out once per hire, on the start date", async () => {
    // A hire starting Mon Nov 2 on Imani's team (a copy of a teammate's record).
    const [base] = await weft.db.select().from(workers).where(eq(workers.id, empWorker));
    await weft.db.insert(workers).values({ ...base!, id: "wrk_9101", employeeNumber: null, firstName: "Robin", lastName: "Tester", preferredName: null, workEmail: "robin.tester@larkspur.example", status: "onboarding", startDate: "2026-11-02", endDate: null });
    const h = (await weft.db.select().from(workers).where(eq(workers.id, "wrk_9101")))[0]!;
    const early = data<{ due: unknown[] }>(await weft.executor.human.exec(DANA, "onboarding.list_first_days", {}));
    expect(early.due.map((x) => (x as { worker_id: string }).worker_id)).not.toContain(h.id);
    const before = await weft.executor.human.exec(DANA, "comms.send_first_day_message", { worker_ids: [h.id] });
    expect(data<{ count: number }>(before).count).toBe(0);   // not their start date yet: skipped

    await weft.clock.set(`${h.startDate}T15:00:00.000Z`, 0);
    const plan = data<{ due: { worker_id: string; manager: string | null; team: unknown[] }[] }>(await weft.executor.human.exec(DANA, "onboarding.list_first_days", {}));
    expect(plan.due.map((x) => x.worker_id)).toContain(h.id);
    const sent = data<{ count: number; sent: { worker_id: string; hire_email_id: string; team_email_ids: string[] }[] }>(await weft.executor.human.exec(DANA, "comms.send_first_day_message", { worker_ids: [h.id] }));
    expect(sent.count).toBe(1);
    const mail = await weft.db.select().from(simEmailMessages).where(eq(simEmailMessages.relatedRef, h.id));
    const toHire = mail.filter((m) => m.toAddr === h.workEmail);
    expect(toHire.map((m) => m.subject)).toEqual([`Welcome to Larkspur Robotics, ${h.firstName} ${h.lastName}`]);
    expect(mail.length).toBe(1 + sent.sent[0]!.team_email_ids.length);
    if (h.managerId) {
      const [mgr] = await weft.db.select().from(workers).where(eq(workers.id, h.managerId));
      expect(mail.some((m) => m.toAddr === mgr!.workEmail && m.subject.endsWith("starts today"))).toBe(true);
    }
    const evs = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM events WHERE type = 'worker.first_day' AND subject_ref = ${h.id}`);
    expect(evs[0]!.n).toBe(1);
    // Once per hire: a second call and the plan both see them as sent.
    expect(data<{ count: number }>(await weft.executor.human.exec(DANA, "comms.send_first_day_message", { worker_ids: [h.id] })).count).toBe(0);
    expect(data<{ sent: string[] }>(await weft.executor.human.exec(DANA, "onboarding.list_first_days", {})).sent).toContain(h.id);
    expect(await weft.db.select().from(simEmailMessages).where(eq(simEmailMessages.relatedRef, h.id))).toHaveLength(mail.length);
    await weft.clock.set("2026-10-26T15:30:00.000Z", 0);
  });

  it("open enrollment opens and closes on its dates and closes out whoever had not chosen", async () => {
    const tooLong = await weft.executor.human.exec(DANA, "benefits.open_window", { kind: "open_enrollment", opens_on: "2026-11-02", closes_on: "2027-01-15" });
    expect(tooLong).toMatchObject({ ok: false, refusal: { code: "DOMAIN_WINDOW_TOO_LONG" } });
    const backwards = await weft.executor.human.exec(DANA, "benefits.open_window", { kind: "open_enrollment", opens_on: "2026-11-10", closes_on: "2026-11-02" });
    expect(backwards).toMatchObject({ ok: false, refusal: { code: "DOMAIN_BAD_DATES" } });
    const d = data<{ window_id: string; plan_year: number; status: string }>(await weft.executor.human.exec(DANA, "benefits.open_window", { kind: "open_enrollment", opens_on: "2026-11-02", closes_on: "2026-11-13" }));
    expect(d).toMatchObject({ plan_year: 2027, status: "scheduled" });
    expect(await weft.executor.human.exec(DANA, "benefits.open_window", { kind: "open_enrollment", opens_on: "2026-11-03", closes_on: "2026-11-20" })).toMatchObject({ ok: false, refusal: { code: "DOMAIN_OPEN_ENROLLMENT_LIVE" } });
    expect(await le.openEnrollmentDates(weft.db, "cmp_larkspur")).toEqual({ plan_year: 2027, opens_on: "2026-11-02", closes_on: "2026-11-13", window_id: d.window_id });
    const status = async () => (await weft.db.select().from(enrollmentWindows).where(eq(enrollmentWindows.id, d.window_id)))[0]!.status;

    await weft.clock.set("2026-11-01T17:00:00.000Z", 0);
    await weft.scheduler.tick();
    expect(await status()).toBe("scheduled");
    await weft.clock.set("2026-11-02T17:00:00.000Z", 0);
    await weft.scheduler.tick();
    expect(await status()).toBe("open");
    const [w] = (await call("usr_dana", "GET", "/v1/enrollment-windows?kind=open_enrollment")).json as unknown as { status: string; nextReminderOn: string | null }[];
    expect(w).toMatchObject({ status: "open", nextReminderOn: null });

    const stragglers = (await weft.db.select().from(openEnrollment).where(eq(openEnrollment.planYear, 2027))).filter((r) => r.status === "not_started" || r.status === "in_progress");
    expect(stragglers.length, "the seed has open enrollment stragglers").toBeGreaterThan(0);
    await weft.clock.set("2026-11-13T17:00:00.000Z", 0);
    await weft.scheduler.tick();
    expect(await status()).toBe("open");   // the close date is the last day to choose
    await weft.clock.set("2026-11-14T17:00:00.000Z", 0);
    await weft.scheduler.tick();
    expect(await status()).toBe("closed");
    const rows = await weft.db.select().from(openEnrollment).where(eq(openEnrollment.planYear, 2027));
    for (const s of stragglers) expect(rows.find((r) => r.id === s.id)!.status).toBe("waived");
    const closed = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM events WHERE type = 'enrollment_window.closed' AND subject_ref = ${d.window_id}`);
    expect(closed[0]!.n).toBe(1);
    // With no live window the chase falls back to the wave 2 dates.
    expect((await le.openEnrollmentDates(weft.db, "cmp_larkspur")).window_id).toBeNull();
  });
});
