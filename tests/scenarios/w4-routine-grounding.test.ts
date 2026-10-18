// Scenario (after the wave 4 model comparison): a prebuilt routine's message quotes figures its precheck computed.
// Imani (wrk_0004, CA) has left, so the weekly people digest counts 47 employees with CA 21. The company facts the
// message guard always had count CA 22 (every employee ever placed there), so before the fix the digest was refused
// UNGROUNDED on every retry until the step cap. Now comms.send_message also indexes the structured figures of the
// routine run's own precheck: the derived text posts, a figure the routine did not compute is still refused, and a
// tainted routine's precheck adds nothing. Scripted provider, with an inline rt_people_digest script that first sends
// a made-up count, then the derived text.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { AgentRunRow, RoutineRun } from "@weft/contracts";
import { actions, routineRuns, routines, runSteps, workers } from "@weft/db";
import { DEFAULT_SCRIPTS_DIR, scriptedProvider } from "../../packages/agent/src/index";
import { routineFigures } from "../../packages/core/src/comms/send";
import { createTestWeft, type TestWeft } from "./helpers";

const MADE_UP = "Weekly people digest: 47 employees by work state (CA 25, NY 14, TX 12). Open items are in the Weft inbox.";
const DIGEST_SCRIPT = {
  agents: {
    main: [
      { output: [{ type: "function_call" as const, name: "comms__send_message", arguments: { channel: "#people-ops", text: MADE_UP } }] },
      {
        expect: { lastResults: [{ tool: "comms__send_message", ok: false, code: "UNGROUNDED" }] },
        output: [{ type: "function_call" as const, name: "comms__send_message", arguments: "{{derived.comms.send_message}}" }],
      },
      { expect: { lastResults: [{ tool: "comms__send_message", ok: true, status: "done" }] }, output: [{ type: "text" as const, text: "Posted the weekly people digest in #people-ops." }] },
    ],
  },
};

let weft: TestWeft;
beforeAll(async () => {
  weft = await createTestWeft({ provider: scriptedProvider({ scriptsDir: DEFAULT_SCRIPTS_DIR, scripts: { rt_people_digest: DIGEST_SCRIPT } }) });
  await weft.db.update(workers).set({ status: "inactive", endDate: "2026-10-16" }).where(eq(workers.id, "wrk_0004"));
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
const outcomes = async (runId: string) => (await weft.db.select().from(runSteps).where(and(eq(runSteps.runId, runId), eq(runSteps.kind, "tool_call"))))
  .map((s) => (JSON.parse(s.resultJson ?? "{}") as { outcome: { ok: boolean; status?: string; refusal?: { code: string; message: string; hint: string | null } } }).outcome);

describe("a prebuilt routine's message grounds the figures its precheck computed", () => {
  it("the people digest after a departure: a made-up count is refused, the derived counts post, the run is done", async () => {
    const run = await trigger("rt_people_digest");
    expect(run.status).toBe("done");
    const [made, derived] = await outcomes(run.agentRunId!);
    expect(made).toMatchObject({ ok: false, refusal: { code: "UNGROUNDED", message: "Ungrounded numbers in the message: 25" } });
    expect(made!.refusal!.hint).toMatch(/findings and derived arguments/);
    expect(derived).toMatchObject({ ok: true, status: "done" });
    const chat = (await call("GET", `/v1/sim/chat?channel=${encodeURIComponent("#people-ops")}`)).json as { text: string }[];
    const posts = chat.filter((m) => m.text.startsWith("Weekly people digest"));
    expect(posts.map((m) => m.text)).toEqual(["Weekly people digest: 47 employees by work state (CA 21, NY 14, TX 12). Open items are in the Weft inbox. Out this week: nobody."]);
    const sent = await weft.db.select().from(actions).where(eq(actions.command, "comms.send_message"));
    expect(sent).toHaveLength(1);
    const [agent] = await weft.db.all<{ status: string; steps_used: number }>(sql`SELECT status, steps_used FROM agent_runs WHERE id = ${run.agentRunId}`);
    expect(agent).toEqual({ status: "done", steps_used: 3 });
  });

  it("routineFigures: only this company's untainted routine run that ran, and only its structured figures", async () => {
    const [digest] = await weft.db.select().from(routineRuns).where(eq(routineRuns.routineId, "rt_people_digest"));
    const figures = await routineFigures(weft.db as never, "cmp_larkspur", digest!.id);
    expect(figures).toEqual({ routine_precheck: { findings: { headcount: 47, by_state: { CA: 21, NY: 14, TX: 12 }, statuses: [null, null, null], status_reads: 3 } } });
    expect(await routineFigures(weft.db as never, "cmp_other", digest!.id)).toBeNull();
    expect(await routineFigures(weft.db as never, "cmp_larkspur", null)).toBeNull();
    expect(await routineFigures(weft.db as never, "cmp_larkspur", "rtr_nosuchrun")).toBeNull();

    // A tainted routine (a person's upload) and a skipped precheck contribute nothing.
    const pre = JSON.stringify({ action: "run", severity: "digest", subjectRefs: [], findings: { amount_cents: 750000 }, derivedArgs: null });
    const [def] = await weft.db.select().from(routines).where(eq(routines.id, "rt_people_digest"));
    await weft.db.insert(routines).values({ ...def!, id: "rt_upload_probe", source: "custom", taintedBy: "upload:upl_0001", enabled: false });
    await weft.db.insert(routineRuns).values({ id: "rtr_upload_probe", routineId: "rt_upload_probe", runKey: "probe-upload", triggerRef: "manual:probe", status: "done", attended: true, startedAt: "2026-10-26T15:30:00.000Z", precheckJson: pre });
    await weft.db.insert(routineRuns).values({ id: "rtr_skip_probe", routineId: "rt_people_digest", runKey: "probe-skip", triggerRef: "manual:probe-skip", status: "skipped", attended: true, startedAt: "2026-10-26T15:30:00.000Z", precheckJson: JSON.stringify({ action: "skip", reason: "Nothing to post 7,500." }) });
    expect(await routineFigures(weft.db as never, "cmp_larkspur", "rtr_upload_probe")).toBeNull();
    expect(await routineFigures(weft.db as never, "cmp_larkspur", "rtr_skip_probe")).toBeNull();
  });
});
