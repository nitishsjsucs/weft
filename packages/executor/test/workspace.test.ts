import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ApprovalCard, Simulators, ToolOutcome } from "@weft/contracts";
import type { WeftCommand } from "@weft/core";
import { closeDb } from "@weft/db";
import { fixtureCommands, makeWorld, type World } from "./fixtures";
import { createExecutor, toCsv } from "../src/index";

const big: WeftCommand = {
  ...fixtureCommands[0]!, name: "people.list_all", summary: "List everyone", description: "List everyone. Example: {}", input: z.object({}),
  untrustedFields: ["rows.note"],
  async run() { return { data: { rows: Array.from({ length: 120 }, (_, i) => ({ id: `wrk_${String(i).padStart(4, "0")}`, note: i === 3 ? "employee-entered text" : "", pad: "x".repeat(80) })) }, summary: "120 people" }; },
};

let w: World;
afterEach(async () => { await w.close(); });

describe("run workspace", () => {
  it("offloads results over 8,000 characters and pages them within the run family only", async () => {
    w = await makeWorld({ commands: [...fixtureCommands, big] });
    const h = await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" });
    const o = await w.executor.agent.exec(h, { callId: "1", command: "people.list_all", args: {} });
    if (!(o.ok && o.status === "done")) throw new Error(JSON.stringify(o));
    expect(o.artifactRef).toMatch(/^art_\d{4}$/);
    expect(o.data).toMatchObject({ row_count: 120, artifact_ref: o.artifactRef });
    expect((o.data as { preview: unknown[] }).preview).toHaveLength(10);
    const page: ToolOutcome = await w.executor.agent.readArtifact(h, o.artifactRef!, 100, 50);
    expect(page.ok && page.status === "done" && (page.data as { rows: unknown[] }).rows).toHaveLength(20);
    const viaTool = await w.executor.agent.exec(h, { callId: "2", command: "agent__read_artifact", args: { ref: o.artifactRef, offset: 0, limit: 5 } });
    expect(viaTool.ok && viaTool.status === "done" && (viaTool.data as { rows: unknown[] }).rows).toHaveLength(5);
    const other = await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" });
    const denied = await w.executor.agent.readArtifact(other, o.artifactRef!, 0, 5);
    expect(!denied.ok && denied.refusal.code).toBe("UNKNOWN_REFERENCE");
  });

  it("CSV cells that could be formulas get a leading quote", () => {
    expect(toCsv([{ a: "=SUM(A1)", b: "+1", c: "-2", d: "@x", e: "plain, text" }], ["a", "b", "c", "d", "e"])).toBe("a,b,c,d,e\n'=SUM(A1),'+1,'-2,'@x,\"plain, text\"\n");
  });

  it("the proposal notifier posts one approval card per proposal", async () => {
    w = await makeWorld();
    const posts: { channel: string; card?: ApprovalCard }[] = [];
    const sims = () => ({ chat: { post: async (m: { channel: string; card?: ApprovalCard }) => { posts.push(m); return { id: "simm_1" }; }, list: async () => [] } }) as unknown as Simulators;
    const ex = await createExecutor({ db: w.db, clock: { now: () => "2026-10-26T15:30:00.000Z", rate: () => 0, advance: async () => {}, set: async () => {} }, dataDir: w.dir, commands: fixtureCommands, simulators: sims, testMode: true });
    const h = await ex.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" });
    const o = await ex.agent.exec(h, { callId: "1", command: "tax.update_rate", args: { rate_id: "etr_0001", rate: "0.015" } });
    expect(o.ok && o.status).toBe("pending_approval");
    expect(posts).toEqual([{ channel: "#payroll", author: "Weft agent", text: "Approval needed: Update CA SUI rate from 0.034 to 0.015 (etr_0001)",
      // Wave 3 (ApprovalCardW3): the extra fields come from the stored preview and DB names, never from model text.
      card: { proposalId: "prp_0001", headline: "Update CA SUI rate from 0.034 to 0.015 (etr_0001)", risk: "R2", moneyCents: null,
        routineName: null, subjectName: null, approverName: "Vic Akisole", fields: [{ label: "rate", value: "0.034 to 0.015" }], status: "pending" } }]);
    void closeDb;
  });
});

describe("artifact rows (wave 2 integrator fix)", () => {
  it("pages the longest array field, so payroll.get_run's empty excluded_worker_ids no longer reads as 0 rows", async () => {
    const { rowsOf } = await import("../src/workspace");
    // The payroll.get_run shape: excluded_worker_ids (often empty) comes before the flagged paychecks.
    expect(rowsOf({ run_id: "pay_2026_10_30", excluded_worker_ids: [], flagged: [{ id: "pyc_1" }, { id: "pyc_2" }], run_flags: [] })).toEqual([{ id: "pyc_1" }, { id: "pyc_2" }]);
    expect(rowsOf([1, 2, 3])).toEqual([1, 2, 3]);
    expect(rowsOf({ a: [1], b: [2] })).toEqual([1]);   // ties keep the first
    expect(rowsOf({ only: "value" })).toEqual([{ only: "value" }]);
  });
});
