// The eval suite end to end on the scripted provider (no spend): every task validates, every world reproduces its
// pinned digest, scripted trials grade as expected, the chat_can_propose variant stays in its own trial world, the
// runner refuses a drifted world and stops cleanly before the suite cap or the wave cap, and the report keeps the two
// variants in separate tables.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { appendWaveSpend } from "../scripts/wave-ledger";
import { loadTasks, validateTask } from "../evals/suite/loader";
import { digests, parseArgs } from "../evals/suite/run";
import { checkCaps, newState, planTrials, runPlain, scoreTrial, type RunnerOptions } from "../evals/suite/runner";
import { renderReport, type SuiteResultFile } from "../evals/suite/report";
import type { EvalTask } from "../evals/suite/types";

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const all = loadTasks(["dev"]);
const task = (id: string) => all.find((l) => l.task.id === id)!.task;
const opts = (over: Partial<RunnerOptions> = {}): RunnerOptions => ({
  mode: "scripted", baseDir: tmp("weft-eval-suite-"), suiteCapUsd: 0.15, harnessSha: "test", requireDigest: true,
  wave: { stage: "w4-eval-suite-test", stageCapUsd: 0.1, ledgerPath: join(tmp("weft-eval-ledger-"), "wave4-spend.json") }, ...over,
});

describe("task files", () => {
  it("every dev task validates against EvalTask and the suite rules", () => {
    expect(all.length).toBeGreaterThanOrEqual(30);
    expect(new Set(all.map((l) => l.task.id)).size).toBe(all.length);
    for (const l of all) expect(l.task.world.digest, l.task.id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it("L1 to L10 are ported into the dev split", () => {
    const legacy = all.map((l) => l.task.legacyCase).filter(Boolean).sort();
    expect(legacy).toEqual(["L1", "L10", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9"]);
    expect(all.filter((l) => l.task.legacyCase).every((l) => l.task.split === "dev")).toBe(true);
  });
  it("rejects a malformed task, a wrong file name, an unknown mutator and a variant without an expectation", () => {
    const good = JSON.parse(JSON.stringify(task("CQ-01"))) as Record<string, any>;
    expect(validateTask(good, "evals/suite/tasks/dev/CQ-01.json").problems).toEqual([]);
    expect(validateTask({ ...good, id: "bad" }, "evals/suite/tasks/dev/CQ-01.json").problems.length).toBeGreaterThan(0);
    expect(validateTask(good, "evals/suite/tasks/dev/CQ-02.json").problems.join()).toMatch(/does not match id/);
    expect(validateTask({ ...good, world: { ...good.world, mutators: ["noSuchWorld"] } }, "evals/suite/tasks/dev/CQ-01.json").problems.join()).toMatch(/unknown mutator/);
    expect(validateTask({ ...good, variants: ["default", "chat_can_propose"] }, "evals/suite/tasks/dev/CQ-01.json").problems.join()).toMatch(/no expectation/);
    expect(validateTask({ ...good, reference: "evals/suite/reference/dev/NOPE.md" }, "evals/suite/tasks/dev/CQ-01.json").problems.join()).toMatch(/reference note/);
  });
});

describe("worlds", () => {
  // Every distinct world is rebuilt by `pnpm eval:suite digests` and before every trial (WORLD_DRIFT). Here a sample
  // covers the base world and each mutator family; WEFT_EVAL_ALL_DIGESTS=1 rebuilds all of them.
  it("worlds reproduce their pinned digests", async () => {
    const sample = process.env.WEFT_EVAL_ALL_DIGESTS === "1" ? all.map((l) => l.task) : ["CQ-01", "CP-01", "RT-05", "AM-01", "OF-01", "MM-01"].map(task);
    const res = await digests(sample, { write: false, baseDir: tmp("weft-eval-digest-") });
    expect(res.filter((r) => r.pinned !== r.actual).map((r) => `${r.id} ${r.pinned} != ${r.actual}`)).toEqual([]);
  }, 600_000);
});

describe("worlds built through product routes", () => {
  it("a mutator that goes through a route never ticks the scheduler during the build, so no routine runs", async () => {
    const { buildWorld } = await import("../evals/suite/worlds/index");
    const w = await buildWorld(task("ON-02").world, { dataDir: tmp("weft-eval-world-"), mode: "scripted" });
    try {
      expect(await w.q("SELECT COUNT(*) AS n FROM routine_runs")).toEqual([{ n: 0 }]);
      expect(await w.q("SELECT COUNT(*) AS n FROM agent_runs")).toEqual([{ n: 0 }]);
      expect(await w.q("SELECT COUNT(*) AS n FROM onboarding_tasks WHERE worker_id = 'wrk_0052'")).toEqual([{ n: 9 }]);
      // The kick is restored for the trial itself.
      const sched = w.weft.scheduler as unknown as { kick: () => Promise<unknown>; tick: () => Promise<unknown> };
      expect(sched.kick).toBe(sched.tick);
    } finally { await w.weft.close(); }
  }, 120_000);
});

describe("runner on the scripted provider", () => {
  const ids = ["CQ-01", "CP-01"];
  let state: Awaited<ReturnType<typeof runPlain>>;
  it("runs trials one at a time, each in a fresh world, and grades them", async () => {
    const o = opts();
    state = await runPlain(planTrials(ids.map(task), ["default", "chat_can_propose"], 1), o);
    expect(state.stoppedEarly).toBeNull();
    expect(state.trials.map((t) => `${t.taskId}/${t.variant}`)).toEqual(["CQ-01/default", "CP-01/default", "CP-01/chat_can_propose"]);
    for (const t of state.trials) {
      expect(t.error, t.taskId).toBeNull();
      expect(t.success, `${t.taskId} ${t.variant}: ${t.graders.filter((g) => !g.pass).map((g) => g.reasons.join("; ")).join(" | ")}`).toBe(true);
      expect(t.graders.find((g) => g.grader === "G9")!.pass).toBe(true);
      expect(t.detail.digest).toBe(task(t.taskId).world.digest);
    }
    // Fresh worlds: every trial's id counters start from the seed, so each trial's first run has the same id.
    expect(new Set(state.trials.map((x) => x.runIds[0])).size).toBe(1);
  }, 600_000);
  it("the chat_can_propose variant is on only in its own trial world", () => {
    const flags = state.trials.map((t) => [`${t.taskId}/${t.variant}`, t.detail.chatCanPropose]);
    expect(flags).toEqual([["CQ-01/default", false], ["CP-01/default", false], ["CP-01/chat_can_propose", true]]);
    const cp = state.trials.find((t) => t.variant === "chat_can_propose")!;
    expect(cp.detail.proposals).toMatchObject({ matched: 1, actual: 1 });
    expect(state.trials.find((t) => t.taskId === "CP-01" && t.variant === "default")!.detail.proposals).toMatchObject({ actual: 0, expected: 0 });
  });
  it("the report puts the two variants in separate tables", () => {
    const r: SuiteResultFile = { startedAt: "2026-10-16T00:00:00.000Z", endedAt: "2026-10-16T00:01:00.000Z", harnessSha: "test", promptVersion: null, model: "scripted", effort: "low", phoenixProject: null, experimentIds: [], splits: ["dev"], k: 1, suiteCapUsd: 0.15, spentUsd: 0, stoppedEarly: null, trials: state.trials, variants: ["default", "chat_can_propose"], canaryHitsWholeRun: 0 };
    const md = renderReport(r, null);
    const d = md.indexOf("## Default variant");
    const v = md.indexOf("## Variant chat_can_propose");
    expect(d).toBeGreaterThan(0);
    expect(v).toBeGreaterThan(d);
    expect(md.slice(d, v)).toMatch(/2 of 2 trials/);
    expect(md.slice(v)).toMatch(/1 of 1 trials/);
    expect(md).not.toMatch(new RegExp("[\\u2013\\u2014]"));
  });
  it("graders fail on a scripted run when the evidence shows an unapproved effect", () => {
    const t = state.trials.find((x) => x.taskId === "CQ-01")!;
    expect(t.graders.find((g) => g.grader === "G1")!.metric).toBe(0);
    // scoreTrial on evidence with a planted executed write: G1 fails and success follows.
    const bad = scoreTrial({ task: task("CQ-01"), variant: "default", trial: 1 }, {
      mainRunId: "run_x", runs: [{ id: "run_x", kind: "main", parentRunId: null, routineRunId: null, status: "done", terminalReason: "DONE", tainted: false, taintedBy: null, stepsUsed: 2, costUsd: 0, summary: "res_0001" }],
      steps: [], actions: [{ seq: 9, command: "payroll.submit_run", args: {}, actorKind: "agent", actorId: "agt_weft", agentRunId: "run_x", routineRunId: null, proposalId: null, summary: "" }],
      proposals: [], priorProposals: [], messages: [], memory: { headBefore: null, headAfter: null, commits: [], changed: [], texts: [] }, otlp: [], canaries: [],
      registry: (n) => n === "payroll.submit_run" ? { name: n, effect: "write", approval: "always", autoAllow: "never", access: "all", risk: () => "R4" } : null, endState: [], wallMs: 1, error: null,
    }, { digest: null, chatCanPropose: false });
    expect(bad.success).toBe(false);
    expect(bad.firstFailure).toBe("executor policy");
    expect(bad.detail.unsafe.g1).toBe(1);
  });
});

describe("caps and drift", () => {
  it("refuses a drifted world with WORLD_DRIFT before any run", async () => {
    const drifted: EvalTask = { ...task("CQ-01"), world: { ...task("CQ-01").world, digest: `sha256:${"0".repeat(64)}` } };
    const s = await runPlain(planTrials([drifted], ["default"], 1), opts());
    expect(s.trials[0]!.error).toMatch(/^WORLD_DRIFT/);
    expect(s.trials[0]!.runIds).toEqual([]);
  }, 300_000);
  it("stops cleanly before the suite cap", async () => {
    const o = opts({ suiteCapUsd: 0.025 });
    const s = newState();
    s.spentUsd = 0.01;
    expect(checkCaps(s, task("CQ-01"), o)).toMatch(/^SUITE_CAP/);
    const ran = await runPlain(planTrials([task("CQ-01"), task("CH-01")], ["default"], 1), o, s);
    expect(ran.trials).toEqual([]);
    expect(ran.stoppedEarly).toMatch(/^SUITE_CAP/);
  });
  it("stops cleanly before the wave cap and the stage cap in the shared ledger", () => {
    const o = opts({ mode: "live" });
    appendWaveSpend({ stage: "other-stage", usd: 2.99, cap: 3, note: "test" }, o.wave!.ledgerPath);
    expect(checkCaps(newState(), task("CQ-01"), o)).toMatch(/^WAVE_CAP: wave 4/);
    const o2 = opts({ mode: "live" });
    appendWaveSpend({ stage: o2.wave!.stage, usd: 0.095, cap: 0.1, note: "test" }, o2.wave!.ledgerPath);
    expect(checkCaps(newState(), task("CQ-01"), o2)).toMatch(/^WAVE_CAP: stage/);
    expect(checkCaps(newState(), task("CQ-01"), opts({ mode: "live" }))).toBeNull();
  });
  it("parses the CLI flags", () => {
    expect(parseArgs(["--split", "dev", "--variant", "chat_can_propose", "--k", "3", "--legacy"], {})).toMatchObject({ cmd: "run", splits: ["dev"], variants: ["chat_can_propose"], k: 3, legacy: true, provider: "scripted", phoenix: false });
    expect(parseArgs(["digests", "--write"], {})).toMatchObject({ cmd: "digests", write: true });
    expect(parseArgs([], { WEFT_TRACE: "phoenix" }).phoenix).toBe(true);
    expect(() => parseArgs(["--k", "0"], {})).toThrow();
  });
});
