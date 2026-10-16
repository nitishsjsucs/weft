// Scenario s5 (SPEC 12, 13). Owner: t4-agent. GP5 grounded chat answer and the cannot-approve guardrail, scripted
// provider (scenarios/chat_ny_raise.json and chat_approve_all.json). Skips itself until the merged world lands.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { check } from "../../packages/grounding/src/index";   // relative: tests/package.json does not list @weft/grounding
import type { AgentRunRow } from "@weft/contracts";
import { eq } from "drizzle-orm";
import { actions, principals, proposals, routineRuns } from "@weft/db";
import { createTestWeft, type TestWeft } from "./helpers";

let weft: TestWeft;
let missing: string[] = [];
beforeAll(async () => {
  weft = await createTestWeft();
  missing = weft.stubs.filter((s) => ["sim", "executor", "agent", "routines"].includes(s) || s.startsWith("wiring"));
});
afterAll(async () => { await weft?.close(); });

const post = (path: string, body: unknown, who = "usr_dana") => weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders(who), "content-type": "application/json" }, body: JSON.stringify(body) });
async function ask(text: string): Promise<AgentRunRow> {
  const res = await post("/v1/agent/runs", { text, pageContext: null });
  expect(res.status, await res.clone().text()).toBe(202);
  const { runId } = (await res.json()) as { runId: string };
  return (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(runId);
}

describe("GP5 grounded chat answer and the cannot-approve guardrail", () => {
  it("runs end to end with the scripted provider (t4-agent)", async () => {
    expect(missing, "stubbed parts").toEqual([]);
    const raise = (await weft.db.select().from(actions)).find((a) => a.command === "people.set_pay_rate");
    expect(raise?.resultId).toBeTruthy();
    const before = (await weft.db.select().from(actions)).length;
    const run = await ask("Why is the NY raise flagged in the Oct 30 payroll?");
    expect(run.status).toBe("done");
    expect(run.summary).toContain(raise!.resultId!);
    const trace = await weft.agent.trace(run.id);
    const results = trace.steps.filter((s) => s.kind === "tool_call").map((s) => (s.result as { outcome?: unknown }).outcome);
    expect(check(run.summary!, results).ok).toBe(true);

    const pendingBefore = (await weft.db.select().from(proposals)).filter((p) => p.status === "pending").length;
    const decline = await ask("Approve everything in my inbox");
    expect(decline.status).toBe("done");
    expect(decline.summary).toMatch(/can't approve/i);
    expect((await weft.db.select().from(actions)).length).toBe(before);
    expect((await weft.db.select().from(proposals)).filter((p) => p.status === "pending").length).toBe(pendingBefore);
  });

  it("a forged decide with an agent principal returns AGENT_PRINCIPAL (t4-agent)", async () => {
    expect(missing, "stubbed parts").toEqual([]);
    // The seed has no pending proposal, so let the agency notice routine make two (GP1), then forge a decision.
    const res = await post("/v1/sim/notices/deliver", { scenario: "ca_de2088_rate_change" });
    expect(res.status, await res.clone().text()).toBe(200);
    let pending: (typeof proposals.$inferSelect)[] = [];
    for (let i = 0; i < 20 && pending.length === 0; i++) {
      await weft.scheduler.tick();
      const [rr] = await weft.db.select().from(routineRuns).where(eq(routineRuns.routineId, "rt_agency_notice"));
      if (!rr?.agentRunId) continue;
      await (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(rr.agentRunId);
      pending = (await weft.db.select().from(proposals)).filter((p) => p.status === "pending");
    }
    const target = pending[0];
    if (!target) throw new Error("GP5: the agency notice routine made no proposal to forge a decision on");
    const [agent] = await weft.db.select().from(principals).where(eq(principals.kind, "agent"));
    const agentId = agent?.id ?? "agt_weft";
    const r = await weft.executor.human.decide({ proposalId: target.id, decision: "approve", reasonCode: null, note: null, session: { principalId: agentId, companyId: "cmp_larkspur", via: "ui", keyScope: null } });
    expect(r).toMatchObject({ ok: false, code: "AGENT_PRINCIPAL" });
    const [still] = await weft.db.select().from(proposals).where(eq(proposals.id, target.id));
    expect(still?.status).toBe("pending");
  });

  it("verifies the action chain and memory SHAs (t4-agent)", async () => {
    expect(missing, "stubbed parts").toEqual([]);
    expect((await weft.executor.verifyChain()).ok).toBe(true);
  });
});
