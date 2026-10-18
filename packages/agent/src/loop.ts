// runLoop (harness 4.2 to 4.6, SPEC 9.5): one function that cycles admission, assemble, model, dispatch, post and
// terminal, writing one timed run_steps row per stage. Code owns the stopping rules (harness 4.4, in order), the
// spend reservations (4.5), the recitation of the checklist inside the last function_call_output of each batch (4.3)
// and grounding of chat answers. The model only chooses the next calls and writes prose.
import type {
  AgentExecutor, AgentRunRow, HistoryItem, ModelProvider, ModelStepRequest, ModelStepResult, RunHandle, RunStepRow, RunStatus,
  SimClock, SpendLedger, StepTimings, TerminalReason, ToolOutcome, ToolSpec,
} from "@weft/contracts";
import { check, requestTrustOf, runEvidence, type RunEvidence } from "@weft/grounding";
import { canonicalJson } from "./canonical";
import { addUsage, reserveUsd, runCapScaleFor, stepCostUsd, usdToMicros, type Prices } from "./cost";
import { approxTokens } from "./context";
import { NOOP_LOOP_TRACE, recallDocs, runInputOf, traceRun, type LoopTrace } from "./otel";
import { frozenPrompt, prefixHash, type PromptKind } from "./prompts/index";
import type { NewStep, RunStore } from "./store";

export const BUDGETS = {
  chat: { steps: 12, usd: 0.1, minutes: 10, toolCallsPerStep: 8 },
  routine: { steps: 6, usd: 0.1, minutes: 10, toolCallsPerStep: 8 },
  routine_draft: { steps: 4, usd: 0.05, minutes: 5, toolCallsPerStep: 4 },
} as const;

/**
 * Chat answers by this model step (SPEC 12 L3: at most 4). The step before it gets a budget notice; at it, tool calls
 * are not run. An ungrounded answer gets one repair before this step and one more reserved for an answer at or after
 * it (that repaired answer is the run's last model step, with tool calls not run), then the grounded receipt. A batch
 * of identical re-reads after a repair is served from the run and does not count toward this step (once per run).
 * The hard budget above still bounds everything else. WEFT_CHAT_ANSWER_STEPS overrides it (1 to 12).
 */
export const CHAT_ANSWER_BY = 4;
/** Chat is read-only: it is not offered the run-feed post, its one write, so a question leaves no action row. */
export const CHAT_HIDDEN_TOOLS = new Set(["comms__post_update"]);

export function chatAnswerBy(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.WEFT_CHAT_ANSWER_STEPS);
  return Number.isInteger(n) && n >= 1 && n <= BUDGETS.chat.steps ? n : CHAT_ANSWER_BY;
}

export const MAX_OUTPUT_TOKENS = 8_000;
export const RETRY_OUTPUT_TOKENS = 16_000;
/** Harness 5.3: no agent kind or routine sees more than 16 tools. */
export const MAX_TOOLS = 16;

export function assertToolCap(count: number, what: string): void {
  if (count > MAX_TOOLS) throw new Error(`${what}: ${count} tools exceed the cap of ${MAX_TOOLS}`);
}
export const MAX_REQUEUES = 2;

/** Stored on the context step so a requeued run rebuilds the same request. */
export interface RunSetup {
  promptKind: PromptKind; allowlist: string[]; nonce: string; routineId: string | null; text: string; pack: true;
  /** Routine runs: the trigger the checklist is evaluated against, so a waiting run keeps it across a restart. */
  trigger?: Record<string, unknown>;
  /** The acting principal (telemetry user.id); never shown to the model. */
  principal?: string | null;
}

export interface ChecklistState { id: string; label: string; passed: boolean }

export interface LoopDeps {
  store: RunStore;
  executor: AgentExecutor;
  provider: ModelProvider;
  ledger: SpendLedger;
  clock: SimClock;
  prices: Prices;
  /** Code-owned checklist for routine runs (null for chat). */
  checklist: (run: AgentRunRow) => Promise<ChecklistState[] | null>;
  isCancelled: (runId: string) => boolean;
  signalFor: (runId: string) => AbortSignal | undefined;
  modelTimeoutMs: number;
  wallNow?: () => number;
}

function emptyTimings(): StepTimings {
  return { admissionMs: 0, assembleMs: 0, timeToLlmMs: 0, modelMs: 0, dispatchMs: 0, tokensPerSecond: null };
}

/** History from stored rows: the context pack, successful model items, tool output batches and notices. */
export function historyFromSteps(steps: RunStepRow[], provider: ModelProvider["id"]): HistoryItem[] {
  const out: HistoryItem[] = [];
  let batch: { parentN: number | null; outputs: { callId: string; name: string; output: string }[] } | null = null;
  const flush = () => {
    if (batch && batch.outputs.length) out.push({ kind: "tool_outputs", outputs: batch.outputs });
    batch = null;
  };
  for (const s of steps) {
    if (s.kind === "tool_call" && s.stage === "dispatch") {
      if (!batch || batch.parentN !== s.parentN) { flush(); batch = { parentN: s.parentN, outputs: [] }; }
      const r = s.result as { output?: string } | null;
      batch.outputs.push({ callId: s.callId ?? "", name: s.toolName ?? "", output: r?.output ?? "{}" });
      continue;
    }
    if (s.kind === "recite") continue; // the plan is already inside the last output of its batch
    flush();
    if (s.kind === "context" && (s.result as RunSetup | null)?.pack) out.push({ kind: "context", text: (s.result as RunSetup).text });
    else if (s.kind === "model_call" && s.outcome === "ok" && s.native !== null) out.push({ kind: "model", provider: ((s.result as { provider?: ModelProvider["id"] } | null)?.provider) ?? provider, native: s.native });
    else if (s.kind === "notice") {
      const r = s.result as { notice: "decision" | "event" | "budget" | "repair"; attrs: Record<string, string>; text: string };
      out.push({ kind: "notice", notice: r.notice, attrs: r.attrs, text: r.text });
    }
  }
  flush();
  return out;
}

export function setupOf(steps: RunStepRow[]): RunSetup | null {
  const s = steps.find((x) => x.kind === "context" && (x.result as RunSetup | null)?.pack);
  return s ? (s.result as RunSetup) : null;
}

/** "[x] propose tax.update_rate  [ ] draft reply | steps 2/6 | $0.0011" (harness 4.3), under about 150 tokens. */
export function renderPlan(items: ChecklistState[] | null, stepsUsed: number, stepBudget: number, usd: number): string {
  const parts: string[] = [];
  if (items && items.length) parts.push(items.map((i) => `[${i.passed ? "x" : " "}] ${i.label}`).join("  "));
  parts.push(`steps ${stepsUsed}/${stepBudget}`, `$${usd.toFixed(4)}`);
  const s = parts.join(" | ");
  return s.length > 600 ? s.slice(0, 597) + "..." : s;
}

/** The function output the model sees: the outcome as canonical JSON, with _weft_plan on the last one of a batch. */
export function outputFor(outcome: ToolOutcome, plan: string | null): string {
  return canonicalJson(plan === null ? outcome : { ...outcome, _weft_plan: plan });
}

function refusal(code: string, message: string, hint: string | null = null): ToolOutcome {
  return { ok: false, refusal: { code: code as never, message, hint, example: null }, tainted: false };
}

function outcomeCode(o: ToolOutcome): RunStepRow["outcome"] {
  if (!o.ok) return `refused:${o.refusal.code}`;
  if (o.status === "pending_approval") return `pending:${o.proposalId}`;
  return "ok";
}

interface Terminal { status: RunStatus; reason: TerminalReason; summary: string | null; fallback?: boolean }

function parseArgs(json: string): unknown {
  try { return json.trim() ? JSON.parse(json) : {}; } catch { return undefined; }
}

/** A read's identity: the wire name and the canonical arguments. Unparseable arguments have none and never match. */
function readKey(name: string, args: unknown): string | null {
  return args === undefined ? null : `${name} ${canonicalJson(args ?? {})}`;
}

/**
 * Drive one run until it reaches waiting or a terminal state. Safe to call again after a requeue: the history is
 * rebuilt from the run's own rows, and the executor dedupes calls on (run, call id).
 */
export async function runLoop(deps: LoopDeps, handle: RunHandle): Promise<AgentRunRow> {
  // Telemetry (wave 4): one AGENT span per call, wrapping the loop below; a missing run or setup throws untraced.
  const r0 = await deps.store.getRun(handle.runId);
  const st0 = r0 && ["queued", "running", "waiting"].includes(r0.status) ? await deps.store.steps(r0.id) : [];
  const s0 = r0 ? setupOf(st0) : null;
  if (!r0 || !s0) return driveLoop(deps, handle, NOOP_LOOP_TRACE);
  return traceRun({
    run: r0, promptKind: s0.promptKind, allowlist: s0.allowlist, routineId: s0.routineId, principal: s0.principal ?? null,
    input: runInputOf(s0.text), prompt: frozenPrompt(s0.promptKind),
    // The run-start recall is shown once, on the segment that first assembles the pack (not again after a wake).
    recall: st0.some((s) => s.kind === "model_call") ? null : recallDocs(s0.text),
  }, (lt) => driveLoop(deps, handle, lt));
}

/**
 * Telemetry for the runtime's zero-token wake (runtime.ts wake), which finishes a waiting run in code without runLoop:
 * a short AGENT segment with a terminal CHAIN, joined to the run's other segments by weft.run_id and session.id.
 * Never throws: telemetry must not change how a wake ends.
 */
export async function traceWakeSegment(store: RunStore, runId: string, items: ChecklistState[] | null): Promise<void> {
  try {
    const run = await store.getRun(runId);
    const s = run ? setupOf(await store.steps(runId)) : null;
    if (!run || !s) return;
    await traceRun({
      run, promptKind: s.promptKind, allowlist: s.allowlist, routineId: s.routineId, principal: s.principal ?? null,
      input: runInputOf(s.text), prompt: frozenPrompt(s.promptKind), segment: "zero_token_wake",
    }, (lt) => lt.stage("terminal", {
      "weft.status": run.status, "weft.terminal_reason": run.terminalReason, "weft.zero_token_wake": true,
      "weft.checklist_passed": items ? items.filter((i) => i.passed).length : null, "weft.checklist_total": items ? items.length : null,
    }, async () => run));
  } catch { /* telemetry only */ }
}

async function driveLoop(deps: LoopDeps, handle: RunHandle, lt: LoopTrace): Promise<AgentRunRow> {
  const { store, executor, provider, ledger } = deps;
  const wall = deps.wallNow ?? Date.now;
  let run = await store.getRun(handle.runId);
  if (!run) throw new Error(`runLoop: no agent_runs row ${handle.runId}`);
  if (!["queued", "running", "waiting"].includes(run.status)) return run;
  const steps = await store.steps(run.id);
  const setup = setupOf(steps);
  if (!setup) throw new Error(`runLoop: run ${run.id} has no context step`);
  const budget = BUDGETS[setup.promptKind];
  const stepBudget = run.budget.steps || budget.steps;
  // A provider or model priced far above Luna (Claude, Terra) gets a scaled run cap, here and in the ledger, or no step fits.
  const runCapScale = runCapScaleFor(provider.id, run.model);
  const usdBudget = (run.budget.usd || budget.usd) * runCapScale;
  const prompt = frozenPrompt(setup.promptKind);
  assertToolCap(setup.allowlist.length, `runLoop: run ${run.id} allowlist`);
  const chat = setup.promptKind === "chat";
  const answerBy = chat ? Math.min(chatAnswerBy(), stepBudget) : stepBudget;
  const allowlist = (await executor.toolAllowlist?.(handle, setup.allowlist)) ?? setup.allowlist;   // wave 4: per-action deny
  const tools: ToolSpec[] = executor.registry.toolSpecs({ agentKind: run.kind, allowlist })
    .filter((t) => !(chat && CHAT_HIDDEN_TOOLS.has(t.name)));
  const offered = new Set(tools.map((t) => t.name));
  assertToolCap(tools.length, `runLoop: run ${run.id} tool specs`);
  const settings = { model: run.model, effort: run.effort, parallelToolCalls: true, store: false, toolChoice: "auto" };
  const pHash = prefixHash(prompt, tools, settings);
  let history = historyFromSteps(steps, provider.id);
  const startedWall = wall();
  const failuresByTool = new Map<string, number>();
  let corrected = steps.some((s) => s.kind === "notice" && (s.result as { notice?: string } | null)?.notice === "repair");
  // Chat grounding repairs (FM3): one before the answer-by step, one reserved for an answer at or after it.
  const repairAt = steps.flatMap((s) => {
    const a = s.kind === "notice" ? (s.result as { attrs?: { code?: string; at?: string } } | null)?.attrs : undefined;
    return a?.code === "UNGROUNDED" ? [a.at === "last" ? "last" : "early"] : [];
  });
  let earlyRepairUsed = repairAt.includes("early");
  let lastRepairUsed = repairAt.includes("last");
  // A post-repair batch of identical re-reads served from the run moves the answer-by step back by one, once.
  let rereadRefunded = steps.some((s) => s.kind === "recite" && (s.result as { served?: boolean } | null)?.served === true);
  let answerAt = answerBy + (rereadRefunded ? 1 : 0);
  // Grounding evidence beyond the tool results: the person's own request and the run clock. The request counts only
  // when the run was untainted before its first model step (a tagged thread or a tainted suggestion carries other
  // people's text into it). The decision is stored on every chat assemble row; runEvidence reads the first one back, so
  // a resumed segment keeps it and the eval suite's G5 sees the same decision. The pack row is also an assemble row
  // but carries no decision, so it is skipped (before round 2 it was found first, and a resumed segment lost trust).
  const storedTrust = requestTrustOf(steps);
  const requestTrusted = !chat ? false
    : storedTrust !== null ? storedTrust
    : steps.some((s) => s.kind === "model_call") ? false
    : !(await executor.runState(handle).catch(() => ({ tainted: true }))).tainted;
  const clockAtStart = deps.clock.now();

  await store.updateRun(run.id, { status: "running" });
  run = { ...run, status: "running" };

  const append = async (s: Partial<NewStep> & Pick<NewStep, "stage" | "kind">) => {
    const row = await store.appendStep(run!.id, {
      parentN: null, callId: null, toolName: null, toolArgs: null, outcome: null, result: null, native: null, usage: null,
      costUsdMicros: 0, attempt: 1, requestId: null, prefixHash: null, timings: null, ...s,
    });
    // Rows with no span of their own around them get a CHAIN span after the fact (telemetry is a projection of the rows).
    if (row.stage === "admission" || row.stage === "assemble" || row.stage === "post") lt.row(row);
    return row;
  };

  const finish = (t: Terminal): Promise<AgentRunRow> => lt.stage("terminal", { "weft.status": t.status, "weft.terminal_reason": t.reason, ...(t.fallback ? { "weft.grounding_fallback": true } : {}) }, async (span) => {
    const t0 = wall();
    const terminalStates: RunStatus[] = ["done", "failed", "refused", "escalated", "expired", "cancelled"];
    const endedAt = terminalStates.includes(t.status) ? deps.clock.now() : null;
    const state = await lt.guard("taint", { runId: run!.id }, () => executor.runState(handle).catch(() => null), (s) => ({
      "weft.tainted": s?.tainted ?? run!.tainted, "weft.tainted_by": s?.taintedBy ?? run!.taintedBy, "weft.pending_proposals": s?.pendingProposalIds.length ?? null,
    }));
    await store.updateRun(run!.id, {
      status: t.status, terminalReason: t.reason, summary: t.summary ?? run!.summary, endedAt,
      tainted: state?.tainted ?? run!.tainted, taintedBy: state?.taintedBy ?? run!.taintedBy,
    });
    const row = await append({ stage: "terminal", kind: "verify", outcome: "ok", result: { status: t.status, reason: t.reason, ms: wall() - t0, ...(t.fallback ? { groundingFallback: true } : {}) }, timings: emptyTimings() });
    span.set({ "weft.step_n": row.n });
    return (await store.getRun(run!.id))!;
  });

  // What a chat answer is checked against, from this run's own rows (one helper shared with the eval suite's G5):
  // its results and proposals, the trusted request, the clock, and its echoed arguments. Model-authored text (run
  // feed updates) is never evidence: the answer cannot ground itself on it.
  const evidence = async () => runEvidence(await store.steps(run!.id), { now: clockAtStart });
  const allToolResults = async (): Promise<unknown[]> => (await evidence()).results;
  // Reads this run already made, by tool and canonical arguments (served again after a repair instead of re-run).
  const reads = new Map<string, ToolOutcome>();
  for (const r of steps) {
    const o = (r.result as { outcome?: ToolOutcome } | null)?.outcome;
    const k = r.kind === "tool_call" && r.toolName ? readKey(r.toolName, r.toolArgs) : null;
    if (k !== null && o && o.ok && o.status === "done" && o.actionSeq === null && !(r.result as { servedFrom?: string } | null)?.servedFrom) reads.set(k, o);
  }

  for (;;) {
    // Rule 1: cancelled by a person.
    if (deps.isCancelled(run.id)) return finish({ status: "cancelled", reason: "CANCELLED", summary: "Cancelled by a person." });

    // ---- admission
    const tAdm = wall();
    run = (await store.getRun(run.id))!;
    // Template steps (the deterministic fallback) are free and bounded by their script, so only model steps count.
    if (run.stepsUsed >= stepBudget && run.model !== "template") return finish({ status: "escalated", reason: "BUDGET_EXCEEDED", summary: `Stopped at the step budget (${stepBudget} model steps).` });
    if (wall() - startedWall > budget.minutes * 60_000) {
      return finish({ status: "escalated", reason: "BUDGET_EXCEEDED", summary: "Stopped at the wall-clock budget." });
    }
    // Chat: the step before the answer-by step tells the model to answer now (gate report item 3).
    if (chat && run.stepsUsed === answerAt - 1 && answerAt > 1 && !history.some((h) => h.kind === "notice" && h.notice === "budget" && h.attrs.code === "ANSWER_NOW")) {
      const notice = { notice: "budget" as const, attrs: { n: setup.nonce, code: "ANSWER_NOW" }, text: "This is your last step. Write the answer now from the tool results above; any tool call in this step is not run." };
      await append({ stage: "post", kind: "notice", result: notice });
      history = [...history, { kind: "notice", ...notice }];
    }
    let attempt = 1;
    let maxOut = MAX_OUTPUT_TOKENS;
    let incompleteCount = 0;
    let result: ModelStepResult | null = null;
    let modelStepRow: RunStepRow | null = null;
    while (result === null) {
      const estInput = approxTokens(prompt) + approxTokens(JSON.stringify(tools)) + approxTokens(JSON.stringify(history));
      // A provider that is not live (scripted, templates) spends nothing: it still reserves and settles, at zero.
      // Reserve against the max_tokens the request will really carry (Claude raises it to its thinking floor).
      const sentOut = provider.outputTokensFor?.(maxOut) ?? maxOut;
      const reserveMicros = provider.live ? usdToMicros(reserveUsd(estInput, sentOut, deps.prices)) : 0;
      if (provider.live && run.costUsdMicros + reserveMicros > usdBudget * 1e6) {
        await append({ stage: "admission", kind: "verify", outcome: "refused:BUDGET_EXCEEDED", result: { cap: "run", reserveMicros }, timings: { ...emptyTimings(), admissionMs: wall() - tAdm } });
        return finish({ status: "escalated", reason: "BUDGET_EXCEEDED", summary: "Stopped before the per-run spend cap." });
      }
      const rsv = await ledger.reserve({ runId: run.id, usdMicros: reserveMicros, model: run.model, live: provider.live, runCapScale });
      const admissionMs = wall() - tAdm;
      if (!rsv.ok) {
        await append({ stage: "admission", kind: "verify", outcome: "refused:BUDGET_EXCEEDED", result: { cap: rsv.cap, spentMicros: rsv.spentMicros, reserveMicros }, timings: { ...emptyTimings(), admissionMs } });
        return finish({ status: "escalated", reason: "BUDGET_EXCEEDED", summary: `Stopped by the ${rsv.cap} spend cap.` });
      }
      await append({ stage: "admission", kind: "verify", outcome: "ok", attempt, result: { reservationId: rsv.reservationId, reserveMicros, estInputTokens: estInput }, timings: { ...emptyTimings(), admissionMs } });

      // ---- assemble
      const tAsm = wall();
      const stepTimer = AbortSignal.timeout(deps.modelTimeoutMs);
      const cancel = deps.signalFor(run.id);
      const req: ModelStepRequest = {
        runId: run.id, agentKind: run.kind, model: run.model, frozenPrompt: prompt, tools, toolChoice: { mode: "auto" }, history,
        effort: run.effort, maxOutputTokens: maxOut, cacheKey: run.cacheKey,
        signal: cancel ? AbortSignal.any([cancel, stepTimer]) : stepTimer,
      };
      const assembleMs = wall() - tAsm;
      await append({ stage: "assemble", kind: "context", attempt, prefixHash: pHash, result: { items: history.length, estInputTokens: estInput, ...(chat ? { requestTrusted } : {}) }, timings: { ...emptyTimings(), assembleMs } });

      // ---- model
      const tModel = wall();
      const timeToLlmMs = tModel - tAdm;
      const modelStage = lt.begin("model", { "weft.attempt": attempt, "weft.prefix_hash": pHash });
      let res: ModelStepResult;
      try {
        res = await lt.llm(modelStage, req, provider.id, () => provider.step(req));
      } catch (e) {
        modelStage.fail(e instanceof Error ? e.message : String(e));
        modelStage.end();
        await ledger.settle(rsv.reservationId, 0);
        throw e; // scripted expectation failures and programming errors surface to the caller
      }
      // The loop's own step timer fired (not a cancel): that is a retryable timeout, whatever the provider called it.
      if (res.stop === "error" && stepTimer.aborted && !cancel?.aborted) {
        res = { ...res, error: { code: "PROVIDER_TIMEOUT", message: `no answer within the ${deps.modelTimeoutMs} ms step budget`, retryable: true } };
      }
      const modelMs = wall() - tModel;
      const usd = stepCostUsd(res.usage, deps.prices);
      const actualMicros = provider.live ? usdToMicros(usd) : 0;
      lt.llmSettled(res, deps.prices, actualMicros);
      if (res.stop === "error" && res.usage.input === 0) await ledger.settle(rsv.reservationId, provider.live ? usdToMicros(reserveUsd(estInput, 0, deps.prices)) : 0);
      else await ledger.settle(rsv.reservationId, actualMicros);
      const tokens = addUsage(run.tokens, res.usage);
      const cost: number = run.costUsdMicros + (res.stop === "error" && res.usage.input === 0 && provider.live ? usdToMicros(reserveUsd(estInput, 0, deps.prices)) : actualMicros);
      run = { ...run, tokens, costUsdMicros: cost };
      await store.updateRun(run.id, { tokens, costUsdMicros: cost });
      const ok = res.stop === "tool_calls" || res.stop === "final";
      modelStepRow = await append({
        stage: "model", kind: "model_call", attempt, outcome: ok ? "ok" : "error", native: ok ? res.native : null,
        result: { provider: provider.id, stop: res.stop, text: res.text.slice(0, 2000), toolCalls: res.toolCalls.map((c) => c.name), error: res.error ?? null, refusal: res.refusal ?? null, servedBy: res.servedBy },
        usage: res.usage, costUsdMicros: actualMicros, requestId: res.requestId, prefixHash: pHash,
        timings: { admissionMs, assembleMs, timeToLlmMs, modelMs, dispatchMs: 0, tokensPerSecond: modelMs > 0 && res.usage.output > 0 ? Math.round((res.usage.output / modelMs) * 1000) : null },
      });
      modelStage.set({ "weft.step_n": modelStepRow.n, "weft.outcome": ok ? "ok" : "error", "weft.stop": res.stop, "weft.request_id": res.requestId });
      if (res.stop === "error") modelStage.fail(`${res.error?.code ?? "error"}: ${res.error?.message ?? ""}`);
      modelStage.end();

      if (res.stop === "refusal") return finish({ status: "refused", reason: "REFUSED", summary: res.refusal?.text ?? res.text });
      if (res.stop === "incomplete") {
        incompleteCount++;
        if (incompleteCount >= 2) return finish({ status: "failed", reason: "MODEL_INCOMPLETE", summary: "The model ran out of output tokens twice." });
        maxOut = RETRY_OUTPUT_TOKENS;
        attempt++;
        continue;
      }
      if (res.stop === "error") {
        const consecutiveErrors: number = run.consecutiveErrors + 1;
        run = { ...run, consecutiveErrors };
        await store.updateRun(run.id, { consecutiveErrors });
        if (res.error?.code === "PROVIDER_CONFIG") return finish({ status: "failed", reason: "PROVIDER_DOWN", summary: "The model provider is not configured or refused the credentials." });
        if (res.error?.retryable && attempt < 3) { attempt++; continue; }
        if (consecutiveErrors >= 3 || !res.error?.retryable) return finish({ status: res.error?.retryable ? "failed" : "escalated", reason: res.error?.retryable ? "PROVIDER_DOWN" : "REPEATED_ERRORS", summary: `The model step failed: ${res.error?.code ?? "error"}.` });
        attempt++;
        continue;
      }
      result = res;
    }

    const stepsUsed = run.stepsUsed + 1;
    run = { ...run, stepsUsed, consecutiveErrors: 0 };
    await store.updateRun(run.id, { stepsUsed, consecutiveErrors: 0 });
    history = [...history, { kind: "model", provider: provider.id, native: result.native }];

    // Chat after a grounding repair: a batch that only repeats reads this run already made is served from the run
    // (nothing is re-run) and, once per run, does not count toward the answer-by step (FM3, CH-02).
    const served = chat && (earlyRepairUsed || lastRepairUsed) && !rereadRefunded && result.toolCalls.length > 0
      ? result.toolCalls.map((c) => { const k = readKey(c.name, parseArgs(c.argumentsJson)); return k === null ? null : reads.get(k) ?? null; })
      : null;
    if (served && served.every((o) => o !== null)) {
      rereadRefunded = true;
      answerAt += 1;
      const batch = served as ToolOutcome[];
      const items = await deps.checklist(run);
      const plan = renderPlan(items, run.stepsUsed, stepBudget, run.costUsdMicros / 1e6);
      const toolOutputs = result.toolCalls.map((c, i) => ({
        callId: c.callId, name: c.name,
        output: canonicalJson({ ...batch[i]!, _weft_served: "Same call and arguments as earlier in this run: this is that stored result, not run again.", ...(i === batch.length - 1 ? { _weft_plan: plan } : {}) }),
      }));
      for (let i = 0; i < toolOutputs.length; i++) {
        const c = result.toolCalls[i]!;
        await append({
          stage: "dispatch", kind: "tool_call", parentN: modelStepRow!.n, callId: c.callId, toolName: c.name, toolArgs: parseArgs(c.argumentsJson), outcome: "ok",
          result: { output: toolOutputs[i]!.output, outcome: batch[i]!, servedFrom: (batch[i] as { resultId?: string }).resultId ?? null }, timings: emptyTimings(),
        });
      }
      history = [...history, { kind: "tool_outputs", outputs: toolOutputs }];
      await append({ stage: "post", kind: "recite", result: { plan, served: true, ms: 0, batchDispatchMs: 0 }, timings: emptyTimings() });
      continue;
    }

    // Chat at its answer-by step: the calls are not run; the person gets the grounded summary of what was read.
    // Text that comes with tool calls is a preamble ("Next I will read X"), never the answer, so it is not used.
    if (chat && result.toolCalls.length > 0 && run.stepsUsed >= answerAt) {
      return finish({ status: "done", reason: "DONE", summary: await groundedFallback(null, evidence), fallback: true });
    }

    // ---- dispatch
    if (result.toolCalls.length > 0) {
      const tDisp = wall();
      const dispatchStage = lt.begin("dispatch", { "weft.batch_size": result.toolCalls.length, "weft.parent_n": modelStepRow!.n });
      const toolSpans: ReturnType<LoopTrace["tool"]>[] = [];
      const outputs: { callId: string; name: string; outcome: ToolOutcome; row: NewStep }[] = [];
      let index = 0;
      for (const call of result.toolCalls) {
        index++;
        if (deps.isCancelled(run.id)) break;
        let outcome: ToolOutcome;
        let args: unknown = null;
        let threw = false;
        const tCall = wall();
        const toolSpan = lt.tool(dispatchStage, call.name, call.callId);
        toolSpans.push(toolSpan);
        if (!offered.has(call.name)) {
          // Defense in depth for harness 5.3: never dispatch a tool the run was not given (the executor refuses it too).
          outcome = refusal("UNAVAILABLE", `${call.name} is not one of this run's tools; it was not run.`, "Call only the tools listed for this run.");
        } else if (index > budget.toolCallsPerStep) {
          outcome = refusal("CALL_BUDGET", `At most ${budget.toolCallsPerStep} tool calls per step; this call was not run.`, "Emit fewer calls per turn.");
        } else {
          try {
            args = call.argumentsJson.trim() ? JSON.parse(call.argumentsJson) : {};
          } catch {
            args = null;
          }
          if (args === null && call.argumentsJson.trim() !== "null") {
            outcome = refusal("INVALID_INPUT", "The arguments are not valid JSON.", "Send one JSON object that matches the tool schema.");
          } else {
            try {
              outcome = await toolSpan.run(() => executor.exec(handle, { callId: call.callId, command: call.name, args }));
            } catch (e) {
              threw = true;
              outcome = refusal("INTERNAL", `The executor failed: ${e instanceof Error ? e.message.slice(0, 200) : "error"}`);
            }
          }
        }
        toolSpan.outcome(outcome, args, threw);
        if (!outcome.ok) failuresByTool.set(call.name, (failuresByTool.get(call.name) ?? 0) + 1);
        else if (outcome.status === "done" && outcome.actionSeq === null) { const k = readKey(call.name, args); if (k !== null) reads.set(k, outcome); }
        const consecutiveErrors: number = outcome.ok ? 0 : run.consecutiveErrors + 1;
        run = { ...run, consecutiveErrors };
        outputs.push({
          callId: call.callId, name: call.name, outcome,
          row: {
            stage: "dispatch", kind: "tool_call", parentN: modelStepRow!.n, callId: call.callId, toolName: call.name, toolArgs: args, outcome: outcomeCode(outcome),
            result: null, native: null, usage: null, costUsdMicros: 0, attempt: 1, requestId: null, prefixHash: null,
            timings: { ...emptyTimings(), dispatchMs: wall() - tCall },
          },
        });
      }
      // Every call id gets an output, including calls skipped by a cancellation.
      for (const call of result.toolCalls.slice(outputs.length)) {
        const skipped = lt.tool(dispatchStage, call.name, call.callId);
        skipped.outcome(refusal("CANCELLED", "The run was cancelled before this call ran."), null);
        toolSpans.push(skipped);
        outputs.push({ callId: call.callId, name: call.name, outcome: refusal("CANCELLED", "The run was cancelled before this call ran."), row: { stage: "dispatch", kind: "tool_call", parentN: modelStepRow!.n, callId: call.callId, toolName: call.name, toolArgs: null, outcome: "error", result: null, native: null, usage: null, costUsdMicros: 0, attempt: 1, requestId: null, prefixHash: null, timings: emptyTimings() } });
      }
      await store.updateRun(run.id, { consecutiveErrors: run.consecutiveErrors });
      dispatchStage.end();

      // ---- post: recite from observed state into the last output of the batch
      const tPost = wall();
      const items = await deps.checklist(run);
      if (items) await store.updateRun(run.id, { checklist: items });
      const plan = renderPlan(items, run.stepsUsed, stepBudget, run.costUsdMicros / 1e6);
      const toolOutputs = outputs.map((o, i) => ({ callId: o.callId, name: o.name, output: outputFor(o.outcome, i === outputs.length - 1 ? plan : null) }));
      for (let i = 0; i < outputs.length; i++) {
        const row = await append({ ...outputs[i]!.row, result: { output: toolOutputs[i]!.output, outcome: outputs[i]!.outcome } });
        toolSpans[i]?.end(row);
      }
      history = [...history, { kind: "tool_outputs", outputs: toolOutputs }];
      await append({ stage: "post", kind: "recite", result: { plan, ms: wall() - tPost, batchDispatchMs: tPost - tDisp }, timings: { ...emptyTimings(), dispatchMs: tPost - tDisp } });

      if (deps.isCancelled(run.id)) return finish({ status: "cancelled", reason: "CANCELLED", summary: "Cancelled by a person." });
      // Rule 5: 3 consecutive errors or 3 failures of the same tool.
      if (run.consecutiveErrors >= 3 || [...failuresByTool.values()].some((n) => n >= 3)) {
        return finish({ status: "escalated", reason: "REPEATED_ERRORS", summary: "Stopped after repeated tool errors." });
      }
      continue;
    }

    // ---- the model ended its turn with no function calls (rule 6)
    const text = result.text.trim();
    if (setup.promptKind === "chat") {
      const g = await lt.stage("post", {}, () => lt.guard("grounding", text, async () => { const ev = await evidence(); return check(text, ev.results, ev.opts); }, (r) => ({
        "weft.grounded": r.ok, "weft.unmatched": r.offending.join(", "),
      })));
      if (g.ok) return finish({ status: "done", reason: "DONE", summary: text });
      // One repair before the answer-by step, and one reserved for an answer at or after it, inside the hard budget.
      const last = run.stepsUsed >= answerAt;
      const canRepair = last ? !lastRepairUsed && run.stepsUsed < stepBudget : !earlyRepairUsed;
      if (canRepair) {
        corrected = true;
        if (last) lastRepairUsed = true;
        else earlyRepairUsed = true;
        const notice = {
          notice: "repair" as const, attrs: { n: setup.nonce, code: "UNGROUNDED", ...(last ? { at: "last" } : {}) },
          text: last
            ? `These numbers do not match any tool result in this run: ${g.offending.join(", ")}. This is your last step: answer again from the tool results above without them; any tool call is not run.`
            : `These numbers do not match any tool result in this run: ${g.offending.join(", ")}. Read the source or remove them, then answer again.`,
        };
        await append({ stage: "post", kind: "notice", result: notice });
        history = [...history, { kind: "notice", ...notice }];
        continue;
      }
      return finish({ status: "done", reason: "DONE", summary: await groundedFallback(text, evidence), fallback: true });
    }
    const items = await deps.checklist(run);
    if (items) await store.updateRun(run.id, { checklist: items });
    const state = await executor.runState(handle);
    const allPass = !items || items.every((i) => i.passed);
    if (allPass) {
      // Harness 4.3: what a person reads about a routine run comes from its results and proposals, never the prose.
      if (state.pendingProposalIds.length > 0) return finish({ status: "waiting", reason: "WAITING_APPROVAL", summary: await routineSummary(allToolResults) });
      return finish({ status: "done", reason: "DONE", summary: await routineSummary(allToolResults) });
    }
    if (!corrected) {
      corrected = true;
      const failing = items!.filter((i) => !i.passed).map((i) => i.label);
      const notice = { notice: "repair" as const, attrs: { n: setup.nonce, code: "NOT_DONE" }, text: `The checklist is not complete. Still open: ${failing.join("; ")}.` };
      await append({ stage: "post", kind: "notice", result: notice });
      history = [...history, { kind: "notice", ...notice }];
      continue;
    }
    const failing = (items ?? []).filter((i) => !i.passed).map((i) => i.label);
    return finish({ status: "escalated", reason: "NOT_DONE", summary: `The routine ended with open checklist items: ${failing.join("; ") || "unknown"}. ${await routineSummary(allToolResults)}` });
  }
}

/** A routine run's summary from its effects and proposals (harness 4.3), e.g. "Proposed Update CA SUI ... (prp_0001)". */
// Proposals come first (they are what a person must decide), and a cut list says how many it left out, so a run with
// eight saved notes never hides its proposals (review of e83fd89, round 2 O2).
export const ROUTINE_SUMMARY_PARTS = 8;
export async function routineSummary(results: () => Promise<unknown[]>): Promise<string> {
  const rs = (await results()) as { resultId?: string; summary?: string; proposalId?: string; title?: string; actionSeq?: number | null; existing?: boolean }[];
  // A call that matched an open proposal filed nothing (fix group duplicate-proposal): the summary says it was already there.
  const seen = new Set<string>();
  const proposed = rs.filter((r) => r.proposalId && !seen.has(r.proposalId) && seen.add(r.proposalId));
  const parts = [
    ...proposed.map((r) => `${r.existing ? "Already waiting for approval:" : "Proposed"} ${r.title ?? "a change"} (${r.proposalId})`),
    ...rs.filter((r) => r.resultId && r.actionSeq !== null && r.actionSeq !== undefined).map((r) => `${r.summary ?? "Done"} (#${r.actionSeq})`),
  ];
  if (!parts.length) return "Checked; nothing needed a change.";
  const shown = parts.slice(0, ROUTINE_SUMMARY_PARTS).join("; ");
  return parts.length > ROUTINE_SUMMARY_PARTS ? `${shown}; and ${parts.length - ROUTINE_SUMMARY_PARTS} more` : shown;
}

const MAX_RECEIPT_LINES = 8;

/** Sentences of a draft answer, split after ., ! or ? followed by whitespace, and at line breaks. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9*"(\[-])|\n+/).map((x) => x.trim()).filter(Boolean);
}

/**
 * The grounded receipt (harness 4.8) when an answer stays ungrounded. It leads with what can be shown: the draft's
 * sentences that pass the checker on their own, with a count of those left out, then the results it read. The whole
 * receipt passes the same checker; a line that does not is dropped, and if the joined text still fails, only the
 * results are shown.
 */
async function groundedFallback(draft: string | null, ev: () => Promise<RunEvidence>): Promise<string> {
  const { results, opts } = await ev();
  const ok = (t: string) => check(t, results, opts).ok;
  const rs = results as { resultId?: string; summary?: string; proposalId?: string; title?: string }[];
  const lines = rs.slice(0, MAX_RECEIPT_LINES)
    .map((r) => (r.resultId ? `- ${r.summary ?? "result"} (${r.resultId})` : `- ${r.title ?? "proposal"} (${r.proposalId})`))
    .filter(ok);
  const read = lines.length ? `What I read:\n${lines.join("\n")}` : "";
  const parts = draft ? sentences(draft) : [];
  const kept = parts.filter(ok);
  const left = parts.length - kept.length;
  const candidates: string[] = [];
  if (kept.length) {
    const note = left > 0 ? `I left out ${left} statement${left === 1 ? "" : "s"} whose figures I could not match to a record in this run.` : "";
    candidates.push([kept.join(" "), note, read].filter(Boolean).join("\n\n"));
  }
  if (lines.length) {
    const lead = draft
      ? "I could not match the figures in my answer to the records I read, so here is what those records say."
      : "I ran out of steps before I could finish the answer, so here is what the records I read say.";
    candidates.push(`${lead}\n\n${read}`);
  }
  for (const c of candidates) if (ok(c)) return c;
  return "I could not verify my answer against any tool result, so I am not showing it.";
}
