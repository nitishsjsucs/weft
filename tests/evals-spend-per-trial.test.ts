// Two trials in one checkout share the eval runner's spend ledger (<baseDir>/world/spend survives between trials, so the
// live caps stay cumulative), and every trial world's first run is run_0001. Before the ledger keyed runs per world,
// the per-run cap (WEFT_RUN_USD_CAP) summed run_0001 over every earlier trial, so k = 2, or dev plus held-out in one
// checkout, lost its later trials to "Stopped by the run spend cap" (review log, 2026-10-18). This drives the real
// runner with the scripted model marked live and priced, so each trial's run spends real ledger dollars ($0).
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "../packages/contracts/src/index";
import { defaultScriptsDir, scriptedProvider, type LedgerEntry } from "../packages/agent/src/index";
import { loadTasks } from "../evals/suite/loader";
import { planTrials, runPlain, type RunnerOptions } from "../evals/suite/runner";

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Each model step costs this much at Luna prices (output tokens only): $0.03. */
const STEP_OUTPUT_TOKENS = 25_000;
const STEP_USD = (STEP_OUTPUT_TOKENS * 1.2) / 1e6;

/** The scripted model, but live and priced: its steps reserve and settle real dollars in the trial's ledger. */
function pricedScripted(): ModelProvider {
  const base = scriptedProvider({ scriptsDir: defaultScriptsDir() });
  return {
    ...base,
    live: true,
    async step(req) {
      const r = await base.step(req);
      return { ...r, usage: { input: 0, cached: 0, cacheWrite: 0, output: STEP_OUTPUT_TOKENS, reasoning: 0 } };
    },
  };
}

const ledgerLines = (baseDir: string): LedgerEntry[] => {
  const dir = join(baseDir, "world", "spend");
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LedgerEntry));
};

describe("the eval runner's spend ledger keys runs per trial world", () => {
  beforeEach(() => {
    // One trial's run fits the run cap; the two trials' run_0001 together do not.
    vi.stubEnv("WEFT_RUN_USD_CAP", String(STEP_USD * 2.5));
    vi.stubEnv("WEFT_DAY_USD_CAP", "2.00");
    vi.stubEnv("WEFT_LIVE_USD_CAP", "0.50");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("k = 2 of one task: both trials run in full, each run_0001 under its own world, and the live total is cumulative", async () => {
    const task = loadTasks(["dev"]).find((l) => l.task.id === "CQ-01")!.task;
    const baseDir = tmp("weft-eval-spend-");
    const o: RunnerOptions = { mode: "scripted", provider: pricedScripted, baseDir, suiteCapUsd: 1, harnessSha: "test", requireDigest: true, wave: null };
    const state = await runPlain(planTrials([task], ["default"], 2), o);
    expect(state.stoppedEarly).toBeNull();
    expect(state.trials).toHaveLength(2);
    const [t1, t2] = state.trials;
    expect(t1!.steps).toBeGreaterThanOrEqual(2);
    // The second trial is the first one again: same steps, same verdict, nothing cut off by a cap.
    expect(t2!.steps).toBe(t1!.steps);
    expect(t2!.success).toBe(t1!.success);
    for (const t of state.trials) {
      expect(t.runIds[0]).toBe("run_0001");
      expect(String(t.detail.finalText ?? "")).not.toMatch(/spend cap/);
      expect(t.costUsd).toBeCloseTo(STEP_USD * t.steps, 6);
    }

    const lines = ledgerLines(baseDir).filter((e) => e.runId === "run_0001");
    const worlds = [...new Set(lines.map((e) => e.world))];
    expect(worlds).toHaveLength(2);
    expect(worlds.every((w) => /^wld_[0-9a-f]{16}$/.test(String(w)))).toBe(true);
    // The case the old key lost: run_0001's settled spend over both trials is past the run cap.
    const settled = lines.filter((e) => e.kind === "settle").reduce((s, e) => s + e.usdMicros, 0);
    expect(settled / 1e6).toBeCloseTo(STEP_USD * (t1!.steps + t2!.steps), 6);
    expect(settled / 1e6).toBeGreaterThan(STEP_USD * 2.5);
    // The live cap still sees every trial: the ledger's live total is the sum of both trials' costs.
    const live = ledgerLines(baseDir).filter((e) => e.kind === "settle" && e.live).reduce((s, e) => s + e.usdMicros, 0);
    expect(live / 1e6).toBeCloseTo(t1!.costUsd + t2!.costUsd, 6);
  }, 120_000);
});
