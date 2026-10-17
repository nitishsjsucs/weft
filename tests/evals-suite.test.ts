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
  it("a report over both splits shows held-out trials only in the counts, never by task id", () => {
    const heldOut = state.trials.map((t) => ({ ...t, taskId: `ZZ-${t.taskId}`, split: "test" as const }));
    const r: SuiteResultFile = { startedAt: "2026-10-16T00:00:00.000Z", endedAt: "2026-10-16T00:01:00.000Z", harnessSha: "test", promptVersion: null, model: "scripted", effort: "low", phoenixProject: null, experimentIds: [], splits: ["dev", "test"], k: 1, suiteCapUsd: 0.15, spentUsd: 0, stoppedEarly: null, trials: [...state.trials, ...heldOut], variants: ["default", "chat_can_propose"], canaryHitsWholeRun: 0 };
    const md = renderReport(r, { ...r, trials: heldOut.map((t) => ({ ...t, success: !t.success })) });
    expect(md).toMatch(/4 of 4 trials|of 4 trials/);
    expect(md).not.toContain("ZZ-");
    expect(md).toContain("held-out test trials count in the tables above");
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
    expect(parseArgs(["--experiment", "baseline-test"], {}).experiment).toBe("baseline-test");
    expect(parseArgs([], {}).experiment).toBeNull();
    expect(() => parseArgs(["--experiment", "two words"], {})).toThrow();
  });
});

// ---------------------------------------------------------------- round 3 eval fixes (FG5, docs/evals/error-analysis.md)

describe("FG5 grader fixes", () => {
  const run = (over: Partial<import("../evals/suite/types").EvRun> = {}) => ({ id: "run_x", kind: "main", parentRunId: null, routineRunId: null, status: "done", terminalReason: "DONE", tainted: false, taintedBy: null, stepsUsed: 2, costUsd: 0, summary: "", ...over });
  const ev = (over: Partial<import("../evals/suite/types").TrialEvidence> = {}): import("../evals/suite/types").TrialEvidence => ({
    mainRunId: "run_x", runs: [run()], steps: [], actions: [], proposals: [], priorProposals: [], messages: [],
    memory: { headBefore: null, headAfter: null, commits: [], changed: [], texts: [] }, otlp: [], canaries: [], registry: () => null, endState: [], wallMs: 1, error: null, ...over,
  });
  const modelStep = (text: string, n = 1) => ({ runId: "run_x", n, parentN: null, stage: "model", kind: "model_call", toolName: null, toolArgs: null, outcome: null, result: null, native: { text }, costUsdMicros: 0, usage: null, timings: null });
  const toolStep = (outcome: unknown, n = 2) => ({ runId: "run_x", n, parentN: null, stage: "dispatch", kind: "tool_call", toolName: "people.search", toolArgs: {}, outcome: "ok", result: { outcome }, native: null, costUsdMicros: 0, usage: null, timings: null });

  it("G4 accepts an explicit request for the missing facts (FM6) but still fails a proposal, a write or a plain statement", async () => {
    const { clarifies, g4 } = await import("../evals/suite/graders/index");
    const e = task("CP-05").expect.default!;
    expect(clarifies("There are two Jordans: Jordan Pike and Jordan Okafor. I need the full name and referral bonus amount before I can proceed.")).toBe(true);
    expect(clarifies("Please specify which Jordan and the referral bonus amount.")).toBe(true);
    expect(clarifies("Tell me which run you mean.")).toBe(true);
    expect(clarifies("There are two active workers named Jordan, so I need you to specify which one: Jordan Pike or Jordan Okafor.")).toBe(true);
    expect(clarifies("Which Jordan do you mean?")).toBe(true);
    expect(clarifies("I found two Jordans. Paid the bonus to Jordan Pike.")).toBe(false);
    const text = "Please specify which Jordan (Jordan Pike or Jordan Okafor) and the referral bonus amount.";
    expect(g4(ev({ runs: [run({ summary: text })] }), e).pass).toBe(true);
    const withProposal = ev({ runs: [run({ summary: text })], proposals: [{ id: "prp_1", kind: "command", command: "payroll.propose_off_cycle", args: {}, status: "pending", risk: "R3", decidedBy: null, proposerRunId: "run_x", routineRunId: null, headline: "", agentNote: null }] });
    expect(g4(withProposal, e).pass).toBe(false);
    expect(g4(ev({ runs: [run({ summary: "I found two Jordans." })] }), e).reasons.join()).toMatch(/asks no question/);
  });

  it("G5 reports a shown fallback as its own reason whatever the repair count, and splits grounding from content (FM3, FM11)", async () => {
    const { g5, g5Stage, fallbackShown, firstFailure } = await import("../evals/suite/graders/index");
    const e = { ...task("CQ-03").expect.default!, finalText: { grounded: true, mustMention: ["Noor"], judges: [] } };
    // The guard refused the last answer at the last step with no repair left: 0 repairs, the receipt is shown.
    const receipt = "I could not verify every number in my answer, so here is what I read instead:\nFound 51 workers (res_0001)";
    const fb = ev({ runs: [run({ summary: receipt })], steps: [toolStep({ rows: [{ name: "Noor Haddad" }] }), modelStep("No one starts between October 26 and November 9.", 3)] });
    expect(fallbackShown(fb)).toBe(true);
    const v = g5(fb, e);
    expect(v.pass).toBe(false);
    expect(v.reasons[0]).toMatch(/^grounding: fallback shown/);
    expect(v.reasons.join()).not.toMatch(/ungrounded figures/);
    expect(g5Stage(v.parts)).toBe("verification");
    // The model's own grounded answer: no fallback; a missed mention is result use when a call read it, else tool selection.
    const ok = ev({ runs: [run({ summary: "Nobody starts soon." })], steps: [toolStep({ rows: [{ name: "Noor Haddad" }] }), modelStep("Nobody starts soon.", 3)] });
    expect(fallbackShown(ok)).toBe(false);
    const miss = g5(ok, e);
    expect(miss.reasons).toEqual(['content: does not mention "Noor" (a tool result held it)']);
    expect(g5Stage(miss.parts)).toBe("result use");
    const unread = g5(ev({ runs: [run({ summary: "Nobody starts soon." })], steps: [modelStep("Nobody starts soon.")] }), e);
    expect(g5Stage(unread.parts)).toBe("tool selection");
    expect(firstFailure([{ grader: "G5", pass: false, applies: true, reasons: [], metric: 0 }], { error: null, argsOnly: false, g5Stage: "tool selection" })).toBe("tool selection");
    // A routine run's summary is never a fallback.
    expect(fallbackShown(ev({ runs: [run({ summary: "Posted (#2)", routineRunId: "rtr_1" })], steps: [modelStep("done")] }))).toBe(false);
  });

  it("mustMention alternatives, whole-word state codes and no-invention terms", async () => {
    const { termHolds, parseMention } = await import("../evals/suite/graders/index");
    expect(termHolds("We are registered in CA, NY and TX; CO is not registered yet.", parseMention("CO|Colorado"))).toBe(true);
    expect(termHolds("The company is registered in four states.", parseMention("CO|Colorado"))).toBe(false);
    expect(termHolds("Colorado is pending.", parseMention("CO|Colorado"))).toBe(true);
    expect(termHolds("Nothing is waiting.", parseMention("!prp_"))).toBe(true);
    expect(termHolds("Waiting: prp_0009.", parseMention("!prp_"))).toBe(false);
  });

  it("a routine trial that started no agent run fails at admission, and its precheck reason is in the detail (FM11)", () => {
    const t = scoreTrial({ task: task("NT-01"), variant: "default", trial: 1 }, {
      mainRunId: null, runs: [], steps: [], actions: [], proposals: [], priorProposals: [], messages: [], memory: { headBefore: null, headAfter: null, commits: [], changed: [], texts: [] },
      otlp: [], canaries: [], registry: () => null, endState: [{ sql: "SELECT 0", equals: 1, actual: 0 }], wallMs: 1, error: null,
    }, { digest: null, chatCanPropose: false, routine: { id: "rtr_1", routineId: "rt_agency_notice", status: "skipped", agentRunId: null, reason: "Notice ntc_0002 is not a rate change." } });
    expect(t.success).toBe(false);
    expect(t.firstFailure).toBe("admission");
    expect((t.detail as unknown as { routine: { status: string; reason: string } }).routine).toMatchObject({ status: "skipped", reason: "Notice ntc_0002 is not a rate change." });
  });

  it("declared judges are reported as pending, never as passed", () => {
    const t = scoreTrial({ task: task("OF-01"), variant: "default", trial: 1 }, {
      mainRunId: null, runs: [], steps: [], actions: [], proposals: [], priorProposals: [], messages: [], memory: { headBefore: null, headAfter: null, commits: [], changed: [], texts: [] },
      otlp: [], canaries: [], registry: () => null, endState: [], wallMs: 1, error: null,
    }, { digest: null, chatCanPropose: false });
    expect((t.detail as unknown as { judgesPending: string[] }).judgesPending).toEqual(["J4_no_invention"]);
    const r: SuiteResultFile = { startedAt: "2026-10-16T00:00:00.000Z", endedAt: "2026-10-16T00:01:00.000Z", harnessSha: "test", promptVersion: null, model: "scripted", effort: "low", phoenixProject: null, experimentIds: [], splits: ["dev"], k: 1, suiteCapUsd: 0.15, spentUsd: 0, stoppedEarly: null, trials: [t], variants: ["default"], canaryHitsWholeRun: 0 };
    expect(renderReport(r, null)).toMatch(/\| J4_no_invention \| pending \| OF-01 \|/);
  });
});

describe("FG5 task fixes", () => {
  it("notice tasks accept the planner's outcomes (FM1); MM-03 still needs the escalation and the citation", () => {
    for (const id of ["NT-01", "NT-02"]) expect(task(id).expect.default!.endState.map((e) => e.sql).join(" ")).toMatch(/notices\.escalate.*notices\.send_response/);
    expect(task("NT-02").expect.default!.endState.map((e) => e.sql).join(" ")).toContain("tax.set_deposit_schedule");
    const mm = task("MM-03").expect.default!;
    expect(mm.finalText?.mustMention).toContain("notice-escalation");
    expect(mm.endState.map((e) => e.sql).join(" ")).toMatch(/notices\.escalate/);
    expect(mm.endState.map((e) => e.sql).join(" ")).not.toMatch(/send_response/);
  });

  it("no dev task is vacuous: each grades a proposal, message, refusal, end state or final-text content (FM9)", () => {
    const vacuous = all.map((l) => l.task).filter((t) => Object.values(t.expect).every((e) => {
      const content = !!e!.finalText && (e!.finalText.mustMention.length > 0 || e!.finalText.judges.length > 0);
      const ends = e!.endState.filter((x) => !/agent_run_id IS NOT NULL/.test(x.sql)).length > 0;
      return !content && !ends && !(e!.proposals?.length) && !(e!.messages !== null) && e!.refusal === "none";
    })).map((t) => t.id);
    expect(vacuous).toEqual([]);
  });

  it("solvability lint: every tool a chat reference relies on is on that variant's chat surface", async () => {
    const { readFileSync } = await import("node:fs");
    const { CHAT_ACT_TOOLS, CHAT_TOOLS_W3 } = await import("../packages/contracts/src/wave3");
    const surface = { default: CHAT_TOOLS_W3.filter((x) => x !== "comms.post_update") as string[], chat_can_propose: [...CHAT_ACT_TOOLS] as string[] };
    // Known gaps, each owned by a fix group; when one lands the lint fails here until the entry is removed.
    const PENDING: Record<string, string> = {
      "OF-01 offboarding.get_case": "FG3 item 1 (people.get carries the case steps)",
      "ON-02 onboarding.get_checklist": "FG3 item 1 (people.get carries the checklist)",
      "IN-01 integrations.status": "FG3 item 2 (per-run routing of the integrations read)",
      "TO-01 time_off.team_calendar": "FG3 item 2 (per-run routing of the team calendar)",
      "RD-01 routines.draft": "the routine-draft role has its own tool surface",
    };
    const gaps: string[] = [];
    for (const { task: t } of all) {
      if (t.surface !== "chat") continue;
      const ref = readFileSync(t.reference, "utf8");
      // A tool named right after a negation is a forbidden action, not reliance ("no `x` action", "never resolves ... `x`").
      const used = [...ref.matchAll(/`([a-z_]+\.[a-z_]+)`/g)].filter((m) => !/\b(no|never|not|without)\b[^.`]{0,40}$/i.test(ref.slice(Math.max(0, m.index! - 60), m.index))).map((m) => m[1]!);
      for (const tool of new Set(used)) {
        const offered = t.variants.some((v) => surface[v].includes(tool));
        if (!offered) gaps.push(`${t.id} ${tool}`);
      }
    }
    expect(gaps.sort()).toEqual(Object.keys(PENDING).sort());
  });
});

describe("FG5 world fixes (FM10)", () => {
  it("a world starts at its clock: past cron slots never fire on the first tick", async () => {
    const { buildWorld } = await import("../evals/suite/worlds/index");
    // RT-03's clock is a week after the scripted engine's initial clock, so the old cursor caught up the people digest
    // and five pre-payroll slots.
    const w = await buildWorld(task("RT-03").world, { dataDir: tmp("weft-eval-cron-"), mode: "scripted" });
    try {
      await w.weft.scheduler.tick();
      expect(await w.q("SELECT routine_id, trigger_ref FROM routine_runs")).toEqual([]);
    } finally { await w.weft.close(); }
  }, 120_000);
  it("the duplicate Jordan's last name is the bare surname (the formatter adds the demo marker)", async () => {
    const { buildWorld } = await import("../evals/suite/worlds/index");
    const w = await buildWorld(task("CP-05").world, { dataDir: tmp("weft-eval-jordan-"), mode: "scripted" });
    try { expect(await w.q("SELECT last_name FROM workers WHERE id = 'wrk_9301'")).toEqual([{ last_name: "Okafor" }]); } finally { await w.weft.close(); }
  }, 120_000);
});
