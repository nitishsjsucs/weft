// Contract tests for /v1/actions (owner: t3-governance): the audit log, verify and rollback.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunHandle } from "@weft/contracts";
import { Action } from "@weft/contracts";
import { createExecutor } from "@weft/executor";
import { SEED_TIME } from "@weft/core";
import { createTestWeft, type TestWeft } from "../src/testing";
import { fakeSims, fixtureCommands, seedFixtureRows } from "../../../packages/executor/test/fixtures";
import { seedGovernance } from "../../../packages/seed/src/governance";

let weft: TestWeft;
let h: RunHandle;
beforeEach(async () => {
  weft = await createTestWeft({ seed: false });
  weft.executor = await createExecutor({ db: weft.db, clock: weft.clock, dataDir: weft.dataDir, commands: fixtureCommands, simulators: fakeSims as never, testMode: true });
  await seedFixtureRows(weft.db);
  await seedGovernance({ db: weft.db, clock: weft.clock, executor: weft.executor, sims: weft.sims, dataDir: weft.dataDir, companyId: "cmp_larkspur", faker: null as never });
  await weft.clock.set(SEED_TIME, 0);
  h = await weft.executor.runs.openChatRun({ principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui", keyScope: null }, { threadId: null, surface: "human_ui" });
});
afterEach(async () => { await weft.close(); });

const post = (path: string, headers: Record<string, string>, body: unknown = {}) =>
  weft.app.request(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });

async function approvedRate(): Promise<number> {
  const o = await weft.executor.agent.exec(h, { callId: "c1", command: "tax.update_rate", args: { rate_id: "etr_0001", rate: "0.015" } });
  if (!(o.ok && o.status === "pending_approval")) throw new Error(JSON.stringify(o));
  const r = await post(`/v1/proposals/${o.proposalId}/approve`, weft.uiHeaders("usr_theo"));
  return (await r.json()).proposal.executedActionSeq as number;
}

describe("/v1/actions", () => {
  it("lists the log newest first and reads one action", async () => {
    const seq = await approvedRate();
    await weft.executor.agent.exec(h, { callId: "c2", command: "comms.send_message", args: { channel: "#payroll", text: "done" }, batch: 2 } as never);
    const res = await weft.app.request("/v1/actions", { headers: weft.uiHeaders("usr_dana") });
    const page = await res.json();
    expect(page.data.map((a: { seq: number }) => a.seq)).toEqual([2, 1]);
    for (const a of page.data) Action.parse(a);
    const one = await (await weft.app.request(`/v1/actions/${seq}`, { headers: weft.uiHeaders("usr_dana") })).json();
    expect(one).toMatchObject({ seq, command: "tax.update_rate", reversible: "yes", actorKind: "agent", actorId: "agt_weft", onBehalfOf: "usr_dana" });
    expect(page.data[0]).toMatchObject({ reversible: "no", notReversibleReason: "A sent message cannot be unsent." });
  });

  it("order=time lists by timestamp with the seq on each row and pages with beforeId", async () => {
    await approvedRate();
    // History written after a later action: seq 2 is dated before seq 1, as the rich profile's imported history is.
    await weft.clock.set("2025-12-19T17:00:00.000Z", 0);
    await weft.executor.agent.exec(h, { callId: "c2", command: "comms.send_message", args: { channel: "#payroll", text: "done" }, batch: 2 } as never);
    await weft.clock.set(new Date(Date.parse(SEED_TIME) + 3_600_000).toISOString(), 0);
    await weft.executor.agent.exec(h, { callId: "c3", command: "comms.send_message", args: { channel: "#payroll", text: "again" }, batch: 3 } as never);
    const get = async (q: string) => (await (await weft.app.request(`/v1/actions?${q}`, { headers: weft.uiHeaders("usr_dana") })).json()) as { data: { seq: number }[]; hasMore: boolean };
    expect((await get("order=time")).data.map((a) => a.seq)).toEqual([3, 1, 2]);
    const first = await get("order=time&limit=2");
    expect(first.data.map((a) => a.seq)).toEqual([3, 1]);
    expect(first.hasMore).toBe(true);
    expect((await get("order=time&limit=2&beforeId=1")).data.map((a) => a.seq)).toEqual([2]);
    expect((await get("")).data.map((a) => a.seq)).toEqual([3, 2, 1]);   // the default stays seq order
  });

  it("verify reports ok with no gaps and gitLag <= 1", async () => {
    await approvedRate();
    const v = await (await weft.app.request("/v1/actions/verify", { headers: weft.uiHeaders("usr_dana") })).json();
    expect(v).toMatchObject({ ok: true, gaps: [], badSeq: null, head: { seq: 1 } });
    expect(v.gitLag).toBeLessThanOrEqual(1);
  });

  it("rollback restores the rate with a reversing row; API keys get 403", async () => {
    const seq = await approvedRate();
    const { readFileSync } = await import("node:fs");
    const key = readFileSync(`${weft.dataDir}/demo-api-key.txt`, "utf8").trim();
    expect((await post(`/v1/actions/${seq}/rollback`, { "x-api-key": key }, { reason: "x" })).status).toBe(403);
    const res = await post(`/v1/actions/${seq}/rollback`, weft.uiHeaders("usr_dana"), { reason: "Applied to the wrong account" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "done", actionSeq: seq + 1 });
    const one = await (await weft.app.request(`/v1/actions/${seq}`, { headers: weft.uiHeaders("usr_dana") })).json();
    expect(one.reversedBySeq).toBe(seq + 1);
    const again = await post(`/v1/actions/${seq}/rollback`, weft.uiHeaders("usr_dana"), { reason: "again" });
    expect(again.status).toBe(422);
  });
});
