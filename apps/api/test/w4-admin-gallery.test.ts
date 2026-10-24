// Routine gallery (wave 4, w4-parity-admin; G10, G7, G8): created by, enabled at, last and next run, and approval and
// override counts per routine. Next runs are worked out by hand here (09:00 in Los Angeles, PDT until 1 November
// 2026, PST after), not with croner, and the counts come from proposal rows written in the test.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { RoutineGalleryRow } from "@weft/contracts";
import { proposals, routines } from "@weft/db";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft.close(); });

type Row = RoutineGalleryRow & { createdByName: string | null; schedule: string; pending: number };
const json = { "content-type": "application/json" };
const post = (path: string, body: unknown, who = "usr_dana") => weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders(who), ...json }, body: JSON.stringify(body) });
async function gallery(who = "usr_dana"): Promise<Row[]> {
  const res = await weft.app.request("/v1/routine-gallery", { headers: weft.uiHeaders(who) });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as Row[];
}
const byId = (rows: Row[], id: string) => rows.find((r) => r.routineId === id)!;

let n = 0;
async function routineRun(routineId: string, startedAt: string, status: string): Promise<string> {
  const id = `rtr_9${String(++n).padStart(3, "0")}`;
  await weft.db.run(sql`INSERT INTO routine_runs (id, routine_id, run_key, trigger_ref, status, started_at, ended_at) VALUES (${id}, ${routineId}, ${`k_${id}`}, ${`cron:${startedAt}`}, ${status}, ${startedAt}, ${startedAt})`);
  return id;
}
async function proposal(routineRunId: string, status: string) {
  const id = `prp_9${String(++n).padStart(3, "0")}`;
  await weft.db.insert(proposals).values({ id, companyId: "cmp_larkspur", kind: "command", command: "comms.send_message", headline: "Post", routineRunId, status,
    createdAt: "2026-10-20T16:00:00.000Z", expiresAt: "2026-10-27T16:00:00.000Z" });
}

describe("GET /v1/routine-gallery", () => {
  it("returns a RoutineGalleryRow for every routine but a retired one", async () => {
    const rows = await gallery();
    const all = await weft.db.select({ id: routines.id }).from(routines);
    // rt_compliance_notices was folded into rt_agency_notice: its row stays, disabled, and the gallery leaves it out.
    expect(all.map((r) => r.id)).toContain("rt_compliance_notices");
    expect(rows.map((r) => r.routineId).sort()).toEqual(all.map((r) => r.id).filter((id) => id !== "rt_compliance_notices").sort());
    for (const r of rows) expect(RoutineGalleryRow.safeParse(r).success, r.routineId).toBe(true);
  });

  it("gives the next cron slot after the sim clock in the routine's time zone, and none while disabled or event driven", async () => {
    // Monday 26 October 2026, 08:30 in Los Angeles (PDT, UTC-7).
    let rows = await gallery();
    expect(byId(rows, "rt_pre_payroll")).toMatchObject({ enabled: true, schedule: "cron 0 9 * * 1-5 (America/Los_Angeles)", nextRunAt: "2026-10-26T16:00:00.000Z" });
    expect(byId(rows, "rt_people_digest")).toMatchObject({ enabled: true, nextRunAt: "2026-10-26T16:00:00.000Z" });
    expect(byId(rows, "rt_agency_notice")).toMatchObject({ nextRunAt: null, schedule: "on notice.received" });
    // Monday 10:00 PDT: weekdays go to Tuesday 09:00 PDT; the Monday digest crosses the 1 November change to PST (UTC-8).
    await weft.clock.set("2026-10-26T17:00:00.000Z", 0);
    rows = await gallery();
    expect(byId(rows, "rt_pre_payroll").nextRunAt).toBe("2026-10-27T16:00:00.000Z");
    expect(byId(rows, "rt_people_digest").nextRunAt).toBe("2026-11-02T17:00:00.000Z");
    // Friday 30 October 10:00 PDT: the next weekday is Monday 2 November, 09:00 PST.
    await weft.clock.set("2026-10-30T17:00:00.000Z", 0);
    expect(byId(await gallery(), "rt_pre_payroll").nextRunAt).toBe("2026-11-02T17:00:00.000Z");
    await weft.clock.set("2026-10-26T15:30:00.000Z", 0);
    // Disabled: no next run, and no enabled at.
    await weft.db.update(routines).set({ enabled: false }).where(eq(routines.id, "rt_people_digest"));
    expect(byId(await gallery(), "rt_people_digest")).toMatchObject({ enabled: false, nextRunAt: null, enabledAt: null });
    await weft.db.update(routines).set({ enabled: true }).where(eq(routines.id, "rt_people_digest"));
  });

  it("shows the latest run with its status, and counts approvals and overrides on the routine's own proposals", async () => {
    const before = byId(await gallery(), "rt_pre_payroll");
    const a = await routineRun("rt_pre_payroll", "2026-10-21T16:00:00.000Z", "done");
    const b = await routineRun("rt_pre_payroll", "2026-10-23T16:00:00.000Z", "waiting_approval");
    await routineRun("rt_people_digest", "2026-10-25T16:00:00.000Z", "skipped");
    for (const s of ["approved", "executed", "failed"]) await proposal(a, s);
    for (const s of ["denied", "superseded", "dismissed"]) await proposal(b, s);
    await proposal(b, "pending");
    await proposal(b, "expired");
    const rows = await gallery();
    const pre = byId(rows, "rt_pre_payroll");
    expect(pre).toMatchObject({ lastRunAt: "2026-10-23T16:00:00.000Z", lastRunStatus: "waiting_approval" });
    expect(pre.approvals - before.approvals).toBe(3);
    expect(pre.overrides - before.overrides).toBe(3);
    expect(pre.pending - before.pending).toBe(1);
    // Another routine's proposals never count here.
    expect(byId(rows, "rt_people_digest")).toMatchObject({ lastRunAt: "2026-10-25T16:00:00.000Z", lastRunStatus: "skipped" });
  });

  it("names the person whose request drafted a custom routine, and dates enabled at from its approval", async () => {
    const res = await post("/v1/routines/draft", { prompt: "Every Friday, post open approvals to #payroll" });
    expect(res.status, await res.clone().text()).toBe(200);
    const [card] = (await weft.db.select().from(proposals)).filter((p) => p.kind === "routine_enable" && p.status === "pending");
    let row = byId(await gallery(), card!.subjectRef!);
    expect(row).toMatchObject({ source: "custom", createdBy: "usr_dana", createdByName: "Vic Akisole", enabled: false, enabledAt: null, nextRunAt: null });
    await weft.clock.set("2026-10-26T18:00:00.000Z", 0);
    expect((await post(`/v1/proposals/${card!.id}/approve`, { reasonCode: null, note: null })).status).toBe(200);
    row = byId(await gallery(), card!.subjectRef!);
    expect(row.enabled).toBe(true);
    expect(row.enabledAt).toBe("2026-10-26T18:00:00.000Z");
    // Friday 30 October 09:00 PDT.
    expect(row.nextRunAt).toBe("2026-10-30T16:00:00.000Z");
    // Prebuilt routines have no drafter.
    expect(byId(await gallery(), "rt_pre_payroll")).toMatchObject({ source: "prebuilt", createdBy: null, createdByName: null });
    await weft.clock.set("2026-10-26T15:30:00.000Z", 0);
  });
});
