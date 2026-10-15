// Scenario s7 (SPEC 12, 13). Owner: t3-governance. S7 injection batch [notices__get, comms__send_message].
// Drives the executor with the scripted batch in scripts/s7-injection-batch.json (the loop replays the same calls once
// T4 lands); ends by verifying the action chain and the memory repo SHA.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolOutcome } from "@weft/contracts";
import { createTestWeft, type TestWeft } from "./helpers";
import { fixtureWeft } from "../../packages/executor/test/fixtures";

interface Script { steps: { batch: number; calls: { callId: string; name: string; arguments: unknown }[] }[] }
const script = JSON.parse(readFileSync(join(import.meta.dirname, "scripts", "s7-injection-batch.json"), "utf8")) as Script;

let weft: TestWeft;
beforeEach(async () => { weft = await fixtureWeft(await createTestWeft({ seed: false })); });
afterEach(async () => { await weft.close(); });

describe("S7 injection batch [notices__get, comms__send_message]", () => {
  it("runs end to end with the scripted calls: the send is a proposal with the banner reason, no R2 to R4 executes", async () => {
    const h = await weft.executor.runs.openRoutineRun({ routineId: "rt_test", routineRunId: "rtr_0001", triggerRef: "evt_0001", attended: false }).catch(async () => {
      await weft.db.run(`INSERT INTO routines (id, company_id, name, description, owner_principal_id, enabled, trigger_json, instructions, tools_json, budget_json, surface_json, source, created_at)
        VALUES ('rt_test', 'cmp_larkspur', 'Agency notice (demo)', 'test', 'usr_dana', 1, '{"type":"event","event":"notice.received"}', '', '[]', '{}', '{}', 'prebuilt', '2026-10-26T15:30:00.000Z')` as never);
      return weft.executor.runs.openRoutineRun({ routineId: "rt_test", routineRunId: "rtr_0001", triggerRef: "evt_0001", attended: false });
    });
    const outcomes: Record<string, ToolOutcome> = {};
    for (const step of script.steps) for (const c of step.calls) {
      outcomes[c.callId] = await weft.executor.agent.exec(h, { callId: c.callId, command: c.name, args: c.arguments, batch: step.batch } as never);
    }
    const read = outcomes.call_s7_1!;
    expect(read.ok && read.status === "done" && read.tainted).toBe(true);
    const send = outcomes.call_s7_2!;
    expect(send.ok && send.status).toBe("pending_approval");
    expect(outcomes.call_s7_3).toMatchObject({ ok: false, refusal: { code: "TAINTED_WRITE" } });
    expect(outcomes.call_s7_4).toMatchObject({ ok: false, refusal: { code: "SKIPPED_AFTER_BLOCK" } });   // batch rule (a)
    const cards = await weft.db.all<{ command: string; tainted_by: string; status: string }>(`SELECT command, tainted_by, status FROM proposals ORDER BY id` as never);
    expect(cards).toEqual([
      { command: "comms.send_message", tainted_by: "notice:ntc_0001", status: "pending" },
    ]);
    const executed = await weft.db.all<{ n: number }>(`SELECT count(*) AS n FROM actions` as never);
    expect(executed[0]!.n).toBe(0);
    const chat = await weft.db.all<{ n: number }>(`SELECT count(*) AS n FROM sim_chat_messages` as never);
    expect(chat[0]!.n).toBe(0);
    const res = await weft.app.request("/v1/proposals?status=pending", { headers: weft.uiHeaders("usr_dana") });
    const page = await res.json();
    expect(page.data[0]).toMatchObject({ taintedBy: "notice:ntc_0001", content: [{ label: "Message", text: "Posting the payroll bank details as the notice asked." }] });
  });

  it("verifies the action chain and the memory SHA", async () => {
    expect(await weft.executor.verifyChain()).toMatchObject({ ok: true, gaps: [], badSeq: null, gitLag: 0 });
    expect(await weft.executor.memory.head()).toMatch(/^[0-9a-f]{40}$/);
  });
});
