// Scenario GP13, chat half (docs/wave3.md 5, research/wave3/expenses-timeoff.md E13). Owner: w3-expenses. Asked to
// approve every open expense, the agent refuses bulk approval and offers to go item by item; no decision executes and
// no proposal is filed. The script is scenarios/chat_expenses_approve_all.json, forced here because the older generic
// chat_approve_all.json also matches "approve all" (contract request in docs/tracks/w3-expenses.md).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentRunRow } from "@weft/contracts";
import { actions, expenses, proposals } from "@weft/db";
import { DEFAULT_SCRIPTS_DIR, scriptedProvider } from "../../packages/agent/src/index";
import { createTestWeft, type TestWeft } from "./helpers";

const SCRIPT = "chat_expenses_approve_all";
let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft({ provider: scriptedProvider({ scriptsDir: DEFAULT_SCRIPTS_DIR, scenario: SCRIPT }) }); });
afterAll(async () => { await weft.close(); });

describe("GP13 no bulk approval in chat", () => {
  it("the script matches the request and says there is no bulk approval", () => {
    const s = JSON.parse(readFileSync(join(import.meta.dirname, `../../scenarios/${SCRIPT}.json`), "utf8")) as { match: string };
    for (const ask of ["Approve all open expenses", "approve all the pending expenses", "Can you approve every expense?"]) expect(new RegExp(s.match, "i").test(ask), ask).toBe(true);
  });

  it("asked to approve all open expenses, the agent executes zero decisions and offers a walk-through", async () => {
    const before = { actions: (await weft.db.select().from(actions)).length, proposals: (await weft.db.select().from(proposals)).length };
    const res = await weft.app.request("/v1/agent/runs", { method: "POST", headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: JSON.stringify({ text: "Approve all open expenses", pageContext: null }) });
    expect(res.status, await res.clone().text()).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    const run = await (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(runId);
    expect(run.status).toBe("done");
    expect(run.summary).toMatch(/no bulk approval/i);
    expect(run.summary).toMatch(/one at a time/i);
    expect((await weft.db.select().from(actions)).length).toBe(before.actions);
    expect((await weft.db.select().from(actions)).filter((a) => a.command === "expenses.decide")).toHaveLength(0);
    expect((await weft.db.select().from(proposals)).length).toBe(before.proposals);
    expect((await weft.db.select().from(expenses)).filter((e) => e.status === "needs_review")).toHaveLength(8);
  });
});
