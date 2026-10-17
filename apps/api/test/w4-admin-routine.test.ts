// R16 weekly cost by state (wave 4, w4-parity-admin): ships disabled, the precheck reads reports.breakdown in code,
// the scripted model only passes the derived arguments, the email waits as a comms.send_report proposal, nothing is
// sent until a person approves it, and the approved email carries the report's numbers. The script is inline here
// (the scenarios/ folder belongs to the integrator); it is what scenarios/rt_weekly_cost_by_state.json would hold.
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { AgentRunRow, ReadOnlyExecutor, RoutineRun, ToolOutcome } from "@weft/contracts";
import { scriptedProvider } from "@weft/agent";
import { proposals, simEmailMessages } from "@weft/db";
import { PREBUILT } from "../../../packages/routines/src/prebuilt";
import { RT_WEEKLY_COST_BY_STATE, weeklyCostByState } from "../../../packages/routines/src/wave4/admin";
import { createTestWeft, type TestWeft } from "../src/testing";

export const RT_WEEKLY_COST_BY_STATE_SCRIPT = {
  agents: {
    main: [
      { output: [{ type: "function_call" as const, name: "comms__send_report", arguments: "{{derived.comms.send_report}}" }] },
      { output: [{ type: "text" as const, text: "Proposed the weekly cost by state email to leadership; it waits for approval." }] },
    ],
  },
};

let weft: TestWeft;
beforeAll(async () => {
  const provider = scriptedProvider({ scriptsDir: fileURLToPath(new URL("../../../scenarios", import.meta.url)), scripts: { rt_weekly_cost_by_state: RT_WEEKLY_COST_BY_STATE_SCRIPT as never } });
  weft = await createTestWeft({ provider });
});
afterAll(async () => { await weft.close(); });

const json = { "content-type": "application/json" };
const post = (path: string, body: unknown, who = "usr_dana") => weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders(who), ...json }, body: JSON.stringify(body) });
async function trigger(routineId: string): Promise<RoutineRun> {
  const res = await post(`/v1/routines/${routineId}/trigger`, {});
  expect(res.status, await res.clone().text()).toBe(200);
  const { routineRunId } = (await res.json()) as { routineRunId: string };
  const engine = weft.routines as unknown as { settled(id: string): Promise<RoutineRun>; drain(ms?: number): Promise<boolean>; getRun(id: string): Promise<RoutineRun> };
  const run = await engine.settled(routineRunId);
  if (run.agentRunId) await (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(run.agentRunId);
  await engine.drain(5_000);
  return engine.getRun(run.id);
}

describe("rt_weekly_cost_by_state", () => {
  it("ships disabled on Monday mornings with two tools", () => {
    const r = PREBUILT.find((x) => x.id === "rt_weekly_cost_by_state");
    expect(r).toBe(RT_WEEKLY_COST_BY_STATE);
    expect(r).toMatchObject({ enabled: false, autonomy: "approve", trigger: { type: "cron", cron: "0 8 * * 1", tz: "America/Los_Angeles" }, tools: ["reports.breakdown", "comms.send_report"] });
  });

  it("skips with zero tokens when no paid run falls in the year so far", async () => {
    const empty: ReadOnlyExecutor = { exec: async (): Promise<ToolOutcome> => ({ ok: true, status: "done", resultId: "res_1", data: { rows: [], range_totals: {} }, summary: "", actionSeq: null, artifactRef: null, tainted: false, label: "synthetic" }) };
    expect(await weeklyCostByState({ companyId: "cmp_larkspur", now: "2026-01-05T16:00:00.000Z", triggerRef: "cron", payload: {} }, empty)).toMatchObject({ action: "skip" });
  });

  it("files one comms.send_report proposal from the derived arguments, sends nothing until approved, then emails the report", async () => {
    const before = await weft.db.select().from(simEmailMessages);
    const run = await trigger("rt_weekly_cost_by_state");
    // The run waits on the person: the checklist holds (a live proposal) and the email is left for approval.
    expect(run.status, JSON.stringify(run)).toBe("waiting_approval");
    expect(run.leftForHuman).toEqual([expect.stringContaining("comms.send_report")]);
    // Monday 26 October 2026 on the company calendar: the year so far.
    const pre = run.precheck as { action: string; derivedArgs: Record<string, unknown> };
    expect(pre.derivedArgs["comms.send_report"]).toEqual({ metric: "payroll_cost_by_state", from: "2026-01-01", to: "2026-10-26", recipients: ["leadership@larkspur.example"] });
    const filed = (await weft.db.select().from(proposals).where(eq(proposals.command, "comms.send_report"))).filter((p) => p.routineRunId === run.id);
    expect(filed).toHaveLength(1);
    expect(filed[0]!.status).toBe("pending");
    expect(await weft.db.select().from(simEmailMessages)).toHaveLength(before.length);

    expect((await post(`/v1/proposals/${filed[0]!.id}/approve`, { reasonCode: null, note: null })).status).toBe(200);
    const sent = (await weft.db.select().from(simEmailMessages)).filter((m) => m.toAddr === "leadership@larkspur.example" && m.subject.includes("2026-01-01 to 2026-10-26"));
    expect(sent).toHaveLength(1);
    // Every state's total in the email is the report's own figure.
    const report = (await (await post("/v1/tools/reports.breakdown", { metric: "payroll_cost_by_state", from: "2026-01-01", to: "2026-10-26" })).json()) as { data: { rows: { state: string; total_cents: number }[] } };
    for (const r of report.data.rows) expect(sent[0]!.body).toContain(r.state);
    expect(sent[0]!.body).not.toMatch(/\u2014/);

    // The approval wakes the run, which ends done with no model step; the gallery shows the run and the approval.
    const engine = weft.routines as unknown as { drain(ms?: number): Promise<boolean>; getRun(id: string): Promise<RoutineRun> };
    await engine.drain(5_000);
    const after = await engine.getRun(run.id);
    expect(after.status).toBe("done");
    const g = (await (await weft.app.request("/v1/routine-gallery", { headers: weft.uiHeaders("usr_dana") })).json()) as { routineId: string; lastRunStatus: string | null; approvals: number; nextRunAt: string | null }[];
    expect(g.find((r) => r.routineId === "rt_weekly_cost_by_state")).toMatchObject({ lastRunStatus: "done", approvals: 1, nextRunAt: null });
    const [c] = await weft.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM routine_runs WHERE routine_id = 'rt_weekly_cost_by_state'`);
    expect(c?.n).toBe(1);
  });
});
