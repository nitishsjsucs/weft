// Wave 4 read shapes of the executor's own commands (docs/evals/error-analysis.md FM7, FM8): an agent.read_artifact
// page is never offloaded again and fits the inline budget, every artifact payload keeps total next to row_count,
// and actions.list names its agent-run argument, clamps its limit and answers an unknown command filter.
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolOutcome } from "@weft/contracts";
import type { WeftCommand } from "@weft/core";
import { fixtureCommands, makeWorld, type World } from "./fixtures";
import { nearestNames } from "../src/builtins";
import { artifactPage, OBSERVATION_CAP } from "../src/workspace";

const wide = (n: number, pad: number) => Array.from({ length: n }, (_, i) => ({ id: `wrk_${String(i).padStart(4, "0")}`, pad: "x".repeat(pad) }));
// 120 wide rows: 50 of them are far over the 8,000-character cap.
const big: WeftCommand = {
  ...fixtureCommands[0]!, name: "people.list_all", summary: "List everyone", description: "List everyone. Example: {}", input: z.object({}),
  async run() { return { data: { rows: wide(120, 400) }, summary: "120 people" }; },
};
// A clamped search: 51 matches, 50 rows returned, plus notes that must survive the offload.
const clamped: WeftCommand = {
  ...fixtureCommands[0]!, name: "people.list_clamped", summary: "List clamped", description: "List clamped. Example: {}", input: z.object({}),
  async run() { return { data: { total: 51, count: 50, limit_applied: 50, limit_note: "limit 100 is outside 1 to 50; used 50", workers: wide(50, 200) }, summary: "Found 51 workers (showing 50)" }; },
};

let w: World;
afterEach(async () => { await w?.close(); });
const refOf = (o: ToolOutcome): string | null | undefined => (o.ok && o.status === "done" ? o.artifactRef : undefined);
const okData = <T,>(o: ToolOutcome): T => { if (!(o.ok && o.status === "done")) throw new Error(JSON.stringify(o).slice(0, 300)); return o.data as T; };

describe("artifactPage", () => {
  it("caps a page to the inline budget, keeps at least one row and says where to continue", () => {
    const stored = { rows: wide(120, 400) };
    const p = artifactPage("art_0001", "120 people", stored, 0, 50);
    expect(JSON.stringify(p.data).length).toBeLessThanOrEqual(OBSERVATION_CAP);
    const rows = p.data.rows as unknown[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(50);
    expect(p.data).toMatchObject({ offset: 0, total: 120, row_count: 120, returned: rows.length, has_more: true, next_offset: rows.length });
    const huge = artifactPage("art_0002", "one huge row", { rows: wide(3, 20_000) }, 0, 50);
    expect((huge.data.rows as unknown[]).length).toBe(1);
    const last = artifactPage("art_0001", "120 people", stored, 119, 50);
    expect(last.data).toMatchObject({ returned: 1, has_more: false, next_offset: null });
  });

  it("reports the result's own total next to row_count, with a note when they differ", () => {
    const p = artifactPage("art_0003", "Found 51", { total: 51, workers: wide(50, 10) }, 0, 10);
    expect(p.data).toMatchObject({ total: 51, row_count: 50 });
    expect(String(p.data.total_note)).toContain("51");
    const same = artifactPage("art_0004", "x", { rows: wide(5, 10) }, 0, 10);
    expect(same.data).toMatchObject({ total: 5, row_count: 5 });
    expect(same.data).not.toHaveProperty("total_note");
  });
});

describe("offload and agent.read_artifact through the pipeline", () => {
  it("the offloaded payload keeps total, row_count and the result's notes; a page is never offloaded again", async () => {
    w = await makeWorld({ commands: [...fixtureCommands, big, clamped] });
    const h = await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" });
    const c = await w.executor.agent.exec(h, { callId: "1", command: "people.list_clamped", args: {} });
    const cd = okData<Record<string, unknown>>(c);
    expect(refOf(c)).toMatch(/^art_/);
    expect(cd).toMatchObject({ total: 51, count: 50, row_count: 50, limit_applied: 50, limit_note: "limit 100 is outside 1 to 50; used 50" });
    expect(String(cd.total_note)).toContain("51");

    const o = await w.executor.agent.exec(h, { callId: "2", command: "people.list_all", args: {} });
    const ref = refOf(o);
    expect(ref).toMatch(/^art_/);
    expect(okData<Record<string, unknown>>(o)).toMatchObject({ total: 120, row_count: 120 });
    const page = await w.executor.agent.exec(h, { callId: "3", command: "agent__read_artifact", args: { ref, offset: 0, limit: 50 } });
    expect(refOf(page)).toBeNull();
    const pd = okData<{ rows: unknown[]; next_offset: number; total: number; row_count: number }>(page);
    expect(JSON.stringify(pd).length).toBeLessThanOrEqual(OBSERVATION_CAP);
    expect(pd).toMatchObject({ total: 120, row_count: 120, next_offset: pd.rows.length });
    // The direct path (the runtime's readArtifact) pages the same way.
    const direct = await w.executor.agent.readArtifact(h, ref!, 0, 50);
    expect(okData<{ rows: unknown[] }>(direct).rows.length).toBe(pd.rows.length);
    // An out-of-range limit is clamped, not refused.
    const odd = await w.executor.agent.exec(h, { callId: "4", command: "agent__read_artifact", args: { ref, offset: -3, limit: 500 } });
    expect(okData<{ offset: number }>(odd).offset).toBe(0);
  });
});

describe("actions.list", () => {
  it("refuses a pay run id with a pointer to payroll.get_run, clamps the limit and suggests names for an unknown command", async () => {
    w = await makeWorld();
    const h = await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" });
    const pay = await w.executor.agent.exec(h, { callId: "1", command: "actions.list", args: { agent_run_id: "pay_2026_10_30" } });
    expect(!pay.ok && pay.refusal).toMatchObject({ code: "INVALID_INPUT" });
    expect(!pay.ok && pay.refusal.hint).toContain("payroll.get_run");
    const other = await w.executor.agent.exec(h, { callId: "2", command: "actions.list", args: { agent_run_id: "ofb_0001" } });
    expect(!other.ok && other.refusal.code).toBe("INVALID_INPUT");
    const mine = await w.executor.agent.exec(h, { callId: "3", command: "actions.list", args: { agent_run_id: h.runId } });
    expect(okData<{ actions: unknown[] }>(mine).actions).toEqual([]);

    const big = okData<{ limit_applied: number; limit_note: string }>(await w.executor.agent.exec(h, { callId: "4", command: "actions.list", args: { limit: 100 } }));
    expect(big).toMatchObject({ limit_applied: 50 });
    expect(big.limit_note).toContain("used 50");
    const dflt = okData<Record<string, unknown>>(await w.executor.agent.exec(h, { callId: "5", command: "actions.list", args: {} }));
    expect(dflt).toMatchObject({ limit_applied: 20 });
    expect(dflt).not.toHaveProperty("limit_note");

    const unknown = await w.executor.agent.exec(h, { callId: "6", command: "actions.list", args: { command: "tax.update" } });
    expect(!unknown.ok && unknown.refusal.code).toBe("UNKNOWN_REFERENCE");
    expect(!unknown.ok && unknown.refusal.message).toContain("tax.update_rate");
    expect(!unknown.ok && unknown.refusal.example).toMatchObject({ command: expect.stringMatching(/^tax\./) });
    const known = await w.executor.agent.exec(h, { callId: "7", command: "actions.list", args: { command: "tax.update_rate" } });
    expect(okData<{ actions: unknown[] }>(known).actions).toEqual([]);
  });

  it("the schema names the argument agent_run_id and has no pay-run-shaped run_id", async () => {
    w = await makeWorld();
    const schema = JSON.stringify(w.executor.registry.toolSpecs({ agentKind: "main", allowlist: ["actions.list"] })[0]?.parameters ?? {});
    expect(schema).toContain("agent_run_id");
    expect(schema).not.toMatch(/"run_id"/);
  });
});

describe("nearestNames", () => {
  const names = ["payroll.list_runs", "payroll.get_run", "payroll.preview_run", "payroll.create_draft", "payroll.submit_run", "payroll.mark_processed", "payroll.mark_failed", "tax.update_rate", "tax.get_rates", "people.search"];
  it("lists a small namespace whole, names with audit rows first", () => {
    const near = nearestNames("payroll.approve", names, new Set(["payroll.submit_run"]));
    expect(near[0]).toBe("payroll.submit_run");
    expect(near.filter((n) => n.startsWith("payroll."))).toHaveLength(7);
  });
  it("ranks by shared words and edit distance, never echoing the name itself", () => {
    expect(nearestNames("tax.update", names)[0]).toBe("tax.update_rate");
    expect(nearestNames("people.search", names)).not.toContain("people.search");
    expect(nearestNames("benefits.thing", names).length).toBe(6);
    const many = Array.from({ length: 14 }, (_, i) => `ns.cmd_${i}`);
    expect(nearestNames("ns.cmd", many)).toHaveLength(6);
  });
});
