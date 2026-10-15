// Scenario s5 (SPEC 12, 13). Owner: t4-agent. GP5 grounded chat answer and the cannot-approve guardrail, scripted
// provider (scenarios/chat_ny_raise.json and chat_approve_all.json). Skips itself until the merged world lands.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { check } from "../../packages/grounding/src/index";   // relative: tests/package.json does not list @weft/grounding
import type { AgentRunRow } from "@weft/contracts";
import { actions, proposals } from "@weft/db";
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
  it("runs end to end with the scripted provider (t4-agent)", async (ctx) => {
    if (missing.length) return ctx.skip(`waiting for: ${missing.join(", ")}`);
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

  it("a forged decide with an agent principal returns AGENT_PRINCIPAL (t4-agent)", async (ctx) => {
    if (missing.length) return ctx.skip(`waiting for: ${missing.join(", ")}`);
    const any = (await weft.db.select().from(proposals))[0];
    if (!any) return ctx.skip("no proposal in the seed to forge a decision on");
    const r = await weft.executor.human.decide({ proposalId: any.id, decision: "approve", reasonCode: null, note: null, session: { principalId: "agt_weft", companyId: "cmp_larkspur", via: "ui", keyScope: null } });
    expect(r).toMatchObject({ ok: false, code: "AGENT_PRINCIPAL" });
  });

  it("verifies the action chain and memory SHAs (t4-agent)", async (ctx) => {
    if (missing.length) return ctx.skip(`waiting for: ${missing.join(", ")}`);
    expect((await weft.executor.verifyChain()).ok).toBe(true);
  });
});
