// Scenario GP12 (docs/wave2.md, harness 18). Owner: w2-memory. After the seeded week, rt_memory_digest rolls
// timeline/raw into hourly, daily and weekly summaries with back-references, refreshes the dossier of a person
// mentioned in new events and the company one-pager, and commits as the agent. A chat run about that person starts
// with a recall block within RECALL_BUDGET that includes the one-pager and the dossier path, logged in
// memory_recalls; running the digest twice for the same period changes nothing. Scripted provider only.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { RECALL_BUDGET, type RoutineDef, type RoutineRun, type WeftEvent } from "@weft/contracts";
import { dossiers, memoryRecalls, runSteps, runTaint } from "@weft/db";
type WeftRoutinesEngine = { fire(r: RoutineDef, i: { triggerRef: string; payload: Record<string, unknown>; attended: boolean; event: WeftEvent | null; at?: string }): Promise<RoutineRun> };
import { memoryBinding } from "../../apps/api/src/memory/binding";
import { createTestWeft, type TestWeft } from "./helpers";

let weft: TestWeft;
let root: string;
const routine = () => (globalThis as unknown as Record<symbol, { routine: RoutineDef }>)[Symbol.for("weft.w2-memory.registry")]!.routine;
const gitIn = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
const approxTokens = (s: string) => Math.ceil(s.length / 4);

beforeAll(async () => {
  weft = await createTestWeft();
  root = join(weft.dataDir, "companies", "cmp_larkspur", "memory");
});
afterAll(async () => { await weft?.close(); });

async function chat(text: string) {
  const res = await weft.app.request("/v1/agent/runs", { method: "POST", headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: JSON.stringify({ text }) });
  expect(res.status).toBe(202);
  const { runId } = (await res.json()) as { runId: string };
  await (weft.agent as unknown as { settled(id: string): Promise<unknown> }).settled(runId);
  const steps = await weft.db.select().from(runSteps).where(eq(runSteps.runId, runId));
  const ctx = steps.find((s) => s.kind === "context");
  return { runId, text: String((JSON.parse(String(ctx?.resultJson ?? "{}")) as { text?: string }).text ?? "") };
}

describe("GP12 memory recall and coarsening (w2-memory)", () => {
  it("recall stays empty before the first digest (wave 1 packs unchanged)", async () => {
    const { runId, text } = await chat("What changed for Lena Brooks?");
    expect(text).not.toContain("<recall");
    expect(await weft.db.select().from(memoryRecalls).where(eq(memoryRecalls.runId, runId))).toHaveLength(0);
  });

  it("the digest coarsens the seeded week, refreshes the dossier and one-pager, and commits as the agent", async () => {
    const eng = weft.routines as unknown as WeftRoutinesEngine;
    const slot = "cron:2026-10-26T15:05:00.000Z";
    const run = await eng.fire(routine(), { triggerRef: slot, payload: { slot }, attended: false, event: null, at: weft.clock.now() });
    expect(run.status).toBe("skipped");
    expect(run.summary).toMatch(/^Memory digest committed [0-9a-f]{12}/);
    const log = gitIn("log", "-1", "--format=%an <%ae>|%cn|%s%n%b");
    expect(log).toContain("Weft Agent <agent@weft.example>|Weft Agent|memory digest: daily 2026-10-09, weekly 2026-W41");
    expect(log).toMatch(/Weft-Digest: daily:2026-10-09,hourly:2026-10-09T17,weekly:2026-W41/);
    const daily = readFileSync(join(root, "timeline/daily/2026-10-09.md"), "utf8");
    expect(daily).toContain("- people.set_pay_rate: 1 (timeline/raw/2026-10-09.md#L12)");
    expect(daily).toMatch(/\[i2\] people\.set_pay_rate: .*\(ref: timeline\/raw\/2026-10-09\.md#L12\)/);
    expect(existsSync(join(root, "timeline/hourly/2026-10-09T17.md"))).toBe(true);
    expect(readFileSync(join(root, "timeline/weekly/2026-W41.md"), "utf8")).toContain("- timeline/daily/2026-10-09.md");
    // The raw day is past the window: gone from the tree, still in history at the commit the summary names.
    expect(existsSync(join(root, "timeline/raw/2026-10-09.md"))).toBe(false);
    const at = /resolve at commit ([0-9a-f]{40})/.exec(daily)![1]!;
    expect(gitIn("show", `${at}:timeline/raw/2026-10-09.md`).split("\n")[11]).toContain("people.set_pay_rate");
    // Dossier of the person in the new events, with dated, sourced facts and backlinks; the one-pager exists.
    const person = readFileSync(join(root, "entities/people/wrk_0026.md"), "utf8");
    expect(person).toMatch(/- Work state \[\[entities\/states\/[A-Z]{2}\]\] \(\d{4}-\d{2}-\d{2}, src: worker:wrk_0026\)/);
    expect(person).toContain("## Backlinks");
    expect(person).toContain("- [[timeline/daily/2026-10-09]]");
    const pager = readFileSync(join(root, RECALL_BUDGET.onePager), "utf8");
    expect(pager).toContain("## Headcount by state");
    expect(pager).toContain("## Agent autonomy");
    // People read these files: times are in company time like the payroll page, never raw UTC ISO.
    expect(pager).toContain("approve by Wed, Oct 28, 5:00 PM PT");
    for (const text of [pager, daily, person]) expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(daily).toContain("Period Thu, Oct 8, 5:00 PM PT to Fri, Oct 9, 5:00 PM PT.");
    const rows = await weft.db.select().from(dossiers);
    expect(rows.map((r) => r.subjectRef)).toEqual(expect.arrayContaining(["wrk_0026", "cmp_larkspur"]));
  });

  it("running the digest again for the same period changes nothing", async () => {
    const head = gitIn("rev-parse", "HEAD").trim();
    const eng = weft.routines as unknown as WeftRoutinesEngine;
    const again = await eng.fire(routine(), { triggerRef: "cron:2026-10-26T15:05:00.000Z", payload: {}, attended: false, event: null });
    expect(again.summary).toMatch(/^Memory digest committed/);   // same run key: the engine returns the first run
    const direct = await memoryBinding(weft.db)!.digest({ companyId: "cmp_larkspur", now: weft.clock.now() });
    expect(direct.commit).toBeNull();
    expect(gitIn("rev-parse", "HEAD").trim()).toBe(head);
  });

  it("a chat about that person starts with a recall block within budget, logged in memory_recalls", async () => {
    const { runId, text } = await chat("What changed for Lena Brooks this month?");
    const block = /<recall[\s\S]*?<\/recall>/.exec(text)?.[0] ?? "";
    expect(block).toContain(RECALL_BUDGET.onePager);
    expect(block).toContain("entities/people/wrk_0026.md");
    expect(approxTokens(block)).toBeLessThanOrEqual(RECALL_BUDGET.maxTokens);
    expect(text.indexOf("<recall")).toBeGreaterThan(text.indexOf("</request>"));
    const [row] = await weft.db.select().from(memoryRecalls).where(eq(memoryRecalls.runId, runId));
    expect(JSON.parse(String(row!.pathsJson))).toEqual(expect.arrayContaining([RECALL_BUDGET.onePager, "entities/people/wrk_0026.md"]));
    const [taint] = await weft.db.select().from(runTaint).where(eq(runTaint.runId, runId));
    expect(taint?.tainted ?? false).toBe(false);
  });
});
