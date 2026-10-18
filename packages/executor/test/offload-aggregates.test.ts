// Aggregates beside the rows (fix group read-figures): `totals` and `by_<key>` groupings are never taken for the rows
// of an offloaded result, and they stay inline next to the preview, so a large read still carries its sums.
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolOutcome } from "@weft/contracts";
import type { WeftCommand } from "@weft/core";
import { fixtureCommands, makeWorld, type World } from "./fixtures";
import { AGGREGATE_BUDGET, aggregatesOf, rowsOf } from "../src/workspace";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ expense_id: `exp_${String(i).padStart(4, "0")}`, amount_cents: 100 * (i + 1), pad: "x".repeat(300) }));
const byWorker = (n: number) => Array.from({ length: n }, (_, i) => ({ worker: `W${i} (wrk_${String(i).padStart(4, "0")})`, count: 1, amount_cents: 100 * (i + 1), amount_display: `$${i + 1}.00` }));
const totals = { count: 40, amount_cents: 82_000, amount_display: "$820.00" };
const big: WeftCommand = {
  ...fixtureCommands[0]!, name: "people.list_sums", summary: "List with sums", description: "List with sums. Example: {}", input: z.object({}),
  async run() { return { data: { count: 40, totals, by_worker: byWorker(30), expenses: rows(40), note: "one per call" }, summary: "40 expenses" }; },
};

let w: World;
afterEach(async () => { await w?.close(); });

describe("aggregates in an offloaded result", () => {
  it("rowsOf skips totals and by_ groupings, even when a grouping is as long as the rows", () => {
    expect(rowsOf({ totals, by_worker: byWorker(3), requests: rows(3) })).toHaveLength(3);
    expect((rowsOf({ by_worker: byWorker(3), requests: rows(3) })[0] as { expense_id: string }).expense_id).toBe("exp_0000");
    expect(rowsOf({ totals })).toEqual([{ totals }]);
  });

  it("aggregatesOf keeps the smallest aggregates first, within the inline budget", () => {
    const huge = byWorker(400);
    expect(JSON.stringify(huge).length).toBeGreaterThan(AGGREGATE_BUDGET);
    expect(aggregatesOf({ totals, by_category: byWorker(2), by_worker: huge, rows: rows(2), note: "x" })).toEqual({ totals, by_category: byWorker(2) });
    expect(aggregatesOf([1, 2])).toEqual({});
  });

  it("an offloaded read keeps its totals and groupings inline beside the preview", async () => {
    w = await makeWorld({ commands: [...fixtureCommands, big] });
    const h = await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" });
    const o: ToolOutcome = await w.executor.agent.exec(h, { callId: "1", command: "people.list_sums", args: {} });
    if (!(o.ok && o.status === "done")) throw new Error(JSON.stringify(o));
    expect(o.artifactRef).toMatch(/^art_/);
    const d = o.data as Record<string, unknown>;
    expect(d).toMatchObject({ count: 40, totals, total: 40, row_count: 40, note: "one per call" });
    expect(d.by_worker).toEqual(byWorker(30));
    expect((d.preview as unknown[]).length).toBe(10);
    expect((d.preview as { expense_id: string }[])[0]!.expense_id).toBe("exp_0000");
  });
});
