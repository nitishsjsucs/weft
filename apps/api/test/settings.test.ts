// Contract tests for /v1/settings (owner: t3-governance).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestWeft, type TestWeft } from "../src/testing";
import { fixtureWeft } from "../../../packages/executor/test/fixtures";

let weft: TestWeft;
beforeEach(async () => { weft = await fixtureWeft(await createTestWeft({ seed: false })); });
afterEach(async () => { await weft.close(); });
const put = (h: Record<string, string>, body: unknown) => weft.app.request("/v1/settings/agent-grants", { method: "PUT", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/v1/settings", () => {
  it("shows principals, agent grants and ceilings", async () => {
    const p = await (await weft.app.request("/v1/settings/permissions", { headers: weft.uiHeaders("usr_theo") })).json();
    expect(p.agentGrants).toMatchObject({ people: "edit", benefits: "view", company: "view" });
    expect(p.limits["agent.payroll_run_cents"]).toBe(150000000);
    expect(p.principals.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining(["usr_dana", "usr_theo", "usr_sam", "agt_weft", "svc_events"]));
  });
  it("only an admin changes agent grants, never to approve; the change is an action row", async () => {
    expect((await put(weft.uiHeaders("usr_theo"), { grants: { comms: "view" } })).status).toBe(403);
    expect((await put(weft.uiHeaders("usr_dana"), { grants: { comms: "approve" } })).status).toBe(400);
    const ok = await put(weft.uiHeaders("usr_dana"), { grants: { comms: "view" } });
    expect((await ok.json()).agentGrants.comms).toBe("view");
    const actions = await (await weft.app.request("/v1/actions", { headers: weft.uiHeaders("usr_dana") })).json();
    expect(actions.data[0]).toMatchObject({ command: "settings.set_agent_grants", actorId: "usr_dana" });
    expect((await weft.executor.verifyChain()).ok).toBe(true);
  });
});
