// Run step numbering (SPEC 6.5). The store caches each run's next step number. POST /v1/sim/reset rebuilds the world on
// the same process, and run ids restart at run_0001, so a fresh run with a reused id must count its steps from 1 again.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRunRow } from "@weft/contracts";
import { agentRuns, closeDb, migrate, openDb, runSteps, type Db } from "@weft/db";
import { createRunStore, type NewStep } from "../src/store";

let dataDir: string;
let db: Db;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "weft-store-"));
  db = openDb({ dataDir });
  await migrate(db);
});
afterEach(async () => {
  await closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

const run: AgentRunRow = {
  id: "run_0001", companyId: "co_0001", kind: "main", parentRunId: null, threadId: null, routineRunId: null, trigger: "chat", attended: true,
  provider: "scripted", model: "scripted", effort: "low", cacheKey: "k", status: "running", terminalReason: null, tainted: false, taintedBy: null,
  checklist: null, budget: { steps: 6, usd: 0.1, minutes: 10 }, stepsUsed: 0, requeues: 0, consecutiveErrors: 0, costUsdMicros: 0,
  tokens: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 }, createdAt: "2026-10-26T16:00:00.000Z", endedAt: null, summary: null,
};
const step: NewStep = { stage: "assemble", kind: "context", parentN: null, callId: null, toolName: null, toolArgs: null, outcome: "ok", result: null, native: null, usage: null, costUsdMicros: 0, attempt: 1, requestId: null, prefixHash: null, timings: null };

describe("run store step numbers", () => {
  it("numbers a run's steps 1, 2, 3", async () => {
    const store = createRunStore(db);
    await store.createRun(run);
    const ns = [];
    for (let i = 0; i < 3; i++) ns.push((await store.appendStep(run.id, step)).n);
    expect(ns).toEqual([1, 2, 3]);
  });

  it("starts again at 1 when a world reset reuses the run id", async () => {
    const store = createRunStore(db);
    await store.createRun(run);
    for (let i = 0; i < 3; i++) await store.appendStep(run.id, step);
    // What the reset leaves behind: empty tables, the same store, the next run minted as run_0001 again.
    await db.delete(runSteps);
    await db.delete(agentRuns);
    await store.createRun(run);
    expect((await store.appendStep(run.id, step)).n).toBe(1);
    expect((await store.steps(run.id)).map((s) => s.n)).toEqual([1]);
  });
});
