// The eval runner's side of the model comparison: it records model, effort, WEFT_BACKGROUND_LLM and the cost factor
// for each run, scales each task's worst case for a model priced above Luna, keeps reasoning tokens per trial, and a
// ledger kept for another spend can carry its own total cap.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { waveCapUsd } from "../scripts/wave-ledger";
import { loadTasks } from "../evals/suite/loader";
import { parseArgs, runSetup } from "../evals/suite/run";
import { checkCaps, detailOf, newState, scoreTrial, type RunnerOptions } from "../evals/suite/runner";
import type { EvStep, TrialEvidence } from "../evals/suite/types";

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tasks = loadTasks(["test"]).map((l) => l.task);

describe("run setup", () => {
  it("live: WEFT_MODEL, WEFT_EFFORT and WEFT_BACKGROUND_LLM are recorded; unset gives Luna at the per-stage low", () => {
    expect(runSetup("live", {})).toEqual({ model: "gpt-5.6-luna", effort: "low", effortSource: "default", backgroundLlm: false, costScale: 1 });
    expect(runSetup("live", { WEFT_MODEL: "gpt-5.6-terra", WEFT_EFFORT: "medium", WEFT_BACKGROUND_LLM: "1" }))
      .toEqual({ model: "gpt-5.6-terra", effort: "medium", effortSource: "WEFT_EFFORT", backgroundLlm: true, costScale: 10 });
    expect(runSetup("scripted", { WEFT_MODEL: "gpt-5.6-terra", WEFT_EFFORT: "high" })).toMatchObject({ model: "scripted", effort: "low" });
    expect(() => runSetup("live", { WEFT_EFFORT: "extreme" })).toThrow(/PROVIDER_CONFIG: WEFT_EFFORT/);
  });

  it("accepts an experiment name, the held-out split and k trials", () => {
    expect(parseArgs(["--split", "test", "--variant", "default", "--k", "2", "--provider", "live", "--phoenix", "--experiment", "terra-medium-test", "--cap", "1.5"], {}))
      .toMatchObject({ splits: ["test"], variants: ["default"], k: 2, provider: "live", phoenix: true, experiment: "terra-medium-test", cap: 1.5 });
    expect(tasks.length).toBe(41);
  });
});

describe("caps for a model priced above Luna", () => {
  it("multiplies each task's worst case by the cost factor, live only", () => {
    const t = tasks[0]!;
    const o = (over: Partial<RunnerOptions>): RunnerOptions => ({ mode: "live", baseDir: tmp("weft-mc-"), suiteCapUsd: t.budget.maxUsd * 5, harnessSha: "test", requireDigest: true, wave: null, ...over });
    expect(checkCaps(newState(), t, o({ costScale: 1 }))).toBeNull();
    expect(checkCaps(newState(), t, o({ costScale: 10 }))).toMatch(/^SUITE_CAP/);
    expect(checkCaps(newState(), t, o({ costScale: 10, mode: "scripted" }))).toBeNull();
  });

  it("WEFT_WAVE_USD_CAP sets a ledger's total cap; unset keeps the wave 4 cap", () => {
    expect(waveCapUsd({})).toBe(3);
    expect(waveCapUsd({ WEFT_WAVE_USD_CAP: "4.00" })).toBe(4);
    expect(() => waveCapUsd({ WEFT_WAVE_USD_CAP: "lots" })).toThrow();
  });
});

describe("reasoning tokens per trial", () => {
  it("sums the reasoning tokens of the trial's model calls into the trial detail", () => {
    const t = tasks.find((x) => x.surface === "chat") ?? tasks[0]!;
    const call = (n: number, usage: EvStep["usage"]): EvStep => ({ runId: "run_0001", n, parentN: null, stage: "model", kind: "model_call", toolName: null, toolArgs: null, outcome: "ok", result: null, native: null, costUsdMicros: 0, usage, timings: null });
    const ev: TrialEvidence = {
      mainRunId: "run_0001", runs: [{ id: "run_0001", kind: "main", parentRunId: null, routineRunId: null, status: "done", terminalReason: "DONE", tainted: false, taintedBy: null, stepsUsed: 2, costUsd: 0, summary: "Done." }],
      steps: [call(1, { input: 9000, cached: 0, output: 700, reasoning: 512 }), call(2, { input: 9500, cached: 8000, output: 300, reasoning: 128 }), call(3, null)],
      actions: [], proposals: [], priorProposals: [], messages: [], memory: { headBefore: "a", headAfter: "a", commits: [], changed: [], texts: [] },
      otlp: [], canaries: [], registry: () => null, endState: [], wallMs: 10, error: null,
    };
    const trial = scoreTrial({ task: t, variant: "default", trial: 1 }, ev, { digest: null, chatCanPropose: false });
    expect(trial.outputTokens).toBe(1000);
    expect(detailOf(trial).reasoningTokens).toBe(640);
  });
});
