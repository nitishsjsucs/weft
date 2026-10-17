import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendWaveSpend, assertWaveBudget, readWaveSpend, waveSpentUsd } from "../scripts/wave-ledger";

const dirs: string[] = [];
const ledger = () => { const d = mkdtempSync(join(tmpdir(), "weft-wave-ledger-")); dirs.push(d); return join(d, "nested", "wave4-spend.json"); };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("wave 4 spend ledger", () => {
  it("starts empty, appends under a lock and sums", () => {
    const p = ledger();
    expect(readWaveSpend(p)).toEqual([]);
    expect(appendWaveSpend({ stage: "w4-eval-suite", usd: 0.12, cap: 1.5, note: "baseline" }, p)).toBeCloseTo(0.12);
    expect(appendWaveSpend({ stage: "w4-telemetry", usd: 0.01, cap: 0.1, note: "smoke" }, p)).toBeCloseTo(0.13);
    expect(readWaveSpend(p).map((e) => e.stage)).toEqual(["w4-eval-suite", "w4-telemetry"]);
    expect(waveSpentUsd(p)).toBeCloseTo(0.13);
  });
  it("refuses a spend that crosses the wave cap or the stage cap", () => {
    const p = ledger();
    appendWaveSpend({ stage: "w4-eval-suite", usd: 1.4, cap: 1.5, note: "runs" }, p);
    expect(() => assertWaveBudget({ stage: "w4-eval-suite", stageCapUsd: 1.5, nextUsd: 0.2 }, p)).toThrow(/WAVE_CAP: stage w4-eval-suite/);
    appendWaveSpend({ stage: "other", usd: 1.55, cap: 2, note: "x" }, p);
    expect(() => assertWaveBudget({ stage: "w4-telemetry", stageCapUsd: 0.1, nextUsd: 0.06 }, p)).toThrow(/WAVE_CAP: wave 4 has spent/);
    expect(assertWaveBudget({ stage: "w4-telemetry", stageCapUsd: 0.1, nextUsd: 0.04 }, p).spent).toBeCloseTo(2.95);
  });
  it("rejects a negative or malformed entry", () => {
    expect(() => appendWaveSpend({ stage: "x", usd: -1, cap: 1, note: "" }, ledger())).toThrow();
  });
});
