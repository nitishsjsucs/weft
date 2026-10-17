// Scenario (wave 4, w4-parity-people): the first-day message. Scripted provider (scenarios/rt_first_day_message.json).
// A hire starts on Mon Nov 2. Before then rt_first_day_message skips; on the start date it welcomes the hire and tells
// the manager and team (R3 email, autoAllow untainted, so no proposal); a second run that day skips: once per hire.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { AgentRunRow, RoutineRun } from "@weft/contracts";
import { principals, simEmailMessages, workers } from "@weft/db";
import { PREBUILT } from "../../packages/routines/src/prebuilt";
import { createTestWeft, type TestWeft } from "./helpers";

let weft: TestWeft;
const HIRE = "wrk_9102";
beforeAll(async () => {
  weft = await createTestWeft();
  const [imani] = await weft.db.select().from(principals).where(eq(principals.id, "usr_imani"));
  const [base] = await weft.db.select().from(workers).where(and(eq(workers.managerId, imani!.workerId!), eq(workers.status, "active")));
  await weft.db.insert(workers).values({ ...base!, id: HIRE, employeeNumber: null, firstName: "Kai", lastName: "Tester", preferredName: null, workEmail: "kai.tester@larkspur.example", status: "onboarding", startDate: "2026-11-02", endDate: null });
});
afterAll(async () => {
  for (let i = 0; i < 10; i++) {
    const open = await weft.db.all<{ id: string }>(sql`SELECT id FROM routine_runs WHERE status IN ('queued', 'running')`);
    if (!open.length) break;
    for (const r of open) await (weft.routines as unknown as { settled(id: string): Promise<unknown> }).settled(r.id);
  }
  await weft?.close();
});

const call = async (method: string, path: string, body?: unknown, who = "usr_dana") => {
  const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};
const trigger = async (routineId: string): Promise<RoutineRun> => {
  const { json } = await call("POST", `/v1/routines/${routineId}/trigger`, {});
  const engine = weft.routines as unknown as { settled(id: string): Promise<RoutineRun> };
  const run = await engine.settled(json.routineRunId);
  if (run.agentRunId) await (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(run.agentRunId);
  await (weft.routines as unknown as { drain(ms?: number): Promise<boolean> }).drain(5_000);
  return (await (weft.routines as unknown as { getRun(id: string): Promise<RoutineRun> }).getRun(run.id));
};
const mailFor = async () => weft.db.select().from(simEmailMessages).where(eq(simEmailMessages.relatedRef, HIRE));

describe("first-day message (rt_first_day_message)", () => {
  it("ships disabled with at most 8 tools, a daily morning trigger and an untainted auto-allow", async () => {
    const r = PREBUILT.find((x) => x.id === "rt_first_day_message");
    expect(r).toMatchObject({ enabled: false, trigger: { type: "cron", cron: "0 8 * * *" } });
    expect(r!.tools.length).toBeLessThanOrEqual(8);
    const { findCommand } = await import("@weft/core");
    expect(findCommand("comms.send_first_day_message")).toMatchObject({ risk: expect.any(Function), approval: "always", autoAllow: "untainted" });
  });

  it("skips before the start date", async () => {
    const run = await trigger("rt_first_day_message");
    expect(run.status).toBe("skipped");
    expect(await mailFor()).toHaveLength(0);
  });

  it("on the start date it welcomes the hire and tells the team, once", async () => {
    await weft.clock.set("2026-11-02T16:00:00.000Z", 0);   // 08:00 PT
    const run = await trigger("rt_first_day_message");
    expect(run.status, JSON.stringify(run)).toBe("done");
    expect((run.precheck as { derivedArgs: Record<string, any> }).derivedArgs["comms.send_first_day_message"]).toEqual({ worker_ids: [HIRE], as_of: "2026-11-02" });
    const mail = await mailFor();
    expect(mail.filter((m) => m.toAddr === "kai.tester@larkspur.example").map((m) => m.subject)).toEqual(["Welcome to Larkspur Robotics, Kai Tester (demo)"]);
    expect(mail.filter((m) => m.subject === "Kai Tester (demo) starts today").length).toBeGreaterThan(0);
    const props = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM proposals WHERE command = 'comms.send_first_day_message'`);
    expect(props[0]!.n).toBe(0);   // untainted: sent without a proposal
    const evs = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM events WHERE type = 'worker.first_day' AND subject_ref = ${HIRE}`);
    expect(evs[0]!.n).toBe(1);

    expect((await trigger("rt_first_day_message")).status).toBe("skipped");
    expect(await mailFor()).toHaveLength(mail.length);
  });
});
