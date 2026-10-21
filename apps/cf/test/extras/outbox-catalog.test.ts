// Two small Durable Object side mappings against a seeded world: which committed commands become after-commit jobs
// (design 3.4), and the run catalog row of a hosted run (design 5.2: outcome numbers only).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestWeft, type TestWeft } from "@weft/api";
import { agentRuns, runSteps } from "@weft/db";
import { parseJob } from "@weft/cf-extras";
import { extrasOutboxJobs, OUTBOX_COMMANDS } from "../../src/extras/slot/outbox";
import { catalogRowFor, runNeurons } from "../../src/extras/slot/catalog";

let w: TestWeft;
beforeAll(async () => { w = await createTestWeft(); });
afterAll(async () => { await w?.close(); });
let n = 0;
const opts = (semanticRecall = false) => ({ world: { slot: "slot-2", gen: 7 }, newJobId: () => `obx_${++n}`, semanticRecall });

describe("outbox mapping", () => {
  it("only a newly attached receipt, a fresh notice upload or a note written with recall on becomes a job", async () => {
    const tx = w.db as never;
    expect(await extrasOutboxJobs(tx, { command: "expenses.submit", input: { worker_id: "wrk_0025" }, data: { expense_id: "exp_0001" } }, opts())).toEqual([]);
    expect(await extrasOutboxJobs(tx, { command: "expenses.resubmit", input: { expense_id: "exp_0001" }, data: { expense_id: "exp_0001" } }, opts())).toEqual([]);
    expect(await extrasOutboxJobs(tx, { command: "notices.upload", input: {}, data: { notice_id: "ntc_0001", upload_id: "upl_0001", duplicate: true } }, opts())).toEqual([]);
    expect(await extrasOutboxJobs(tx, { command: "notices.upload", input: {}, data: { notice_id: "ntc_0001", upload_id: "upl_none" } }, opts())).toEqual([]);
    expect(await extrasOutboxJobs(tx, { command: "payroll.submit_run", input: {}, data: {} }, opts(true))).toEqual([]);
    const write = { command: "memory.write_note", input: {}, data: { path: "knowledge/procedures/payday.md", commit: "a".repeat(40) } };
    expect(await extrasOutboxJobs(tx, write, opts(false))).toEqual([]);
    const [job] = await extrasOutboxJobs(tx, write, opts(true));
    expect(job).toMatchObject({ v: 1, kind: "embed.memory", slot: "slot-2", gen: 7, namespace: "slot-2", notes: [{ path: "knowledge/procedures/payday.md", commit: "a".repeat(40), tainted: false, kind: "procedure" }] });
    expect(parseJob(job).ok).toBe(true);
    const [decision] = await extrasOutboxJobs(tx, { ...write, data: { path: "knowledge/decisions/x.md", commit: "b".repeat(40) } }, opts(true));
    expect(decision).toMatchObject({ notes: [{ tainted: true, kind: "decision" }] });
    expect([...OUTBOX_COMMANDS].sort()).toEqual(["expenses.resubmit", "expenses.submit", "memory.write_note", "notices.upload"]);
  });
});

describe("run catalog source", () => {
  const insertRun = async (id: string, o: Partial<typeof agentRuns.$inferInsert> = {}, terminal: Record<string, unknown> | null = { status: "done", reason: "DONE", ms: 4321.6 }) => {
    await w.db.insert(agentRuns).values({
      id, companyId: "cmp_larkspur", kind: "chat", trigger: "chat", attended: true, provider: "openai", model: "gpt-5.6-luna", effort: "low", cacheKey: "k",
      status: "done", terminalReason: "DONE", budgetJson: "{}", stepsUsed: 4, costUsdMicros: 3100, tokensJson: JSON.stringify({ input: 12_000, cached: 0, cacheWrite: 0, output: 300, reasoning: 0 }),
      createdAt: "2026-10-26T15:30:00.000Z", endedAt: "2026-10-26T15:30:00.000Z", summary: "secret summary text", ...o,
    });
    if (terminal) await w.db.insert(runSteps).values({ runId: id, n: 9, stage: "terminal", kind: "verify", outcome: "ok", resultJson: JSON.stringify(terminal), createdAt: "2026-10-26T15:30:00.000Z" });
  };

  it("maps a finished run to outcome numbers only", async () => {
    await insertRun("run_cat1");
    const row = await catalogRowFor(w.db, "run_cat1", { slot: "slot-1", gen: 3 }, new Date("2026-10-26T16:00:00Z"));
    expect(row).toEqual({ runId: "run_cat1", slot: "slot-1", gen: 3, provider: "openai", model: "gpt-5.6-luna", trigger: "chat", steps: 4, grounded: true, costUsdMicros: 3100, neurons: 0, latencyMs: 4322, status: "done", terminalReason: "DONE", endedAt: "2026-10-26T16:00:00.000Z" });
    expect(JSON.stringify(row)).not.toContain("secret summary");
  });

  it("marks a grounded-receipt fallback ungrounded, a routine ungraded, prices Workers AI in neurons, and skips running runs", async () => {
    await insertRun("run_cat2", {}, { status: "done", reason: "DONE", ms: 100, groundingFallback: true });
    expect((await catalogRowFor(w.db, "run_cat2", { slot: "slot-1", gen: 3 }))!.grounded).toBe(false);
    await insertRun("run_cat3", { kind: "routine", trigger: "event", status: "waiting", terminalReason: "WAITING_APPROVAL" });
    expect(await catalogRowFor(w.db, "run_cat3", { slot: "slot-1", gen: 3 })).toMatchObject({ grounded: null, status: "waiting" });
    await insertRun("run_cat4", { provider: "workers_ai", model: "@cf/openai/gpt-oss-120b" });
    expect((await catalogRowFor(w.db, "run_cat4", { slot: "slot-1", gen: 3 }))!.neurons).toBe(runNeurons("workers_ai", { input: 12_000, output: 300 }));
    expect(runNeurons("workers_ai", { input: 12_000, output: 300 })).toBe(403);
    await insertRun("run_cat5", { status: "running", terminalReason: null }, null);
    expect(await catalogRowFor(w.db, "run_cat5", { slot: "slot-1", gen: 3 })).toBeNull();
    expect(await catalogRowFor(w.db, "run_missing", { slot: "slot-1", gen: 3 })).toBeNull();
  });
});
