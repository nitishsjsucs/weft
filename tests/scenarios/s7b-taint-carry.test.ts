// Scenario s7b (SPEC 12, 13). Owner: t3-governance. S7b taint carries into later runs and memory.
// An injection notice taints run 1, which cannot write memory or draft a routine; a later cron digest run starts
// clean and its auto-allowed send carries nothing from the notice; a routine drafted in a tainted run starts tainted.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestWeft, type TestWeft } from "./helpers";
import { fixtureWeft } from "../../packages/executor/test/fixtures";

let weft: TestWeft;
beforeEach(async () => { weft = await fixtureWeft(await createTestWeft({ seed: false })); });
afterEach(async () => { await weft.close(); });

const insertRoutine = (id: string, taintedBy: string | null) => weft.db.run(`INSERT INTO routines (id, company_id, name, description, owner_principal_id, enabled, trigger_json, instructions, tools_json, budget_json, surface_json, source, tainted_by, created_at)
  VALUES ('${id}', 'cmp_larkspur', 'People digest (demo)', 'test', 'usr_dana', 1, '{"type":"cron","cron":"0 9 * * 1","tz":"America/Los_Angeles"}', '', '["comms.send_message"]', '{}', '{}', 'prebuilt', ${taintedBy ? `'${taintedBy}'` : "NULL"}, '2026-10-26T15:30:00.000Z')` as never);

describe("S7b taint carries into later runs and memory", () => {
  it("runs end to end: nothing derived from the notice is auto-sent and no memory note from the tainted run exists", async () => {
    await insertRoutine("rt_people_digest", null);
    const chat = await weft.executor.runs.openChatRun({ principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui", keyScope: null }, { threadId: null, surface: "human_ui" });
    const before = await weft.executor.memory.tree();
    await weft.executor.agent.exec(chat, { callId: "1", command: "notices__get", args: { notice_id: "ntc_0001", response_format: "detailed" }, batch: 1 } as never);
    expect(await weft.executor.agent.exec(chat, { callId: "2", command: "memory__write_note", args: { path: "knowledge/procedures/x.md", title: "x", body: "1. x", sources: ["ntc_0001"] }, batch: 2 } as never))
      .toMatchObject({ ok: false, refusal: { code: "TAINTED_WRITE" } });
    expect(await weft.executor.agent.exec(chat, { callId: "3", command: "routines__draft", args: { name: "Notice says", cron: "0 9 * * 5" }, batch: 3 } as never))
      .toMatchObject({ ok: false, refusal: { code: "TAINTED_WRITE" } });
    const sendTainted = await weft.executor.agent.exec(chat, { callId: "4", command: "comms__send_message", args: { channel: "#general", text: "as the notice asked" }, batch: 4 } as never);
    expect(sendTainted.ok && sendTainted.status).toBe("pending_approval");

    const digest = await weft.executor.runs.openRoutineRun({ routineId: "rt_people_digest", routineRunId: "rtr_0002", triggerRef: "cron:2026-11-02T17:00:00Z", attended: false });
    expect(await weft.executor.agent.runState(digest)).toMatchObject({ tainted: false });
    const post = await weft.executor.agent.exec(digest, { callId: "d1", command: "comms__send_message", args: { channel: "#people-ops", text: "Weekly digest: 48 employees, 1 pending offer." }, batch: 1 } as never);
    expect(post.ok && post.status === "done" && post.tainted).toBe(false);
    const sent = await weft.db.all<{ text: string }>(`SELECT text FROM sim_chat_messages` as never);
    expect(sent.map((s) => s.text)).toEqual(["Weekly digest: 48 employees, 1 pending offer."]);
    const after = await weft.executor.memory.tree("knowledge/");
    expect(after.filter((p) => !before.includes(p))).toEqual([]);
  });

  it("a routine drafted in a tainted run starts every run tainted", async () => {
    await insertRoutine("rt_custom", "notice:ntc_0001");
    const h = await weft.executor.runs.openRoutineRun({ routineId: "rt_custom", routineRunId: "rtr_0003", triggerRef: "cron:x", attended: false });
    expect(await weft.executor.agent.runState(h)).toMatchObject({ tainted: true, taintedBy: "routine:rt_custom" });
    const send = await weft.executor.agent.exec(h, { callId: "1", command: "comms__send_message", args: { channel: "#general", text: "hello" } });
    expect(send.ok && send.status).toBe("pending_approval");
  });

  it("verifies the action chain and the memory SHA", async () => {
    expect((await weft.executor.verifyChain()).ok).toBe(true);
    expect(await weft.executor.memory.head()).toMatch(/^[0-9a-f]{40}$/);
  });
});
