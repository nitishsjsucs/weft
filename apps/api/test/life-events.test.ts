// /v1 life events, enrollment windows and check-in routes (wave 4, w4-parity-people) over the seeded world.
// A reported life event opens a 30-day window with its source, reminders follow the window and stop when the
// employee elects, the date sweep closes windows; the check-in form validates CheckinAnswers and the manager sees
// direct reports only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { LIFE_EVENT_WINDOW_DAYS, type ToolOutcome } from "@weft/contracts";
import { checkins, enrollmentWindows, lifeEvents, principals, simEmailMessages, workers } from "@weft/db";
import { findCommand } from "@weft/core";
import { createTestWeft, type TestWeft } from "../src/testing";
import { sweepEnrollmentWindows } from "../src/routes/life-events";

type Win = { id: string; workerId: string; kind: string; lifeEventId: string; opensOn: string; closesOn: string; status: string; remindersSent: number; nextReminderOn: string | null; source: string | null; citation: string | null };
type Ev = { id: string; kind: string; status: string; eventDate: string; windowId: string | null; source: string; citation: string };

const DANA = { principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui" as const, keyScope: null };
const HIRE = "usr_t_hire";

describe("life events and enrollment windows", () => {
  let weft: TestWeft;
  let imaniWorker = "";
  let reportWorker = "";
  let otherWorker = "";
  beforeAll(async () => {
    weft = await createTestWeft();
    const [imani] = await weft.db.select().from(principals).where(eq(principals.id, "usr_imani"));
    imaniWorker = imani!.workerId!;
    const reports = await weft.db.select().from(workers).where(and(eq(workers.managerId, imaniWorker), eq(workers.status, "active")));
    reportWorker = reports[0]!.id;
    const others = await weft.db.select().from(workers).where(and(eq(workers.type, "employee"), eq(workers.status, "active")));
    otherWorker = others.find((w) => w.managerId !== imaniWorker && w.id !== imaniWorker)!.id;
    // A portal sign-in for one of Imani's direct reports (role employee reaches /v1/portal/* only).
    await weft.db.insert(principals).values({ id: HIRE, companyId: "cmp_larkspur", kind: "human", workerId: reportWorker, display: "Test hire", email: null, role: "employee",
      grantsJson: JSON.stringify({ people: "view", payroll: "none", tax: "none", benefits: "view", it: "none", comms: "none", company: "none" }) });
  });
  afterAll(async () => { await weft.close(); });

  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const windows = async (q = "") => (await call("usr_dana", "GET", `/v1/enrollment-windows${q}`)).json as unknown as Win[];

  it("a reported life event opens a window of the documented length with its source", async () => {
    const res = await call(HIRE, "POST", "/v1/portal/life-events", { kind: "marriage", eventDate: "2026-10-20", note: "Married at the courthouse" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const o = res.json as unknown as Extract<ToolOutcome, { ok: true; status: "done" }>;
    const d = o.data as { window_id: string; opens_on: string; closes_on: string; days: number; citation: string; source: string };
    expect(d).toMatchObject({ opens_on: "2026-10-20", closes_on: "2026-11-19", days: LIFE_EVENT_WINDOW_DAYS, citation: "29 CFR 2590.701-6" });
    expect(d.source).toMatch(/^https:\/\/www\.ecfr\.gov\//);

    const [w] = await windows(`?workerId=${reportWorker}`);
    expect(w).toMatchObject({ kind: "life_event", status: "open", opensOn: "2026-10-20", closesOn: "2026-11-19", remindersSent: 0, nextReminderOn: "2026-11-05", citation: "29 CFR 2590.701-6" });
    const evs = (await call("usr_dana", "GET", "/v1/life-events?status=window_open")).json as unknown as { data: Ev[] };
    expect(evs.data).toHaveLength(1);
    expect(JSON.stringify(evs.data)).not.toContain("courthouse");   // the employee's note never reaches a list an agent reads
    const mine = (await call(HIRE, "GET", "/v1/portal/life-events")).json as unknown as { lifeEvents: Ev[]; windows: Win[]; plans: { id: string; type: string }[] };
    expect(mine.lifeEvents.map((e) => e.kind)).toEqual(["marriage"]);
    expect(mine.plans.some((p) => p.type === "hsa")).toBe(false);
  });

  it("refuses a future date and a duplicate, records a late report as rejected, and keeps HR routes off the portal sign-in", async () => {
    const future = await call(HIRE, "POST", "/v1/portal/life-events", { kind: "birth", eventDate: "2026-11-02" });
    expect([future.status, future.json.code]).toEqual([422, "DOMAIN_FUTURE_EVENT"]);
    const dup = await call(HIRE, "POST", "/v1/portal/life-events", { kind: "marriage", eventDate: "2026-10-20" });
    expect([dup.status, dup.json.code]).toEqual([422, "DOMAIN_DUPLICATE_LIFE_EVENT"]);
    const bad = await call(HIRE, "POST", "/v1/portal/life-events", { kind: "promotion", eventDate: "2026-10-20" });
    expect(bad.status).toBe(400);
    const late = await call(HIRE, "POST", "/v1/portal/life-events", { kind: "move", eventDate: "2026-09-01" });
    expect(((late.json as { data: { status: string; window_id: null } }).data)).toMatchObject({ status: "rejected", window_id: null });
    expect((await call(HIRE, "GET", "/v1/life-events")).status).toBe(403);
    // Reporting and electing are the employee's own submissions: human only, never a tool or an MCP call.
    for (const n of ["benefits.report_life_event", "benefits.elect_in_window", "onboarding.submit_checkin_form"]) expect(findCommand(n)).toMatchObject({ access: "human_only", tiers: { main: "unavailable", task: "unavailable" }, mcp: "hidden" });
  });

  it("reminders follow the window dates, once per date, and stop when the employee elects", async () => {
    const [w] = await windows(`?workerId=${reportWorker}&status=open`);
    const remind = (asOf: string) => weft.executor.human.exec(DANA, "benefits.send_window_reminders", { as_of: asOf });
    const sent = (o: ToolOutcome) => (o.ok && o.status === "done" ? (o.data as { count: number }).count : -1);
    expect(sent(await remind("2026-11-04"))).toBe(0);
    expect(sent(await remind("2026-11-05"))).toBe(1);
    expect(sent(await remind("2026-11-06"))).toBe(0);
    const mail = await weft.db.select().from(simEmailMessages).where(eq(simEmailMessages.relatedRef, w!.id));
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe("Your benefits window closes 2026-11-19");
    expect(mail[0]!.body).not.toContain("courthouse");
    // A missed run sends one reminder, not a burst, and counts both dates.
    expect(sent(await remind("2026-11-18"))).toBe(1);
    expect((await windows(`?workerId=${reportWorker}&status=open`))[0]!.remindersSent).toBe(3);

    // Elect: a medical tier change. The window closes and nothing more is due.
    const plans = (await call(HIRE, "GET", "/v1/portal/life-events")).json as unknown as { plans: { id: string; type: string; carrier: string }[] };
    const ppo = plans.plans.find((p) => p.type === "medical")!;
    const badTier = await call(HIRE, "POST", `/v1/portal/enrollment-windows/${w!.id}/elections`, { elections: [{ planId: ppo.id }] });
    expect([badTier.status, badTier.json.code]).toEqual([422, "DOMAIN_BAD_TIER"]);
    const other = await call("usr_imani", "POST", `/v1/portal/enrollment-windows/${w!.id}/elections`, { elections: [{ planId: ppo.id, tier: "ee_spouse" }] });
    expect([other.status, other.json.code]).toEqual([422, "UNKNOWN_REFERENCE"]);
    const ok = await call(HIRE, "POST", `/v1/portal/enrollment-windows/${w!.id}/elections`, { elections: [{ planId: ppo.id, tier: "ee_spouse" }] });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((ok.json as { data: { status: string; queued: { carrier: string }[] } }).data).toMatchObject({ status: "elected", queued: [{ carrier: ppo.carrier }] });
    const [closed] = await windows(`?workerId=${reportWorker}`);
    expect(closed).toMatchObject({ status: "closed", nextReminderOn: null });
    expect(sent(await remind("2026-11-18"))).toBe(0);
    const [ev] = await weft.db.select().from(lifeEvents).where(eq(lifeEvents.id, closed!.lifeEventId));
    expect(ev!.status).toBe("elected");
  });

  it("the date sweep closes a window past its date and expires the unelected life event, once", async () => {
    const res = await call("usr_imani", "POST", "/v1/portal/life-events", { kind: "birth", eventDate: "2026-10-24" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const wid = (res.json as { data: { window_id: string } }).data.window_id;
    await sweepEnrollmentWindows({ db: weft.db, executor: weft.executor, now: "2026-11-23T17:00:00.000Z" });   // closes Nov 23: still open that day
    expect((await weft.db.select().from(enrollmentWindows).where(eq(enrollmentWindows.id, wid)))[0]!.status).toBe("open");
    await sweepEnrollmentWindows({ db: weft.db, executor: weft.executor, now: "2026-11-24T17:00:00.000Z" });
    const [w] = await weft.db.select().from(enrollmentWindows).where(eq(enrollmentWindows.id, wid));
    expect(w!.status).toBe("closed");
    const [ev] = await weft.db.select().from(lifeEvents).where(eq(lifeEvents.windowId, wid));
    expect(ev!.status).toBe("expired");
    const late = await call("usr_imani", "POST", `/v1/portal/enrollment-windows/${wid}/elections`, { noChange: true });
    expect([late.status, late.json.code]).toEqual([422, "DOMAIN_WINDOW_CLOSED"]);
  });
});

describe("the 30-day check-in form", () => {
  let weft: TestWeft;
  let reportWorker = "";
  let otherWorker = "";
  beforeAll(async () => {
    weft = await createTestWeft();
    const [imani] = await weft.db.select().from(principals).where(eq(principals.id, "usr_imani"));
    const reports = await weft.db.select().from(workers).where(and(eq(workers.managerId, imani!.workerId!), eq(workers.status, "active")));
    reportWorker = reports[0]!.id;
    const others = await weft.db.select().from(workers).where(and(eq(workers.type, "employee"), eq(workers.status, "active")));
    otherWorker = others.find((w) => w.managerId !== imani!.workerId && w.id !== imani!.workerId)!.id;
    await weft.db.insert(principals).values({ id: HIRE, companyId: "cmp_larkspur", kind: "human", workerId: reportWorker, display: "Test hire", email: null, role: "employee",
      grantsJson: JSON.stringify({ people: "view", payroll: "none", tax: "none", benefits: "view", it: "none", comms: "none", company: "none" }) });
    const at = "2026-10-26T15:30:00.000Z";
    await weft.db.insert(checkins).values([
      { id: "chk_9001", workerId: reportWorker, dueOn: "2026-10-24", status: "sent", answersJson: null, sentAt: at, nudgedAt: null, submittedAt: null, createdAt: at },
      { id: "chk_9002", workerId: otherWorker, dueOn: "2026-10-24", status: "sent", answersJson: null, sentAt: at, nudgedAt: null, submittedAt: null, createdAt: at },
    ]);
  });
  afterAll(async () => { await weft.close(); });

  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it("validates CheckinAnswers, takes only the caller's own open check-in, and emails the manager no written words", async () => {
    expect(((await call(HIRE, "GET", "/v1/portal/checkins")).json as unknown as { id: string }[]).map((c) => c.id)).toEqual(["chk_9001"]);
    expect((await call(HIRE, "POST", "/v1/portal/checkins/chk_9001/submit", { settled: 6, tools: true, clarity: true })).status).toBe(400);
    expect((await call(HIRE, "POST", "/v1/portal/checkins/chk_9001/submit", { settled: 4, tools: "yes", clarity: true })).status).toBe(400);
    expect((await call(HIRE, "POST", "/v1/portal/checkins/chk_9001/submit", { settled: 4, tools: true, clarity: true, extra: 1 })).status).toBe(400);
    const theirs = await call(HIRE, "POST", "/v1/portal/checkins/chk_9002/submit", { settled: 4, tools: true, clarity: true });
    expect([theirs.status, theirs.json.code]).toEqual([422, "UNKNOWN_REFERENCE"]);
    const ok = await call(HIRE, "POST", "/v1/portal/checkins/chk_9001/submit", { settled: 4, tools: false, clarity: true, blocker: "Waiting on the CAD license", manager_note: "Loving the team" });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const again = await call(HIRE, "POST", "/v1/portal/checkins/chk_9001/submit", { settled: 4, tools: true, clarity: true });
    expect([again.status, again.json.code]).toEqual([422, "DOMAIN_CHECKIN_CLOSED"]);
    const [mail] = await weft.db.select().from(simEmailMessages).where(eq(simEmailMessages.relatedRef, "chk_9001"));
    expect(mail!.body).toContain("How settled they feel: mostly settled.");
    expect(mail!.body).toContain("Every tool and account they need: no.");
    expect(mail!.body).not.toMatch(/CAD license|Loving the team/);
    expect(mail!.body).not.toMatch(/\d/);
  });

  it("the manager sees direct reports only, with the hire's written answers; others see none", async () => {
    const mine = (await call("usr_imani", "GET", "/v1/checkins")).json as unknown as { id: string; settled: number; tools: boolean; written: { blocker: string } }[];
    expect(mine.map((c) => c.id)).toEqual(["chk_9001"]);
    expect(mine[0]).toMatchObject({ settled: 4, tools: false, written: { blocker: "Waiting on the CAD license" } });
    expect((await call("usr_imani", "GET", "/v1/checkins?status=sent")).json).toEqual([]);
    expect((await call("usr_dana", "GET", "/v1/checkins")).json).toEqual([]);
    expect((await call(HIRE, "GET", "/v1/checkins")).status).toBe(403);
  });
});
