// Contract tests for /v1/events (owner: t3-governance): the activity feed with id-only payloads.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventRow } from "@weft/contracts";
import { createTestWeft, type TestWeft } from "../src/testing";
import { fixtureWeft } from "../../../packages/executor/test/fixtures";

let weft: TestWeft;
beforeEach(async () => { weft = await fixtureWeft(await createTestWeft({ seed: false })); });
afterEach(async () => { await weft.close(); });

describe("/v1/events", () => {
  it("pages events after a cursor with stamped attended and requestedBy", async () => {
    const h = await weft.executor.runs.openChatRun({ principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui", keyScope: null }, { threadId: null, surface: "human_ui" });
    await weft.executor.agent.exec(h, { callId: "1", command: "tax.update_rate", args: { rate_id: "etr_0001", rate: "0.015" } });
    const page = await (await weft.app.request("/v1/events?type=proposal.created", { headers: weft.uiHeaders("usr_dana") })).json();
    expect(page.count).toBe(1);
    const e = EventRow.parse(page.data[0]);
    expect(e).toMatchObject({ type: "proposal.created", attended: true, requestedBy: "usr_dana", payload: { proposal_id: "prp_0001" } });
    const after = await (await weft.app.request(`/v1/events?afterId=${e.id}`, { headers: weft.uiHeaders("usr_dana") })).json();
    expect(after.count).toBe(0);
  });
});
