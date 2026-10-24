// Per-action overrides end to end (wave 4, w4-parity-admin): an approved deny override takes the command out of the
// tool list the model is shown when a chat run starts, for the runs it binds only, and a propose_only override turns
// the agent's call into a proposal through the real pipeline.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentRunRow, ModelProvider, ModelStepRequest, ModelStepResult } from "@weft/contracts";
import { createTestWeft, type TestWeft } from "../src/testing";

const USAGE = { input: 10, cached: 0, cacheWrite: 0, output: 5, reasoning: 0 };
function capturingModel(): ModelProvider & { seen: ModelStepRequest[] } {
  const seen: ModelStepRequest[] = [];
  return {
    id: "scripted", model: "fake", label: "Fake model", live: false, seen,
    async step(req): Promise<ModelStepResult> {
      seen.push(req);
      return { stop: "final", text: "Here is what I found.", toolCalls: [], native: { turn: seen.length }, usage: USAGE, servedBy: "fake", requestId: null };
    },
  };
}

let weft: TestWeft;
const model = capturingModel();
beforeAll(async () => { weft = await createTestWeft({ provider: model }); });
afterAll(async () => { await weft.close(); });

const json = { "content-type": "application/json" };
const post = (path: string, body: unknown, who = "usr_dana") => weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders(who), ...json }, body: JSON.stringify(body) });
const settled = (runId: string) => (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(runId);

async function overrideApproved(principalId: string, command: string, mode: "deny" | "propose_only" | "clear") {
  const o = (await (await post("/v1/permissions/agent-actions", { principalId, command, mode })).json()) as { status: string; proposalId: string };
  expect(o.status).toBe("pending_approval");
  expect((await post(`/v1/proposals/${o.proposalId}/approve`, { reasonCode: null, note: null })).status).toBe(200);
}

/** The tool names the model was shown on the first step of a fresh chat run started by `who`. */
async function toolsShown(who: string): Promise<string[]> {
  const before = model.seen.length;
  const res = await post("/v1/agent/runs", { text: "Who is on the team?", threadId: null, pageContext: null }, who);
  expect(res.status).toBe(202);
  await settled(((await res.json()) as { runId: string }).runId);
  return model.seen[before]!.tools.map((t) => t.name);
}

describe("deny hides the command from the model's tools", () => {
  it("is shown before the override, hidden after it for the person it binds, and shown again once cleared", async () => {
    expect(await toolsShown("usr_dana")).toContain("people__search");
    await overrideApproved("usr_dana", "people.search", "deny");
    const dana = await toolsShown("usr_dana");
    expect(dana).not.toContain("people__search");
    expect(dana).toContain("people__get");
    // Sam's runs are not bound by Vic's row.
    expect(await toolsShown("usr_sam")).toContain("people__search");
    await overrideApproved("usr_dana", "people.search", "clear");
    expect(await toolsShown("usr_dana")).toContain("people__search");
  });

  it("set on the agent itself hides the command from every person's runs", async () => {
    await overrideApproved("agt_weft", "notices.get", "deny");
    expect(await toolsShown("usr_dana")).not.toContain("notices__get");
    expect(await toolsShown("usr_sam")).not.toContain("notices__get");
    await overrideApproved("agt_weft", "notices.get", "clear");
    expect(await toolsShown("usr_sam")).toContain("notices__get");
  });
});

describe("propose_only through the real pipeline", () => {
  it("turns an agent post that would run into a pending proposal", async () => {
    const run = async () => {
      const h = await weft.executor.runs.openChatRun({ principalId: "usr_sam", companyId: "cmp_larkspur", via: "ui", keyScope: null }, { threadId: null, surface: "human_ui", allowlist: ["comms.send_message"] });
      return weft.executor.agent.exec(h, { callId: "c1", command: "comms.send_message", args: { channel: "#general", text: "The handbook moved to the wiki." } });
    };
    expect(await run()).toMatchObject({ ok: true, status: "done" });
    await overrideApproved("usr_sam", "comms.send_message", "propose_only");
    expect(await run()).toMatchObject({ ok: true, status: "pending_approval" });
    await overrideApproved("usr_sam", "comms.send_message", "clear");
  });
});
