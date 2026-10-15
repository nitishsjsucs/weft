// Contract tests for /v1/proposals (owner: t3-governance). The executor runs the fixture commands of
// packages/executor/test/fixtures.ts until the real T1 and T2 commands land.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunHandle } from "@weft/contracts";
import { createExecutor } from "@weft/executor";
import { SEED_TIME } from "@weft/core";
import { createTestWeft, type TestWeft } from "../src/testing";
import { fakeSims, fixtureCommands, seedFixtureRows } from "../../../packages/executor/test/fixtures";
import { seedGovernance } from "../../../packages/seed/src/governance";

let weft: TestWeft;
let h: RunHandle;
async function world(): Promise<TestWeft> {
  const w = await createTestWeft({ seed: false });
  w.executor = await createExecutor({ db: w.db, clock: w.clock, dataDir: w.dataDir, commands: fixtureCommands, simulators: fakeSims as never, testMode: true });
  await seedFixtureRows(w.db);
  await seedGovernance({ db: w.db, clock: w.clock, executor: w.executor, sims: w.sims, dataDir: w.dataDir, companyId: "cmp_larkspur", faker: null as never });
  await w.clock.set(SEED_TIME, 0);
  return w;
}
beforeEach(async () => {
  weft = await world();
  h = await weft.executor.runs.openChatRun({ principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui", keyScope: null }, { threadId: null, surface: "human_ui" });
});
afterEach(async () => { await weft.close(); });

async function propose(): Promise<string> {
  const o = await weft.executor.agent.exec(h, { callId: "c1", command: "tax__update_rate", args: { rate_id: "etr_0001", rate: "0.015" } });
  if (!(o.ok && o.status === "pending_approval")) throw new Error(JSON.stringify(o));
  return o.proposalId;
}
const post = (path: string, headers: Record<string, string>, body: unknown = {}) =>
  weft.app.request(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/v1/proposals", () => {
  it("lists and reads proposals with the canonical headline and diff", async () => {
    const id = await propose();
    const list = await weft.app.request("/v1/proposals?status=pending", { headers: weft.uiHeaders("usr_theo") });
    expect(list.status).toBe(200);
    const page = await list.json();
    expect(page).toMatchObject({ hasMore: false, count: 1 });
    expect(page.data[0]).toMatchObject({ id, kind: "action", command: "tax.update_rate", risk: "R2", headline: "Update CA SUI rate from 0.034 to 0.015 (etr_0001)", status: "pending" });
    const one = await weft.app.request(`/v1/proposals/${id}`, { headers: weft.uiHeaders("usr_theo") });
    expect((await one.json()).diff).toEqual([{ label: "rate", before: "0.034", after: "0.015" }]);
    expect((await weft.app.request("/v1/proposals/prp_9999", { headers: weft.uiHeaders("usr_theo") })).status).toBe(404);
  });

  it("approve executes once; a second approve is refused NOT_PENDING", async () => {
    const id = await propose();
    const res = await post(`/v1/proposals/${id}/approve`, weft.uiHeaders("usr_theo"), { reasonCode: "matches_notice", note: "Checked the DE 2088." });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, proposal: { status: "executed", executedActionSeq: 1, decidedBy: "usr_theo" } });
    const again = await post(`/v1/proposals/${id}/approve`, weft.uiHeaders("usr_theo"));
    expect(again.status).toBe(422);
    expect(await again.json()).toMatchObject({ _tag: "Refused", code: "NOT_PENDING" });
  });

  it("deny, and WRONG_ROLE for a principal without approve", async () => {
    const id = await propose();
    expect(await (await post(`/v1/proposals/${id}/approve`, weft.uiHeaders("usr_sam"))).json()).toMatchObject({ code: "WRONG_ROLE" });
    const d = await post(`/v1/proposals/${id}/deny`, weft.uiHeaders("usr_dana"), { reasonCode: "wrong_rate" });
    expect(await d.json()).toMatchObject({ ok: true, proposal: { status: "denied", decisionCode: "wrong_rate" } });
  });

  it("API keys never decide: the admin key and the mcp key get 403", async () => {
    const id = await propose();
    const { readFileSync } = await import("node:fs");
    for (const f of ["demo-api-key.txt", "demo-mcp-key.txt"]) {
      const key = readFileSync(`${weft.dataDir}/${f}`, "utf8").trim();
      const res = await post(`/v1/proposals/${id}/approve`, { "x-api-key": key });
      expect(res.status, f).toBe(403);
    }
    const forged = await post(`/v1/proposals/${id}/approve`, { "x-weft-principal": "usr_dana", "x-weft-proxy": "nope".repeat(16) });
    expect(forged.status).toBe(401);
    const agent = await post(`/v1/proposals/${id}/approve`, weft.uiHeaders("agt_weft"));
    expect(agent.status).toBe(401);
  });
});
