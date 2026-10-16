// Scenario s7c (SPEC 12 GP5, harness 8). The browser path of the injection: the same delivery click as GP1, but the
// ca_de2088_injection notice. The scripted provider plays a model that reads the notice body (the
// rt_agency_notice.injection variant, chosen in compose.ts only for the scripted provider), so the run is tainted:
// the update and the filing are tainted proposals, nothing R2 to R4 executes, and no submit_run appears.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AgentRunRow } from "@weft/contracts";
import { actions, proposals, routineRuns } from "@weft/db";
import { createTestWeft, type TestWeft } from "./helpers";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft?.close(); });

const post = (path: string, body: unknown, who = "usr_dana") => weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders(who), "content-type": "application/json" }, body: JSON.stringify(body) });
const settled = (runId: string) => (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(runId);

async function deliver(scenario: string) {
  const res = await post("/v1/sim/notices/deliver", { scenario });
  expect(res.status, await res.clone().text()).toBe(200);
  for (let i = 0; i < 20; i++) {
    await weft.scheduler.tick();
    const rows = await weft.db.select().from(routineRuns).where(eq(routineRuns.routineId, "rt_agency_notice"));
    const rr = rows.at(-1);
    if (!rr?.agentRunId) continue;
    return { runId: rr.agentRunId, run: await settled(rr.agentRunId) };
  }
  throw new Error("no agency notice routine run after delivery");
}

describe("GP5 injection through the agency notice routine", () => {
  it("taints the run, keeps every write a proposal and verifies the chain", async () => {
    const before = new Set((await weft.db.select().from(actions)).map((a) => a.seq));
    const { runId, run } = await deliver("ca_de2088_injection");
    expect(run).toMatchObject({ status: "waiting", tainted: true });
    const open = (await weft.db.select().from(proposals)).filter((p) => p.proposerRunId === runId && p.status === "pending");
    expect(open.map((p) => p.command).sort()).toEqual(["notices.send_response", "tax.update_rate"]);
    for (const p of open) expect(p.taintedBy, `${p.command} carries the taint source`).toBeTruthy();
    const fresh = (await weft.db.select().from(actions)).filter((a) => !before.has(a.seq) && a.agentRunId === runId);
    expect(fresh.filter((a) => /^(tax\.update_rate|notices\.send_response|payroll\.submit_run|comms\.send_message)$/.test(a.command))).toHaveLength(0);
    expect((await weft.db.select().from(proposals)).some((p) => p.proposerRunId === runId && p.command === "payroll.submit_run")).toBe(false);
    expect((await weft.executor.verifyChain()).ok).toBe(true);
  });
});
