// runLoop (harness 4.2 to 4.6, SPEC 9.5): one function that cycles admission, assemble, model, dispatch, post and
// terminal, writing one timed run_steps row per stage. Code owns the stopping rules (harness 4.4, in order), the
// spend reservations (4.5), the recitation of the checklist inside the last function_call_output of each batch (4.3)
// and grounding of chat answers. The model only chooses the next calls and writes prose.
import type {
  AgentExecutor, AgentRunRow, HistoryItem, ModelProvider, ModelStepRequest, ModelStepResult, RunHandle, RunStepRow, RunStatus,
  SimClock, SpendLedger, StepTimings, TerminalReason, ToolOutcome, ToolSpec,
} from "@weft/contracts";
import { check } from "@weft/grounding";
import { canonicalJson } from "./canonical";
import { addUsage, reserveUsd, stepCostUsd, usdToMicros, type Prices } from "./cost";
import { approxTokens } from "./context";
import { frozenPrompt, prefixHash, type PromptKind } from "./prompts/index";
import type { NewStep, RunStore } from "./store";

export const BUDGETS = {
  chat: { steps: 12, usd: 0.1, minutes: 10, toolCallsPerStep: 8 },
  routine: { steps: 6, usd: 0.1, minutes: 10, toolCallsPerStep: 8 },
  routine_draft: { steps: 4, usd: 0.05, minutes: 5, toolCallsPerStep: 4 },
} as const;

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

interface Terminal { status: RunStatus; reason: TerminalReason; summary: string | null }

/**
 * Drive one run until it reaches waiting or a terminal state. Safe to call again after a requeue: the history is
 * rebuilt from the run's own rows, and the executor dedupes calls on (run, call id).
 */
export async function runLoop(deps: LoopDeps, handle: RunHandle): Promise<AgentRunRow> {
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
  const usdBudget = run.budget.usd || budget.usd;
  const prompt = frozenPrompt(setup.promptKind);
  assertToolCap(setup.allowlist.length, `runLoop: run ${run.id} allowlist`);
  const tools: ToolSpec[] = executor.registry.toolSpecs({ agentKind: run.kind, allowlist: setup.allowlist });
  const offered = new Set(tools.map((t) => t.name));
  assertToolCap(tools.length, `runLoop: run ${run.id} tool specs`);
  const settings = { model: run.model, effort: run.effort, parallelToolCalls: true, store: false, toolChoice: "auto" };
  const pHash = prefixHash(prompt, tools, settings);
  let history = historyFromSteps(steps, provider.id);
  const startedWall = wall();
  const failuresByTool = new Map<string, number>();
  let corrected = steps.some((s) => s.kind === "notice" && (s.result as { notice?: string } | null)?.notice === "repair");

  await store.updateRun(run.id, { status: "running" });
  run = { ...run, status: "running" };

  const append = (s: Partial<NewStep> & Pick<NewStep, "stage" | "kind">) =>
    store.appendStep(run!.id, {
      parentN: null, callId: null, toolName: null, toolArgs: null, outcome: null, result: null, native: null, usage: null,
      costUsdMicros: 0, attempt: 1, requestId: null, prefixHash: null, timings: null, ...s,
    });

  const finish = async (t: Terminal): Promise<AgentRunRow> => {
    const t0 = wall();
    const terminalStates: RunStatus[] = ["done", "failed", "refused", "escalated", "expired", "cancelled"];
    const endedAt = terminalStates.includes(t.status) ? deps.clock.now() : null;
    const state = await executor.runState(handle).catch(() => null);
    await store.updateRun(run!.id, {
      status: t.status, terminalReason: t.reason, summary: t.summary ?? run!.summary, endedAt,
      tainted: state?.tainted ?? run!.tainted, taintedBy: state?.taintedBy ?? run!.taintedBy,
    });
    await append({ stage: "terminal", kind: "verify", outcome: "ok", result: { status: t.status, reason: t.reason, ms: wall() - t0 }, timings: emptyTimings() });
    return (await store.getRun(run!.id))!;
  };

  const allToolResults = async (): Promise<unknown[]> => {
    const rows = await store.steps(run!.id);
    const out: unknown[] = [];
    for (const r of rows) {
      if (r.kind !== "tool_call") continue;
      // Model-authored text (run feed updates) is not evidence: the answer cannot ground itself on it.
      if (r.toolName === "comms__post_update") continue;
      const o = (r.result as { outcome?: ToolOutcome } | null)?.outcome;
      if (o && o.ok && o.status === "done") out.push({ resultId: o.resultId, data: o.data, summary: o.summary, actionSeq: o.actionSeq });
      else if (o && o.ok) out.push({ proposalId: o.proposalId, title: o.title });
    }
    return out;
  };

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
    let attempt = 1;
    let maxOut = MAX_OUTPUT_TOKENS;
    let incompleteCount = 0;
    let result: ModelStepResult | null = null;
    let modelStepRow: RunStepRow | null = null;
    while (result === null) {
      const estInput = approxTokens(prompt) + approxTokens(JSON.stringify(tools)) + approxTokens(JSON.stringify(history));
      // A provider that is not live (scripted, templates) spends nothing: it still reserves and settles, at zero.
      const reserveMicros = provider.live ? usdToMicros(reserveUsd(estInput, maxOut, deps.prices)) : 0;
      if (provider.live && run.costUsdMicros + reserveMicros > usdBudget * 1e6) {
        await append({ stage: "admission", kind: "verify", outcome: "refused:BUDGET_EXCEEDED", result: { cap: "run", reserveMicros }, timings: { ...emptyTimings(), admissionMs: wall() - tAdm } });
        return finish({ status: "escalated", reason: "BUDGET_EXCEEDED", summary: "Stopped before the per-run spend cap." });
      }
      const rsv = await ledger.reserve({ runId: run.id, usdMicros: reserveMicros, model: run.model, live: provider.live });
      const admissionMs = wall() - tAdm;
      if (!rsv.ok) {
        await append({ stage: "admission", kind: "verify", outcome: "refused:BUDGET_EXCEEDED", result: { cap: rsv.cap, spentMicros: rsv.spentMicros, reserveMicros }, timings: { ...emptyTimings(), admissionMs } });
        return finish({ status: "escalated", reason: "BUDGET_EXCEEDED", summary: `Stopped by the ${rsv.cap} spend cap.` });
      }
      await append({ stage: "admission", kind: "verify", outcome: "ok", attempt, result: { reservationId: rsv.reservationId, reserveMicros, estInputTokens: estInput }, timings: { ...emptyTimings(), admissionMs } });

      // ---- assemble
      const tAsm = wall();
      const req: ModelStepRequest = {
        runId: run.id, agentKind: run.kind, model: run.model, frozenPrompt: prompt, tools, toolChoice: { mode: "auto" }, history,
        effort: run.effort, maxOutputTokens: maxOut, cacheKey: run.cacheKey,
        signal: deps.signalFor(run.id) ? AbortSignal.any([deps.signalFor(run.id)!, AbortSignal.timeout(deps.modelTimeoutMs)]) : AbortSignal.timeout(deps.modelTimeoutMs),
      };
      const assembleMs = wall() - tAsm;
      await append({ stage: "assemble", kind: "context", attempt, prefixHash: pHash, result: { items: history.length, estInputTokens: estInput }, timings: { ...emptyTimings(), assembleMs } });

      // ---- model
      const tModel = wall();
      const timeToLlmMs = tModel - tAdm;
      let res: ModelStepResult;
      try {
        res = await provider.step(req);
      } catch (e) {
        await ledger.settle(rsv.reservationId, 0);
        throw e; // scripted expectation failures and programming errors surface to the caller
      }
      const modelMs = wall() - tModel;
      const usd = stepCostUsd(res.usage, deps.prices);
      const actualMicros = provider.live ? usdToMicros(usd) : 0;
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

    // ---- dispatch
    if (result.toolCalls.length > 0) {
      const tDisp = wall();
      const outputs: { callId: string; name: string; outcome: ToolOutcome; row: NewStep }[] = [];
      let index = 0;
      for (const call of result.toolCalls) {
        index++;
        if (deps.isCancelled(run.id)) break;
        let outcome: ToolOutcome;
        let args: unknown = null;
        const tCall = wall();
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
              outcome = await executor.exec(handle, { callId: call.callId, command: call.name, args });
            } catch (e) {
              outcome = refusal("INTERNAL", `The executor failed: ${e instanceof Error ? e.message.slice(0, 200) : "error"}`);
            }
          }
        }
        if (!outcome.ok) failuresByTool.set(call.name, (failuresByTool.get(call.name) ?? 0) + 1);
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
        outputs.push({ callId: call.callId, name: call.name, outcome: refusal("CANCELLED", "The run was cancelled before this call ran."), row: { stage: "dispatch", kind: "tool_call", parentN: modelStepRow!.n, callId: call.callId, toolName: call.name, toolArgs: null, outcome: "error", result: null, native: null, usage: null, costUsdMicros: 0, attempt: 1, requestId: null, prefixHash: null, timings: emptyTimings() } });
      }
      await store.updateRun(run.id, { consecutiveErrors: run.consecutiveErrors });

      // ---- post: recite from observed state into the last output of the batch
      const tPost = wall();
      const items = await deps.checklist(run);
      if (items) await store.updateRun(run.id, { checklist: items });
      const plan = renderPlan(items, run.stepsUsed, stepBudget, run.costUsdMicros / 1e6);
      const toolOutputs = outputs.map((o, i) => ({ callId: o.callId, name: o.name, output: outputFor(o.outcome, i === outputs.length - 1 ? plan : null) }));
      for (let i = 0; i < outputs.length; i++) {
        await append({ ...outputs[i]!.row, result: { output: toolOutputs[i]!.output, outcome: outputs[i]!.outcome } });
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
      const g = check(text, await allToolResults());
      if (g.ok) return finish({ status: "done", reason: "DONE", summary: text });
      if (!corrected) {
        corrected = true;
        const notice = { notice: "repair" as const, attrs: { n: setup.nonce, code: "UNGROUNDED" }, text: `These numbers do not match any tool result in this run: ${g.offending.join(", ")}. Read the source or remove them, then answer again.` };
        await append({ stage: "post", kind: "notice", result: notice });
        history = [...history, { kind: "notice", ...notice }];
        continue;
      }
      return finish({ status: "done", reason: "DONE", summary: await groundedTemplate(allToolResults) });
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
async function routineSummary(results: () => Promise<unknown[]>): Promise<string> {
  const rs = (await results()) as { resultId?: string; summary?: string; proposalId?: string; title?: string; actionSeq?: number | null }[];
  const parts = [
    ...rs.filter((r) => r.resultId && r.actionSeq !== null && r.actionSeq !== undefined).map((r) => `${r.summary ?? "Done"} (#${r.actionSeq})`),
    ...rs.filter((r) => r.proposalId).map((r) => `Proposed ${r.title ?? "a change"} (${r.proposalId})`),
  ];
  return parts.length ? parts.slice(0, 8).join("; ") : "Checked; nothing needed a change.";
}

async function groundedTemplate(results: () => Promise<unknown[]>): Promise<string> {
  const rs = (await results()) as { resultId?: string; summary?: string; proposalId?: string; title?: string }[];
  const lines = rs.slice(0, 8).map((r) => (r.resultId ? `${r.summary ?? "result"} (${r.resultId})` : `${r.title ?? "proposal"} (${r.proposalId})`));
  return lines.length
    ? `I could not verify every number in my answer, so here is what I read instead:\n${lines.join("\n")}`
    : "I could not verify my answer against any tool result, so I am not showing it.";
}
