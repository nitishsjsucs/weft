// The agent runtime (SPEC 9.0 AgentRuntime): opens agent_runs rows that reuse the executor's run id, renders the
// context pack once, queues runLoop, requeues on decisions (capped at 2), cancels, streams steps and applies the
// boot rule PROCESS_RESTART. The brain holds only opaque run handles and an AgentExecutor.
import type {
  AgentExecutor, AgentRunRow, AgentRuntime, ModelProvider, NoticeKind, PrecheckResult, RoutineDef, RoutineRun, RunHandle, RunStepRow,
  RunTrace, SimClock, SpendLedger, WeftEvent,
} from "@weft/contracts";
import type { Db } from "@weft/db";
import { newNonce } from "./canonical";
import { chatPack, routineDraftPack, routinePack, type OpenLoop } from "./context";
import { LUNA, pricesFromEnv, ZERO_USAGE, type Prices } from "./cost";
import { BUDGETS, MAX_REQUEUES, runLoop, type ChecklistState, type RunSetup } from "./loop";
import type { PromptKind } from "./prompts/index";
import { concurrencyFor, createRunQueue, type RunQueue } from "./queue";
import { createRunStore, type RunStore } from "./store";
import { buildTrace } from "./trace";

/** Harness 5.3: chat and MCP agent.ask, read-only in P0, exactly 14 tools. */
export const CHAT_TOOLS = [
  "people.search", "people.get", "payroll.list_runs", "payroll.get_run", "tax.get_rates", "tax.list_registrations", "notices.list", "notices.get",
  "actions.list", "actions.get_run", "memory.search", "memory.read", "agent.read_artifact", "comms.post_update",
] as const;

export const DRAFT_TOOLS = ["routines.draft", "routines.list"] as const;
export const DEFAULT_COMPANY_ID = "cmp_larkspur";

/** Read access to routine definitions and their code-owned checklists. */
export interface RoutinesView {
  get(routineId: string): Promise<RoutineDef | null>;
  /** Evaluate the routine run's checklist in code (packages/routines checks.ts over the ReadOnlyExecutor). */
  checklist?(input: { routine: RoutineDef; agentRunId: string; routineRunId: string | null; companyId: string; trigger: Record<string, unknown> }): Promise<ChecklistState[]>;
}

/** Deterministic chat context from DB rows (apps/api provides it; the brain never reads domain tables). */
export interface ChatContextSource {
  chat(input: { companyId: string; runId: string }): Promise<{ actingFor: string; grants: Record<string, string>; companySummary: string; openLoops: OpenLoop[] }>;
  channels?(companyId: string): Promise<string[]>;
}

export interface CreateAgentRuntimeOptions {
  db: Db; clock: SimClock; executor: AgentExecutor; provider: ModelProvider; ledger: SpendLedger; routinesView: RoutinesView;
  companyId?: string;
  contextSource?: ChatContextSource;
  env?: Record<string, string | undefined>;
  modelTimeoutMs?: number;
}

export interface WeftAgentRuntime extends AgentRuntime {
  readonly store: RunStore;
  readonly queue: RunQueue;
  /** Resolves when the run leaves queued and running (waiting counts as settled). */
  settled(runId: string): Promise<AgentRunRow>;
  /** Zero-token wake: evaluate the checklist and pending proposals in code; requeue only when work is left. */
  wake(runId: string, notice: { kind: NoticeKind; attrs: Record<string, string>; text: string }): Promise<"done" | "waiting" | "requeued" | "escalated" | "ignored">;
  idle(): Promise<void>;
}

export function createAgentRuntime(opts: CreateAgentRuntimeOptions): WeftAgentRuntime {
  const env = opts.env ?? process.env;
  const prices: Prices = opts.provider.live ? pricesFromEnv(env) : LUNA;
  const listeners = new Map<string, Set<(s: RunStepRow) => void>>();
  const store = createRunStore(opts.db, {
    onStep: (s) => { for (const cb of listeners.get(s.runId) ?? []) { try { cb(s); } catch { /* a listener never breaks a run */ } } },
  });
  const queue = createRunQueue(concurrencyFor(opts.provider.id));
  const handles = new Map<string, RunHandle>();
  const cancelled = new Set<string>();
  const aborts = new Map<string, AbortController>();
  const triggers = new Map<string, { routine: RoutineDef; trigger: Record<string, unknown> }>();
  const companyId = opts.companyId ?? DEFAULT_COMPANY_ID;
  const settledWaiters = new Map<string, ((r: AgentRunRow) => void)[]>();

  async function checklist(run: AgentRunRow): Promise<ChecklistState[] | null> {
    const t = triggers.get(run.id);
    if (!t || !opts.routinesView.checklist) return null;
    return opts.routinesView.checklist({ routine: t.routine, agentRunId: run.id, routineRunId: run.routineRunId, companyId: run.companyId, trigger: t.trigger });
  }

  const loopDeps = {
    store, executor: opts.executor, provider: opts.provider, ledger: opts.ledger, clock: opts.clock, prices, checklist,
    isCancelled: (id: string) => cancelled.has(id),
    signalFor: (id: string) => aborts.get(id)?.signal,
    modelTimeoutMs: opts.modelTimeoutMs ?? Number(env.WEFT_T_MODEL_MS ?? 120_000),
  };

  const notifySettled = (row: AgentRunRow) => {
    const ws = settledWaiters.get(row.id) ?? [];
    settledWaiters.delete(row.id);
    for (const w of ws) w(row);
  };

  function enqueue(runId: string) {
    const handle = handles.get(runId);
    if (!handle) throw new Error(`no run handle for ${runId}`);
    aborts.set(runId, new AbortController());
    void queue.push(runId, async () => {
      try {
        const row = await runLoop(loopDeps, handle);
        notifySettled(row);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await store.updateRun(runId, { status: "failed", terminalReason: "REPEATED_ERRORS", summary: msg.slice(0, 2000), endedAt: opts.clock.now() });
        await store.appendStep(runId, { stage: "terminal", kind: "error", parentN: null, callId: null, toolName: null, toolArgs: null, outcome: "error", result: { message: msg.slice(0, 2000) }, native: null, usage: null, costUsdMicros: 0, attempt: 1, requestId: null, prefixHash: null, timings: null });
        const row = await store.getRun(runId);
        if (row) notifySettled(row);
      }
    }).catch(() => undefined);
  }

  function baseRow(handle: RunHandle, p: { trigger: string; attended: boolean; routineRunId: string | null; routineId: string | null; kind: PromptKind; budget?: { steps: number; usd: number; minutes: number } }): AgentRunRow {
    const b = p.budget ?? BUDGETS[p.kind];
    return {
      id: handle.runId, companyId, kind: "main", parentRunId: null, threadId: null, routineRunId: p.routineRunId, trigger: p.trigger, attended: p.attended,
      provider: opts.provider.id, model: opts.provider.model, effort: "low", cacheKey: `weft:main:${p.routineId ?? (p.kind === "routine_draft" ? "routine_draft" : "chat")}:${companyId}`,
      status: "queued", terminalReason: null, tainted: false, taintedBy: null, checklist: null, budget: { steps: b.steps, usd: b.usd, minutes: b.minutes },
      stepsUsed: 0, requeues: 0, consecutiveErrors: 0, costUsdMicros: 0, tokens: { ...ZERO_USAGE }, createdAt: opts.clock.now(), endedAt: null, summary: null,
    };
  }

  async function writeContext(runId: string, setup: RunSetup) {
    await store.appendStep(runId, { stage: "assemble", kind: "context", parentN: null, callId: null, toolName: null, toolArgs: null, outcome: "ok", result: setup, native: null, usage: null, costUsdMicros: 0, attempt: 1, requestId: null, prefixHash: null, timings: null });
  }

  const runtime: WeftAgentRuntime = {
    store,
    queue,
    async boot() {
      for (const r of await store.runsWithStatus(["running"])) {
        await store.updateRun(r.id, { status: "failed", terminalReason: "PROCESS_RESTART", endedAt: opts.clock.now(), summary: "The process restarted while this run was active. Run it again." });
        if (r.routineRunId) await store.failRoutineRun(r.routineRunId, "The process restarted while this run was active. Run again.", opts.clock.now());
      }
    },
    async startChat(handle, input) {
      handles.set(handle.runId, handle);
      const kind: PromptKind = input.recipe === "routine_draft" ? "routine_draft" : "chat";
      await store.createRun(baseRow(handle, { trigger: "chat", attended: true, routineRunId: null, routineId: null, kind }));
      const nonce = newNonce();
      let text: string;
      if (kind === "chat") {
        const c = (await opts.contextSource?.chat({ companyId, runId: handle.runId })) ?? { actingFor: "the person in this chat", grants: {}, companySummary: "No company summary is available.", openLoops: [] };
        text = chatPack({ nonce, now: opts.clock.now(), actingFor: c.actingFor, grants: c.grants, companySummary: c.companySummary, openLoops: c.openLoops, request: input.text, pageContext: input.pageContext });
      } else {
        const channels = (await opts.contextSource?.channels?.(companyId)) ?? ["#people-ops", "#new-hires", "#payroll"];
        text = routineDraftPack({ nonce, now: opts.clock.now(), actingFor: "the person in this chat", request: input.text, channels, tools: [...CHAT_TOOLS, "comms.send_message"] });
      }
      await writeContext(handle.runId, { promptKind: kind, allowlist: kind === "chat" ? [...CHAT_TOOLS] : [...DRAFT_TOOLS], nonce, routineId: null, text, pack: true });
      enqueue(handle.runId);
    },
    async startRoutineRun(handle, input: { routine: RoutineDef; routineRun: RoutineRun; trigger: WeftEvent | null; precheck: PrecheckResult }) {
      handles.set(handle.runId, handle);
      if (input.precheck.action !== "run") throw new Error("startRoutineRun needs a precheck with action run");
      const trigger: Record<string, unknown> = input.trigger ? { event: input.trigger.type, event_id: input.trigger.id, subject_ref: input.trigger.subjectRef, ...input.trigger.payload } : { manual: true, trigger_ref: input.routineRun.triggerRef };
      triggers.set(handle.runId, { routine: input.routine, trigger });
      await store.createRun(baseRow(handle, { trigger: `routine:${input.routineRun.id}`, attended: input.routineRun.attended, routineRunId: input.routineRun.id, routineId: input.routine.id, kind: "routine", budget: input.routine.budget }));
      const nonce = newNonce();
      const text = routinePack({
        nonce, now: opts.clock.now(), actingFor: input.routine.ownerPrincipalId, limits: { ...BUDGETS.routine, ...input.routine.budget, toolCallsPerStep: BUDGETS.routine.toolCallsPerStep },
        routine: { id: input.routine.id, name: input.routine.name, instructions: input.routine.instructions }, trigger,
        precheck: { severity: input.precheck.severity, findings: input.precheck.findings, derivedArgs: input.precheck.derivedArgs }, checklist: input.routine.checklist,
      });
      await writeContext(handle.runId, { promptKind: "routine", allowlist: [...input.routine.tools], nonce, routineId: input.routine.id, text, pack: true });
      enqueue(handle.runId);
    },
    async requeue(runId, notice) {
      const run = await store.getRun(runId);
      if (!run || !["waiting", "held"].includes(run.status)) return;
      const requeues = run.requeues + 1;
      if (requeues > MAX_REQUEUES) {
        await store.updateRun(runId, { status: "escalated", terminalReason: "BUDGET_EXCEEDED", requeues, endedAt: opts.clock.now(), summary: "Woken more than twice; a person should take over." });
        notifySettled((await store.getRun(runId))!);
        return;
      }
      const steps = await store.steps(runId);
      const setup = steps.find((s) => s.kind === "context" && (s.result as RunSetup | null)?.pack)?.result as RunSetup | undefined;
      await store.updateRun(runId, { status: "queued", requeues });
      await store.appendStep(runId, { stage: "post", kind: "notice", parentN: null, callId: null, toolName: null, toolArgs: null, outcome: "ok", result: { notice: notice.kind, attrs: { ...notice.attrs, n: setup?.nonce ?? "" }, text: notice.text }, native: null, usage: null, costUsdMicros: 0, attempt: 1, requestId: null, prefixHash: null, timings: null });
      if (!handles.has(runId)) {
        await store.updateRun(runId, { status: "failed", terminalReason: "PROCESS_RESTART", endedAt: opts.clock.now(), summary: "The run handle was lost in a restart. Run it again." });
        return;
      }
      enqueue(runId);
    },
    async wake(runId, notice) {
      const run = await store.getRun(runId);
      if (!run || run.status !== "waiting") return "ignored";
      const handle = handles.get(runId);
      const items = await checklist(run);
      const pending = handle ? (await opts.executor.runState(handle)).pendingProposalIds : [];
      if (!items || items.every((i) => i.passed)) {
        if (pending.length > 0) return "waiting";
        await store.updateRun(runId, { status: "done", terminalReason: "DONE", checklist: items ?? run.checklist, endedAt: opts.clock.now() });
        await store.appendStep(runId, { stage: "terminal", kind: "verify", parentN: null, callId: null, toolName: null, toolArgs: null, outcome: "ok", result: { status: "done", reason: "DONE", zeroTokenWake: true }, native: null, usage: null, costUsdMicros: 0, attempt: 1, requestId: null, prefixHash: null, timings: null });
        notifySettled((await store.getRun(runId))!);
        return "done";
      }
      await runtime.requeue(runId, notice);
      const after = await store.getRun(runId);
      return after?.status === "escalated" ? "escalated" : "requeued";
    },
    async cancel(runId) {
      cancelled.add(runId);
      aborts.get(runId)?.abort();
      const run = await store.getRun(runId);
      if (run && ["queued", "waiting", "held"].includes(run.status) && queue.position(runId) === null) {
        await store.updateRun(runId, { status: "cancelled", terminalReason: "CANCELLED", endedAt: opts.clock.now() });
        notifySettled((await store.getRun(runId))!);
      }
    },
    subscribe(runId, cb) {
      const set = listeners.get(runId) ?? new Set();
      set.add(cb);
      listeners.set(runId, set);
      return () => { set.delete(cb); };
    },
    async trace(runId): Promise<RunTrace> {
      const t = await buildTrace(store, runId);
      if (!t) throw new Error(`no run ${runId}`);
      return t;
    },
    async settled(runId) {
      const run = await store.getRun(runId);
      if (run && !["queued", "running"].includes(run.status) && queue.position(runId) === null) return run;
      return new Promise((r) => settledWaiters.set(runId, [...(settledWaiters.get(runId) ?? []), r]));
    },
    idle: () => queue.idle(),
  };
  return runtime;
}
