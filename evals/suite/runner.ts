// The suite runner (research/wave4/evals.md 4.1, 6, 9; docs/wave4.md 4 and 5). Owner: w4-eval-suite.
// Trials run one at a time in one process. Each gets a fresh data dir (database, memory repository, run store); only
// the spend ledger under <baseDir>/world/spend persists, so the live caps stay cumulative. Before every trial the
// runner checks the suite cap and the shared wave 4 ledger against the task's worst case (budget.maxUsd) and stops
// cleanly when either would be crossed. A world whose digest no longer matches the task is refused (WORLD_DRIFT).
import { join } from "node:path";
import type { EvalSplit, EvalTask, GraderVerdict } from "../../packages/contracts/src/evals";
import type { EvalVariant } from "../../packages/contracts/src/telemetry";
import type { ModelProvider } from "../../packages/contracts/src/provider";
import { runTraceTags, traceRedact } from "../../packages/agent/src/otel";
import { appendWaveSpend, assertWaveBudget } from "../../scripts/wave-ledger";
import { drainRoutines, drive } from "./drivers";
import { collect, plantCanaries, snapshot } from "./evidence";
import { clarifies, endStateFailures, firstFailure, g2, g5, g5Stage, g7, gradeAll, groundingRepairs, invalidCounts, outboundMessages, providerKind, recallGap, scanCanaries, trialCostUsd, type GroundedBy, type RecallGap, type StrictGrounding, type TrialProviderKind } from "./graders/index";
import type { SuiteTrial, TrialDetail, TrialEvidence } from "./types";
import { applyVariant, buildWorld, readChatCanPropose, worldDigest, type TrialWorld } from "./worlds/index";

export interface TrialSpec { task: EvalTask; variant: EvalVariant; trial: number }

export interface RunnerOptions {
  mode: "scripted" | "live";
  /** Scripted mode: the provider for each trial world (default: the test-mode scripted provider). */
  provider?: () => ModelProvider;
  /** Trial worlds live in <baseDir>/world; <baseDir>/world/spend is kept across trials. */
  baseDir: string;
  suiteCapUsd: number;
  /** The shared wave 4 ledger: stage name and its cap; ledgerPath overrides WEFT_WAVE_LEDGER. Null skips it. */
  wave: { stage: string; stageCapUsd: number; ledgerPath?: string } | null;
  harnessSha: string;
  /** Refuse unpinned worlds (digest null) as well as drifted ones. */
  requireDigest: boolean;
  /** Collects the OTLP payload exported so far (the capture proxy in phoenix.ts); default none. */
  otlp?: () => string[];
  log?: (line: string) => void;
  /** Live: the factor on each task's worst case (budget.maxUsd, written at Luna prices) for a model priced above Luna,
   * runCapScaleFor(provider, model); default 1. */
  costScale?: number;
}

/**
 * The routine run a routine trial drove (FM11): its status and, for a run that ended without an agent run, the precheck
 * reason. A skipped notice or a quiet-hours deferral is otherwise invisible: no agent run means no trace.
 */
export interface RoutineRunInfo { id: string; routineId: string; status: string; agentRunId: string | null; reason: string | null }
/** TrialDetail plus the FG5 fields (kept here so the shared types file stays as it is). */
export type SuiteTrialDetail = TrialDetail & {
  routine: RoutineRunInfo | null; judgesPending: string[];
  /** R1: figures in the final text that only the request or only the run clock grounds (G5 accepts them, as the guard does). */
  groundedBy?: GroundedBy | null;
  /** R2: the recalled note the task needed reached the model without its rule (firstFailure is then "context"). */
  recallGap?: RecallGap | null;
  /** The independent grounding check (tool results only; never fails a trial, reported beside G5). */
  groundingStrict?: StrictGrounding | null;
  /** Who served the task's run: headline metrics count "model" trials only; the others get their own table. */
  providerKind?: TrialProviderKind;
  /** Reasoning tokens over the trial's model calls (a part of outputTokens, already priced as output). */
  reasoningTokens?: number;
  /** Approval cards the proposal notifier posted for this trial's proposals: system notifications G3 does not count as sends. */
  notifications?: number;
};
export const detailOf = (t: SuiteTrial): SuiteTrialDetail => t.detail as SuiteTrialDetail;

/** Reads the routine run's row; the reason is the precheck's own text (redacted like every exported string). */
export async function routineRunInfo(w: Pick<TrialWorld, "q">, routineRunId: string | null): Promise<RoutineRunInfo | null> {
  if (!routineRunId) return null;
  const [r] = await w.q("SELECT id, routine_id, status, agent_run_id, precheck_json, summary FROM routine_runs WHERE id = ?", [routineRunId]);
  if (!r) return null;
  let reason: string | null = null;
  try { const p = r.precheck_json ? (JSON.parse(String(r.precheck_json)) as { reason?: unknown }) : null; if (typeof p?.reason === "string") reason = p.reason; } catch { /* not JSON */ }
  if (!reason && !r.agent_run_id && typeof r.summary === "string") reason = r.summary;
  return { id: String(r.id), routineId: String(r.routine_id), status: String(r.status), agentRunId: (r.agent_run_id as string | null) ?? null, reason: reason === null ? null : traceRedact(reason).slice(0, 500) };
}

export interface RunnerState { spentUsd: number; stoppedEarly: string | null; trials: SuiteTrial[]; canaries: Map<string, string[]> }
export const trialKey = (s: { taskId: string; variant: string; trial: number }) => `${s.taskId}/${s.variant}/${s.trial}`;

const emptyDetail = (digest: string | null, chatCanPropose = false): SuiteTrialDetail => ({
  proposals: null, invalidInput: 0, unknownReference: 0, unknownCommand: 0, groundingFallback: false,
  unsafe: { g1: 0, taintMiss: 0, canaryHits: 0 }, triggering: { missedClarify: false, unneededClarify: false, falseRefusal: false, missedRefusal: false },
  timeToFirstModelMs: null, modelMs: 0, digest, chatCanPropose, finalText: null, actions: [], calls: [], routine: null, judgesPending: [],
  groundedBy: null, recallGap: null, groundingStrict: null, providerKind: "no_run", reasoningTokens: 0, notifications: 0,
});

function errorTrial(spec: TrialSpec, error: string, digest: string | null, wallMs = 0): SuiteTrial {
  return {
    taskId: spec.task.id, split: spec.task.split, group: spec.task.group, variant: spec.variant, trial: spec.trial, success: false, graders: [], judges: [],
    runIds: [], traceId: null, phoenixUrl: null, experimentRunId: null, steps: 0, toolCalls: 0, invalidToolCalls: 0, groundingRepairs: 0,
    inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, wallMs, firstFailure: "admission", error, detail: emptyDetail(digest),
  };
}

/** Scores one trial's evidence into the trial record (pure; the unit tests call it on scripted evidence). */
export function scoreTrial(spec: TrialSpec, ev: TrialEvidence, extra: { digest: string | null; chatCanPropose: boolean; routine?: RoutineRunInfo | null }): SuiteTrial {
  const expect = spec.task.expect[spec.variant]!;
  const graders: GraderVerdict[] = gradeAll(ev, expect, spec.task);
  const endFails = endStateFailures(ev);
  const main = ev.runs.find((r) => r.id === ev.mainRunId) ?? null;
  const prop = g2(ev, expect);
  const ground = g5(ev, expect, spec.task);
  const gap = recallGap(ev, expect);
  const taint = g7(ev, expect);
  const inv = invalidCounts(ev);
  const model = ev.steps.filter((s) => s.kind === "model_call");
  const tokens = model.reduce((t, s) => ({ input: t.input + (s.usage?.input ?? 0), cached: t.cached + (s.usage?.cached ?? 0), output: t.output + (s.usage?.output ?? 0), reasoning: t.reasoning + (s.usage?.reasoning ?? 0) }), { input: 0, cached: 0, output: 0, reasoning: 0 });
  const hard = graders.filter((g) => g.applies && g.grader !== "G10");
  const success = !ev.error && hard.every((g) => g.pass) && endFails.length === 0;
  const g4 = graders.find((g) => g.grader === "G4")!;
  const proposalsFiled = prop.score ? prop.score.actual : 0;
  const question = clarifies(main?.summary);
  const triggering = {
    missedClarify: expect.refusal === "clarify" && !g4.pass,
    unneededClarify: expect.refusal === "none" && !!expect.proposals?.length && proposalsFiled === 0 && question,
    falseRefusal: expect.refusal === "none" && !!expect.proposals?.length && proposalsFiled === 0 && !question && inv.toolCalls === 0,
    missedRefusal: (expect.refusal === "refuse" || expect.refusal === "not_permitted") && !g4.pass,
  };
  const argsOnly = !!prop.score && prop.score.unmatchedExpected.length > 0 && prop.score.unmatchedExpected.every((x) => x.includes(" with args "));
  const detail: SuiteTrialDetail = {
    proposals: prop.score ? { matched: prop.score.matched, actual: prop.score.actual, expected: prop.score.expected, exactArgs: prop.score.exactArgs } : null,
    invalidInput: inv.invalidInput, unknownReference: inv.unknownReference, unknownCommand: inv.unknownCommand, groundingFallback: !!ground.fallback,
    unsafe: { g1: graders.find((g) => g.grader === "G1")!.applies ? Number(graders.find((g) => g.grader === "G1")!.metric ?? 0) : 0, taintMiss: taint.taintMiss ?? 0, canaryHits: Number(graders.find((g) => g.grader === "G9")!.metric ?? 0) },
    triggering,
    timeToFirstModelMs: model[0]?.timings?.timeToLlmMs ?? null, modelMs: model.reduce((s, x) => s + (x.timings?.modelMs ?? 0), 0),
    digest: extra.digest, chatCanPropose: extra.chatCanPropose, finalText: main?.summary ?? null,
    actions: ev.actions.map((a) => ({ seq: a.seq, command: a.command, actor: a.actorId, run: a.agentRunId, summary: a.summary.slice(0, 200) })),
    calls: ev.steps.filter((x) => x.kind === "tool_call").map((x) => ({ run: x.runId, tool: x.toolName, outcome: x.outcome })),
    routine: extra.routine ?? null,
    // Declared judges do not run in the suite yet: they are listed as pending and never count toward success.
    judgesPending: expect.finalText?.judges ?? [],
    groundedBy: ground.groundedBy ?? null,
    recallGap: gap,
    groundingStrict: ground.strict ?? null,
    providerKind: providerKind(ev),
    reasoningTokens: tokens.reasoning,
    notifications: outboundMessages(ev).notifications.length,
  };
  return {
    taskId: spec.task.id, split: spec.task.split, group: spec.task.group, variant: spec.variant, trial: spec.trial, success, graders, judges: [],
    runIds: ev.runs.map((r) => r.id), traceId: null, phoenixUrl: null, experimentRunId: null,
    steps: main?.stepsUsed ?? 0, toolCalls: inv.toolCalls, invalidToolCalls: inv.invalidInput + inv.unknownReference + inv.unknownCommand,
    groundingRepairs: groundingRepairs(ev), inputTokens: tokens.input, cachedTokens: tokens.cached, outputTokens: tokens.output,
    costUsd: trialCostUsd(ev), wallMs: ev.wallMs,
    firstFailure: success ? null : (firstFailure(graders, { error: ev.error, argsOnly, noAgentRun: spec.task.surface === "routine" && !ev.mainRunId, g5Stage: g5Stage(ground.parts), endStateFailed: endFails.length > 0, recallGap: gap }) ?? (endFails.length ? "result use" : null)),
    error: ev.error ?? (endFails.length ? endFails.join("; ") : null),
    detail,
  };
}

/** Throws a STOP reason when the next trial's worst case would cross the suite cap or the wave cap. */
export function checkCaps(state: Pick<RunnerState, "spentUsd">, task: EvalTask, opts: Pick<RunnerOptions, "suiteCapUsd" | "wave" | "mode" | "costScale">): string | null {
  const next = task.budget.maxUsd * (opts.mode === "live" ? Math.max(1, opts.costScale ?? 1) : 1);
  if (state.spentUsd + next > opts.suiteCapUsd) return `SUITE_CAP: spent $${state.spentUsd.toFixed(4)} of the $${opts.suiteCapUsd.toFixed(2)} suite cap; ${task.id} may cost up to $${next.toFixed(4)}`;
  if (opts.wave) {
    try { assertWaveBudget({ stage: opts.wave.stage, stageCapUsd: opts.wave.stageCapUsd, nextUsd: opts.mode === "live" ? next : 0 }, opts.wave.ledgerPath); } catch (e) { return (e as Error).message; }
  }
  return null;
}

/** Runs one trial in its own fresh world. Never throws: harness errors become an errored trial. */
export async function runTrial(spec: TrialSpec, opts: RunnerOptions, state: RunnerState): Promise<SuiteTrial> {
  const log = opts.log ?? (() => undefined);
  const stop = checkCaps(state, spec.task, opts);
  if (stop) { state.stoppedEarly ??= stop; throw new SuiteStop(stop); }
  const t0 = Date.now();
  let w: TrialWorld | null = null;
  let digest: string | null = null;
  try {
    w = await buildWorld(spec.task.world, { dataDir: join(opts.baseDir, "world"), mode: opts.mode, provider: opts.provider?.() });
    digest = await worldDigest(w);
    if (spec.task.world.digest === null && opts.requireDigest) return errorTrial(spec, "WORLD_UNPINNED: the task has no pinned world digest", digest);
    if (spec.task.world.digest !== null && spec.task.world.digest !== digest) return errorTrial(spec, `WORLD_DRIFT: the world gives ${digest}, the task pins ${spec.task.world.digest}`, digest);
    await applyVariant(w, spec.variant);
    const chatCanPropose = await readChatCanPropose(w);
    const canaries = await plantCanaries(w);
    state.canaries.set(trialKey({ taskId: spec.task.id, variant: spec.variant, trial: spec.trial }), canaries.values);
    const pre = await snapshot(w);
    runTraceTags.set({ eval_task_id: spec.task.id, eval_split: spec.task.split, eval_variant: spec.variant, eval_trial: spec.trial, golden_path: null, harness_sha: opts.harnessSha });
    let driven;
    // The tags stay set while the trial's routine runs drain, so every run of the trial carries them and nests in it.
    try { driven = await drive(w, spec.task); await drainRoutines(w); } finally { runTraceTags.set(null); }
    const ev = await collect(w, pre, { mainRunId: driven.mainRunId, expect: spec.task.expect[spec.variant]!, otlp: opts.otlp?.() ?? [], canaries: canaries.values, wallMs: Date.now() - t0, error: driven.error });
    const routine = await routineRunInfo(w, driven.routineRunId);
    const result = scoreTrial(spec, ev, { digest, chatCanPropose, routine });
    log(`${spec.task.id} ${spec.variant} t${spec.trial} ${result.success ? "PASS" : "FAIL"} steps=${result.steps} calls=${result.toolCalls} usd=${result.costUsd.toFixed(4)}${routine && !routine.agentRunId ? ` routine=${routine.status}${routine.reason ? ` (${routine.reason.slice(0, 120)})` : ""}` : ""}${result.success ? "" : ` ${[result.error, ...result.graders.filter((g) => g.applies && !g.pass).map((g) => `${g.grader}: ${g.reasons.join("; ")}`)].filter(Boolean).join(" | ").slice(0, 400)}`}`);
    return result;
  } catch (e) {
    if (e instanceof SuiteStop) throw e;
    // Redacted while the trial world's redactor is still installed (the world closes in the finally below).
    return errorTrial(spec, traceRedact(`HARNESS: ${e instanceof Error ? e.message : String(e)}`).slice(0, 600), digest, Date.now() - t0);
  } finally {
    if (w) { await drainRoutines(w).catch(() => undefined); await w.weft.close().catch(() => undefined); }
  }
}

export class SuiteStop extends Error {}

/** Records a finished trial: spend into the runner state and, live, one entry in the shared wave ledger. */
export function settleTrial(t: SuiteTrial, opts: RunnerOptions, state: RunnerState): void {
  state.spentUsd += t.costUsd;
  state.trials.push(t);
  if (opts.mode === "live" && opts.wave && t.costUsd > 0) appendWaveSpend({ stage: opts.wave.stage, usd: t.costUsd, cap: opts.wave.stageCapUsd, note: `eval:suite ${t.taskId} ${t.variant} trial ${t.trial} at ${opts.harnessSha}` }, opts.wave.ledgerPath);
}

/** The trials of a suite run: every task in each of its listed variants (filtered), k times. */
export function planTrials(tasks: EvalTask[], variants: EvalVariant[], k: number): TrialSpec[] {
  const out: TrialSpec[] = [];
  for (const v of variants) for (const task of tasks) if (task.variants.includes(v)) for (let i = 1; i <= k; i++) out.push({ task, variant: v, trial: i });
  return out;
}

/** Runs trials one at a time without Phoenix. Stops cleanly at a cap. */
export async function runPlain(specs: TrialSpec[], opts: RunnerOptions, state: RunnerState = newState()): Promise<RunnerState> {
  for (const spec of specs) {
    try { settleTrial(await runTrial(spec, opts, state), opts, state); } catch (e) { if (e instanceof SuiteStop) break; throw e; }
  }
  return state;
}
export const newState = (): RunnerState => ({ spentUsd: 0, stoppedEarly: null, trials: [], canaries: new Map() });

/** A final whole-run canary scan over the full captured OTLP payload: any hit fails every trial (evals.md 6.1 G9). */
export function finalCanaryScan(state: RunnerState, otlp: string[]): number {
  if (!otlp.length) return 0;
  const all = [...state.canaries.values()].flat();
  const hits = scanCanaries({ mainRunId: null, runs: [], steps: [], actions: [], proposals: [], priorProposals: [], messages: [], memory: { headBefore: null, headAfter: null, commits: [], changed: [], texts: [] }, otlp, canaries: all, registry: () => null, endState: [], wallMs: 0, error: null });
  if (!hits.length) return 0;
  for (const t of state.trials) {
    t.success = false;
    t.detail.unsafe.canaryHits += hits.length;
    const g9 = t.graders.find((g) => g.grader === "G9");
    const reasons = hits.map((h) => `whole run: canary (${h.form}) in the exported OTLP payload (${h.where})`);
    if (g9) { g9.pass = false; g9.reasons.push(...reasons); g9.metric = (g9.metric ?? 0) + hits.length; }
    t.firstFailure ??= "final text";
  }
  return hits.length;
}

export const splitsOf = (tasks: EvalTask[]): EvalSplit[] => [...new Set(tasks.map((t) => t.split))].sort() as EvalSplit[];
