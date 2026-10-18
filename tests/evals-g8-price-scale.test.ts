// G8's dollar check scaled by model price (approved by Nitish, 2026-10-18; docs/evals/model-comparison.md follow-up 1).
// Task budgets (budget.maxUsd) are written at Luna prices. The loop's run cap and the runner's checkCaps already
// multiply by runCapScaleFor(provider, model); G8 now grades the same way, so a model priced 10x Luna is not failed for
// doing the same work at its own price. Steps and BUDGET_EXCEEDED are unchanged.
import { describe, expect, it } from "vitest";
import { EvalExpectation } from "@weft/contracts";
import { runCapScaleFor } from "../packages/agent/src/cost";
import { g8, g8Dollars, runPriceScale } from "../evals/suite/graders/index";
import { checkCaps, newState, type RunnerOptions } from "../evals/suite/runner";
import type { EvRun, TrialEvidence } from "../evals/suite/types";

const exp = () => EvalExpectation.parse({});
const run = (r: Partial<EvRun> = {}): EvRun => ({ id: "run_0001", kind: "main", parentRunId: null, routineRunId: null, status: "done", terminalReason: "DONE", tainted: false, taintedBy: null, stepsUsed: 2, costUsd: 0.001, summary: "Done.", ...r });
const ev = (runs: EvRun[]): TrialEvidence => ({
  mainRunId: "run_0001", runs, steps: [], actions: [], proposals: [], priorProposals: [], messages: [],
  memory: { headBefore: "a", headAfter: "a", commits: [], changed: [], texts: [] }, otlp: [], canaries: [], registry: () => null, endState: [], wallMs: 0, error: null,
});
const task = { budget: { maxSteps: 6, maxUsd: 0.02 } };
const luna = (costUsd: number) => run({ provider: "openai", model: "gpt-5.6-luna", costUsd });
const terra = (costUsd: number, r: Partial<EvRun> = {}) => run({ provider: "openai", model: "gpt-5.6-terra", costUsd, ...r });
const claude = (costUsd: number) => run({ provider: "claude", model: "claude-opus-5-5", costUsd });

describe("G8 dollar budget at the model's price", () => {
  it("uses the factor the run cap and checkCaps use: Luna 1, Terra 10, Claude 6, scripted and unknown 1", () => {
    expect(runPriceScale(luna(0))).toBe(1);
    expect(runPriceScale(terra(0))).toBe(runCapScaleFor("openai", "gpt-5.6-terra"));
    expect(runPriceScale(terra(0))).toBe(10);
    expect(runPriceScale(claude(0))).toBe(runCapScaleFor("claude", "claude-opus-5-5"));
    expect(runPriceScale(claude(0))).toBe(6);
    expect(runPriceScale(run({ provider: "scripted", model: "scripted" }))).toBe(1);
    expect(runPriceScale(run())).toBe(1);   // older evidence with no provider: priced as OpenAI
    expect(runPriceScale(run({ provider: "openai", model: "template" }))).toBe(1);
  });

  it("Luna: unchanged, the budget is maxUsd", () => {
    expect(g8(ev([luna(0.02)]), exp(), task).pass).toBe(true);
    const over = g8(ev([luna(0.0201)]), exp(), task);
    expect(over.pass).toBe(false);
    expect(over.reasons).toEqual(["$0.0201 spent, budget $0.0200"]);
  });

  it("Terra: 10x the budget, so the same work at Terra's price passes and a real overrun still fails", () => {
    // The comparison's largest dollar-only overrun was 3.2x a Luna budget: it passes now.
    expect(g8(ev([terra(0.064)]), exp(), task).pass).toBe(true);
    expect(g8(ev([terra(0.2)]), exp(), task).pass).toBe(true);
    const over = g8(ev([terra(0.21)]), exp(), task);
    expect(over.pass).toBe(false);
    expect(over.reasons[0]).toBe("$0.2100 spent, budget $0.2000 ($0.0200 at Luna prices, scaled 10x for the model's price)");
  });

  it("Claude: 6x the budget", () => {
    expect(g8(ev([claude(0.12)]), exp(), task).pass).toBe(true);
    expect(g8(ev([claude(0.1201)]), exp(), task).pass).toBe(false);
    expect(g8Dollars(ev([claude(0.06)]), 0.02)).toMatchObject({ scale: 6, over: false });
  });

  it("a trial whose runs used different models is graded in Luna dollars, run by run", () => {
    // $0.10 on Terra is $0.010 at Luna prices; with a $0.015 Luna child run the trial is $0.025 Luna, over $0.02.
    const mixed = ev([terra(0.1), luna(0.015)]);
    const d = g8Dollars(mixed, 0.02);
    expect(d.lunaUsd).toBeCloseTo(0.025, 10);
    expect(d.over).toBe(true);
    expect(g8(ev([terra(0.1), luna(0.005)]), exp(), task).pass).toBe(true);
  });

  it("the step cap and BUDGET_EXCEEDED are not scaled", () => {
    expect(g8(ev([terra(0.001, { stepsUsed: 7 })]), exp(), task).pass).toBe(false);
    expect(g8(ev([terra(0.001, { terminalReason: "BUDGET_EXCEEDED", status: "failed" })]), exp(), task).pass).toBe(false);
  });

  it("G8 and checkCaps agree on what one task may cost for each model", () => {
    const t = { id: "XX-01", budget: { maxSteps: 6, maxUsd: 0.02 } } as Parameters<typeof checkCaps>[1];
    for (const r of [luna(0), terra(0), claude(0)]) {
      const scale = runPriceScale(r);
      const o: Pick<RunnerOptions, "suiteCapUsd" | "wave" | "mode" | "costScale"> = { mode: "live", suiteCapUsd: 0.02 * scale, wave: null, costScale: scale };
      expect(checkCaps(newState(), t, o), `${r.model} fits its own cap`).toBeNull();
      expect(g8(ev([{ ...r, costUsd: 0.02 * scale }]), exp(), t).pass, `${r.model} at the scaled budget`).toBe(true);
      expect(g8(ev([{ ...r, costUsd: 0.02 * scale * 1.01 }]), exp(), t).pass, `${r.model} over the scaled budget`).toBe(false);
    }
  });
});
