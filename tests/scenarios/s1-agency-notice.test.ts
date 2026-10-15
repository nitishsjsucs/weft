// Scenario s1 (SPEC 12, 13). Owner: t4-agent. GP1 tax notice to rate change (hero), scripted provider
// (scenarios/rt_agency_notice.json). Needs the merged world (T2 seed and simulators, T3 executor and decide, the
// events source for the routines engine): until those land each test skips itself, naming the missing parts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AgentRunRow } from "@weft/contracts";
import { actions, agentRuns, notices, proposals, routineRuns } from "@weft/db";
import { createTestWeft, type TestWeft } from "./helpers";

let weft: TestWeft;
let missing: string[] = [];
beforeAll(async () => {
  weft = await createTestWeft();
  missing = weft.stubs.filter((s) => ["sim", "executor", "agent", "routines"].includes(s) || s.startsWith("wiring"));
});
afterAll(async () => { await weft?.close(); });

const post = (path: string, body: unknown, who = "usr_dana") => weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders(who), "content-type": "application/json" }, body: JSON.stringify(body) });
const settled = (runId: string) => (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(runId);

async function deliverAndPropose() {
  const res = await post("/v1/sim/notices/deliver", { scenario: "ca_de2088_rate_change" });
  expect(res.status, await res.clone().text()).toBe(200);
  // The scheduler tick fires rt_agency_notice from the notice.received event; the agent run itself is queued, so
  // wait for it to settle before reading its proposals.
  for (let i = 0; i < 20; i++) {
    await weft.scheduler.tick();
    const [rr] = await weft.db.select().from(routineRuns).where(eq(routineRuns.routineId, "rt_agency_notice"));
    if (!rr?.agentRunId) continue;
    const run = await settled(rr.agentRunId);
    const rows = (await weft.db.select().from(proposals)).filter((p) => p.status === "pending" && p.proposerRunId === rr.agentRunId);
    return { runId: rr.agentRunId, run, proposals: rows };
  }
  throw new Error("GP1: no agency notice routine run after delivering the notice (is the events source wired into createRoutines?)");
}

describe("GP1 tax notice to rate change (hero)", () => {
  it("runs end to end with the scripted provider (t4-agent)", async (ctx) => {
    if (missing.length) return ctx.skip(`waiting for: ${missing.join(", ")}`);
    const { runId, run, proposals: open } = await deliverAndPropose();
    expect(open.map((p) => p.command).sort()).toEqual(["notices.send_response", "tax.update_rate"]);
    expect(run).toMatchObject({ status: "waiting", tainted: false, stepsUsed: 2 });
    const rate = open.find((p) => p.command === "tax.update_rate")!;
    expect(JSON.parse(rate.argsJson!)).toMatchObject({ code: "sui", rate: "0.015", effective_from: "2026-01-01" });
    expect((await weft.db.select().from(actions)).filter((a) => a.agentRunId === runId && ["tax.update_rate", "notices.send_response"].includes(a.command))).toHaveLength(0);
    for (const p of open) {
      const res = await post(`/v1/proposals/${p.id}/approve`, { reasonCode: null, note: null });
      expect(res.status, await res.clone().text()).toBe(200);
    }
    const [after] = await weft.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(after).toMatchObject({ status: "done", stepsUsed: 2 });
    const noticeId = JSON.parse(rate.argsJson!).source_notice_id as string;
    const [n] = await weft.db.select().from(notices).where(eq(notices.id, noticeId));
    expect(n?.status).toBe("resolved");
  });

  it("verifies the action chain and memory SHAs (t4-agent)", async (ctx) => {
    if (missing.length) return ctx.skip(`waiting for: ${missing.join(", ")}`);
    expect((await weft.executor.verifyChain()).ok).toBe(true);
  });
});
