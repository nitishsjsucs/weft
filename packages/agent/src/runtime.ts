// The agent runtime (SPEC 9.0 AgentRuntime): opens agent_runs rows that reuse the executor's run id, renders the
// context pack once, queues runLoop, requeues on decisions (capped at 2), cancels, streams steps and applies the
// boot rule PROCESS_RESTART. The brain holds only opaque run handles and an AgentExecutor.
//
// Hosted additions (docs/cloudflare/design.md 3.3 and 5.2), all optional so Node runs as before: a RunHost decides
// when a queued job starts (Node at once; CompanyDO from its alarm, one live run per invocation); a ProviderPool
// chooses the provider once at run creation and the run row pins it; scripts come from a ScriptSource, so a hosted
// world reads no file. Portable: index.ts gives Node its scenarios directory.
import type {
  AgentExecutor, AgentRunRow, AgentRuntime, ModelProvider, NoticeKind, PrecheckResult, RoutineDef, RoutineRun, RunHandle, RunStepRow,
  RunTrace, SimClock, SpendLedger, WeftEvent,
} from "@weft/contracts";
import type { Db } from "@weft/db";
import { newNonce } from "./canonical";
import { chatPack, routineDraftPack, routinePack, type OpenLoop } from "./context";
import { LUNA, pricesFor, ZERO_USAGE, type Prices } from "./cost";
import { BUDGETS, MAX_REQUEUES, runLoop, traceWakeSegment, type ChecklistState, type RunSetup } from "./loop";
import type { PromptKind } from "./prompts/index";
import { PORTAL_PAGE_MARKER, ROLE_PORTAL, portalPack } from "./prompts/portal";
import { concurrencyFor, createRunQueue, type RunQueue } from "./queue";
import { createRunStore, type RunStore } from "./store";
import { buildTrace } from "./trace";
import { effortOverrideFromEnv } from "./providers/factory-core";
import type { ProviderPool } from "./providers/hosted";
import { parseContext, scriptedProviderFrom } from "./providers/scripted-core";
import { noteRunRecall, traceRoutineRunSpan, type RecallNote, type RoutineRunSpan } from "./otel";
import { immediateRunHost } from "./run-host";
import { earlierConversationBlock, type EarlierTurn } from "./threads";
import type { ScriptSource } from "./script-source";
import type { RunHost } from "../../contracts/src/ext/cf-agent";
import { ASSIST_TOOLS } from "../../contracts/src/ext/assist";
import { assistPack } from "./assist/pack";
import { resolveAssist, resolverProvider, type AssistResolution } from "./assist/resolver";

export { CHAT_TOOLS, DRAFT_TOOLS } from "@weft/contracts";
import { CHAT_TOOLS, DRAFT_TOOLS } from "@weft/contracts";
export const DEFAULT_COMPANY_ID = "cmp_larkspur";

/** Read access to routine definitions and their code-owned checklists. */
export interface RoutinesView {
  get(routineId: string): Promise<RoutineDef | null>;
  /** Evaluate the routine run's checklist in code (packages/routines checks.ts over the ReadOnlyExecutor). */
  checklist?(input: { routine: RoutineDef; agentRunId: string; routineRunId: string | null; companyId: string; trigger: Record<string, unknown> }): Promise<ChecklistState[]>;
}

/** Deterministic chat context from DB rows (apps/api provides it; the brain never reads domain tables). */
export interface ChatContextSource {
  chat(input: { companyId: string; runId: string }): Promise<{ actingFor: string; grants: Record<string, string>; companySummary: string; openLoops: OpenLoop[]; principalId?: string | null }>;
  channels?(companyId: string): Promise<string[]>;
  /** Wave 2 (w2-memory): a <recall> block for the run start, or "" for none. */
  recall?(input: { companyId: string; runId: string; kind: "chat" | "routine"; query: string; subjectRefs: string[] }): Promise<string>;
  /**
   * The Agent page: the earlier turns of the run's conversation thread, oldest first, that a follow-up may read (the
   * same person's, untainted, finished with an answer). apps/api decides which turns qualify; the runtime bounds and
   * renders them (threads.ts). Absent, a follow-up gets no prior conversation.
   */
  earlier?(input: { companyId: string; runId: string; threadId: string }): Promise<EarlierTurn[]>;
  /**
   * The cursor assistant: the same person's last request in the thread before this run, whatever that turn read (a
   * request is their own words, or code's restatement of them, never text a tool read; its answer stays out). A choice
   * picked after a turn that read untrusted content continues the request it answers. Absent, `earlier` alone is read.
   */
  lastRequest?(input: { companyId: string; runId: string; threadId: string }): Promise<string | null>;
  /**
   * The cursor assistant's handoff: opens a chat run for the person an assist run acted for (the chat tools code picks
   * for the question, the same caps; tainted when `taintedBy` is set), starts it with `start`, and returns its id.
   * apps/api provides it; absent, an assist run cannot hand off and ends with its own answer.
   */
  handoff?(input: { companyId: string; fromRunId: string; question: string; threadId: string | null; taintedBy: string | null }, start: (handle: RunHandle, allowlist: readonly string[] | null) => Promise<void>): Promise<string | null>;
}

/**
 * The page facts a handoff's chat run gets as its page line: the route, the kind and id of what the pointer was on, and
 * the record ids the page held. No label or other text from the screen map is passed on.
 */
export function handoffPageLine(brief: RunSetup["brief"] | undefined): string | null {
  if (!brief) return null;
  const parts = [`${brief.route} (asked at the pointer)`];
  if (brief.under) parts.push(`pointer on ${brief.under.kind} ${brief.under.entity}`);
  if (brief.recordIds.length) parts.push(`records on the page: ${brief.recordIds.slice(0, 20).join(", ")}`);
  return parts.join("; ").slice(0, 600);
}

/** The earlier turn's answer when only the person's request in it may be read (ChatContextSource.lastRequest). */
const LEFT_OUT_ANSWER = "(Its answer is not repeated here.)";

/** The chat run an assist run handed off to, as its terminal step names it. */
const handedToOf = (steps: RunStepRow[]): string | null =>
  steps.flatMap((s) => { const to = (s.result as { handoff?: { to?: unknown } } | null)?.handoff?.to; return s.stage === "terminal" && typeof to === "string" ? [to] : []; })[0] ?? null;

/** The acting principal for telemetry (user.id): the source's id, else the "(prn_...)" id inside actingFor. */
export function principalOf(c: { actingFor: string; principalId?: string | null }): string | null {
  return c.principalId ?? /\(([a-z]{2,5}_[A-Za-z0-9_]+)\)/.exec(c.actingFor)?.[1] ?? null;
}

/** Findings keys whose short scalar values name what a routine run is about (a notice's kind, agency, form, period). */
const RECALL_FINDING_KEYS = ["kind", "agency", "form", "form_code", "period", "code", "jurisdiction", "state", "plan"] as const;

/**
 * The run-start recall query of a routine run (wave 4 round 1, FM4): the routine's name plus the precheck findings
 * that say what this run is about, read from the top level and one level down (for a notice: kind, agency, form and
 * period). Underscored codes also appear as words ("missing_filing" adds "missing filing"), so a note written in
 * prose matches. Ids, amounts and long text never join the query.
 */
export function routineRecallQuery(name: string, findings: unknown): string {
  const out: string[] = [name];
  const seen = new Set<string>([name.toLowerCase()]);
  const add = (v: unknown) => {
    if (typeof v !== "string" || !v || v.length > 40 || /^[a-z]{2,5}_[0-9]{3,}$/.test(v)) return;
    for (const t of v.includes("_") && /[a-z]/.test(v) ? [v, v.replaceAll("_", " ")] : [v]) {
      if (!seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
    }
  };
  const visit = (o: unknown, depth: number) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return;
    const rec = o as Record<string, unknown>;
    for (const k of RECALL_FINDING_KEYS) add(rec[k]);
    if (depth < 1) for (const v of Object.values(rec)) visit(v, depth + 1);
  };
  visit(findings, 0);
  return out.join(" ");
}

/** One line of a <recall> block (packages/executor/src/memory/recall.ts renderRecall): path, kind, untrusted, text. */
const RECALL_ITEM = /^- (.+?) \(([a-z-]+), as of [0-9-]+(, untrusted)?\): (.*)$/;
const unescapeData = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/**
 * Commands whose derived arguments may cite a recalled procedure (wave 4 round 2, R3), with what the procedure must be
 * about: an escalation cites a procedure that speaks of escalating, never one about something else.
 */
export const PROCEDURE_CITATIONS: Readonly<Record<string, RegExp>> = { "notices.escalate": /\bescalat/i };

/** The trusted knowledge/procedures/ notes in a run-start recall block, in recall order, with their recalled text. */
export function recalledProcedures(block: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const line of block.split("\n")) {
    const m = RECALL_ITEM.exec(line);
    if (!m || m[3]) continue;
    const path = unescapeData(m[1]!).replace(/#L\d+$/, "");
    if (!path.startsWith("knowledge/procedures/") || !path.endsWith(".md") || out.some((p) => p.path === path)) continue;
    out.push({ path, text: unescapeData(m[4]!) });
  }
  return out;
}

/**
 * The derived arguments a routine run sees once its run-start recall is known (wave 4 round 2, R2 and R3): every
 * recalled procedure path is listed under `recalled_procedures`, and a derived command that can cite one (a
 * PROCEDURE_CITATIONS key) gets `procedure_ref`, the first recalled procedure about that command. The executor still
 * checks the reference when the call runs, so this only saves the model from copying a path. Nothing changes when
 * recall holds no trusted procedure. The routine run's stored precheck (and so its checklist scope) is unchanged.
 */
export function withRecalledProcedures(derived: Record<string, unknown> | null, block: string): Record<string, unknown> | null {
  const procs = recalledProcedures(block);
  if (procs.length === 0) return derived;
  const out: Record<string, unknown> = { ...(derived ?? {}), recalled_procedures: procs.map((p) => p.path) };
  for (const [command, about] of Object.entries(PROCEDURE_CITATIONS)) {
    const args = out[command];
    if (!args || typeof args !== "object" || Array.isArray(args) || "procedure_ref" in args) continue;
    const p = procs.find((x) => about.test(x.text));
    if (p) out[command] = { ...(args as Record<string, unknown>), procedure_ref: p.path };
  }
  return out;
}

/**
 * The scripted and template stand-ins cannot branch on a derived plan the way a model reads one, so a routine run
 * whose precheck derived `plan` plays <routine>.<plan>.json when that script exists (for example
 * rt_agency_notice.file_return); otherwise the routine's own script and the composition root's variant hook apply as
 * before. Only the request handed to the stand-in changes; the run row and a live provider never see this.
 */
function planScripted(p: ModelProvider, scripts: ScriptSource): ModelProvider {
  if (p.id !== "scripted") return p;
  const exists = new Map<string, boolean>();
  const has = (name: string) => {
    if (!exists.has(name)) exists.set(name, scripts.get(name) !== null);
    return exists.get(name)!;
  };
  return {
    ...p,
    step: (req) => {
      const parts = req.cacheKey.split(":");
      const routine = parts[2] ?? "chat";
      const plan = routine === "chat" || routine === "routine_draft" || routine === "assist" ? null : parseContext(req.history).derived.plan;
      if (typeof plan !== "string" || !/^[a-z_]{1,40}$/.test(plan) || !has(`${routine}.${plan}`)) return p.step(req);
      parts[2] = `${routine}.${plan}`;
      return p.step({ ...req, cacheKey: parts.join(":") });
    },
  };
}

/** Appends a non-empty recall block inside the context pack (wave 2, w2-memory); "" or undefined leaves it unchanged. */
function withRecall(text: string, block: string | undefined): string {
  if (!block) return text;
  const end = text.lastIndexOf("\n</context>");
  return end < 0 ? text : `${text.slice(0, end)}\n${block}${text.slice(end)}`;
}

/**
 * Where the runtime keeps run handles between processes (gate report item 2). A handle is a bearer credential for the
 * executor, so it never goes into run_steps (the trace and the SSE feed read those); apps/api compose.ts keeps one
 * 0600 file per open run under <dataDir>/run/handles. Without a store, handles live only in memory and a waiting run fails
 * with PROCESS_RESTART when it is woken after a restart.
 */
export interface RunHandleStore {
  save(handle: RunHandle): Promise<void>;
  load(runId: string): Promise<RunHandle | null>;
  drop(runId: string): Promise<void>;
}

export interface CreateAgentRuntimeOptions {
  db: Db; clock: SimClock; executor: AgentExecutor; provider: ModelProvider; ledger: SpendLedger; routinesView: RoutinesView;
  companyId?: string;
  contextSource?: ChatContextSource;
  env?: Record<string, string | undefined>;
  modelTimeoutMs?: number;
  /** Persists run handles so waiting runs survive a restart (compose.ts passes fileRunHandleStore). */
  handleStore?: RunHandleStore;
  /** Scripts for the deterministic templates and plan variants (index.ts defaults to the scenarios directory). */
  scriptSource?: ScriptSource;
  /** When a queued job starts. Default: at once (Node). CompanyDO passes alarmRunHost (run-host.ts). */
  runHost?: RunHost;
  /** Hosted: the provider for each new run, pinned on its row. Default: `provider` for every run (Node). */
  providers?: ProviderPool;
}

export interface WeftAgentRuntime extends AgentRuntime {
  readonly store: RunStore;
  readonly queue: RunQueue;
  /** Resolves when the run leaves queued and running (waiting counts as settled). */
  settled(runId: string): Promise<AgentRunRow>;
  /** Zero-token wake: evaluate the checklist and pending proposals in code; requeue only when work is left. */
  wake(runId: string, notice: { kind: NoticeKind; attrs: Record<string, string>; text: string }): Promise<"done" | "waiting" | "requeued" | "escalated" | "ignored">;
  idle(): Promise<void>;
  /** Waits up to `timeoutMs` for queued and running runs to settle (weft.close() calls it). Resolves true when the queue went idle. */
  drain(timeoutMs?: number): Promise<boolean>;
  /** Wave 4 round 1 (FM11): a span for a routine run that ended without an agent run (the routines engine calls it). */
  traceRoutineRun(t: RoutineRunSpan): void;
}

export function createAgentRuntime(opts: CreateAgentRuntimeOptions & { scriptSource: ScriptSource }): WeftAgentRuntime {
  const env = opts.env ?? process.env;
  const pricesOf = (p: ModelProvider): Prices => (p.live ? pricesFor(p.id, env, p.model) : LUNA);
  const prices: Prices = pricesOf(opts.provider);
  // WEFT_EFFORT (experiments only): the OpenAI provider sends it on every call, so the runs it serves record it too
  // (run row, prefix hash, trace). Unset keeps the per-stage default below.
  const effortOverride = opts.provider.id === "openai" || opts.providers ? effortOverrideFromEnv(env) : null;
  const listeners = new Map<string, Set<(s: RunStepRow) => void>>();
  const store = createRunStore(opts.db, {
    onStep: (s) => { for (const cb of listeners.get(s.runId) ?? []) { try { cb(s); } catch { /* a listener never breaks a run */ } } },
  });
  const queue = createRunQueue(concurrencyFor(opts.provider.id));
  const host: RunHost = opts.runHost ?? immediateRunHost();
  /** Run ids the host has started into the queue and that have not finished (running or waiting there). */
  const inQueue = new Set<string>();
  /** The queue as the API reads it: a job the host has not started yet stands behind every job waiting in the queue
   * (with the immediate host nothing is ever pending, so positions are the queue's own). */
  const visibleQueue: RunQueue = {
    concurrency: queue.concurrency,
    push: (id, job) => queue.push(id, job),
    idle: () => queue.idle(),
    position(id) {
      const p = queue.position(id);
      if (p !== null) return p;
      const i = host.pending().indexOf(id);
      if (i < 0) return null;
      let waiting = 0;
      for (const q of inQueue) if ((queue.position(q) ?? 0) > 0) waiting++;
      return waiting + i + 1;
    },
  };
  const handles = new Map<string, RunHandle>();
  const cancelled = new Set<string>();
  /** An assist run's chat run, from the moment the handoff opened it until the assist run settles (then its terminal step names it). */
  const handedTo = new Map<string, string>();
  const aborts = new Map<string, AbortController>();
  const triggers = new Map<string, { routine: RoutineDef; trigger: Record<string, unknown> }>();
  const companyId = opts.companyId ?? DEFAULT_COMPANY_ID;
  const settledWaiters = new Map<string, ((r: AgentRunRow) => void)[]>();

  const handleStore = opts.handleStore;
  const terminal = (status: string) => !["queued", "running", "waiting", "held"].includes(status);

  /** The run's setup from its context step (the prompt kind, allowlist, nonce, routine id and, for routines, the trigger). */
  async function setupOf(runId: string): Promise<RunSetup | undefined> {
    const steps = await store.steps(runId);
    return steps.find((s) => s.kind === "context" && (s.result as RunSetup | null)?.pack)?.result as RunSetup | undefined;
  }

  /** The in-memory handle, or the persisted one after a restart. */
  async function handleOf(runId: string): Promise<RunHandle | undefined> {
    const h = handles.get(runId);
    if (h || !handleStore) return h;
    const loaded = await handleStore.load(runId).catch(() => null);
    if (loaded) handles.set(runId, loaded);
    return loaded ?? undefined;
  }

  /** The in-memory trigger, or the one written into the context step, with the routine read again by id. */
  async function triggerOf(run: AgentRunRow): Promise<{ routine: RoutineDef; trigger: Record<string, unknown> } | undefined> {
    const t = triggers.get(run.id);
    if (t || !run.routineRunId) return t;
    const setup = await setupOf(run.id);
    if (!setup?.routineId || !setup.trigger) return undefined;
    const routine = await opts.routinesView.get(setup.routineId).catch(() => null);
    if (!routine) return undefined;
    const back = { routine, trigger: setup.trigger };
    triggers.set(run.id, back);
    return back;
  }

  const remember = async (handle: RunHandle) => {
    // Run ids start over after POST /v1/sim/reset, so a new run never inherits an old run's trigger, nor the stop a
    // person gave an old run of the same id (it would be cancelled before its first step).
    triggers.delete(handle.runId);
    cancelled.delete(handle.runId);
    handedTo.delete(handle.runId);
    handles.set(handle.runId, handle);
    // A handle that cannot be persisted still works in this process; only restart survival is lost for that run.
    await handleStore?.save(handle).catch(() => undefined);
  };
  const forget = (runId: string) => {
    handles.delete(runId);
    triggers.delete(runId);
    handedTo.delete(runId);
    void handleStore?.drop(runId).catch(() => undefined);
  };

  async function checklist(run: AgentRunRow): Promise<ChecklistState[] | null> {
    const t = await triggerOf(run);
    if (!t || !opts.routinesView.checklist) return null;
    return opts.routinesView.checklist({ routine: t.routine, agentRunId: run.id, routineRunId: run.routineRunId, companyId: run.companyId, trigger: t.trigger });
  }

  /** Unattended runs under a live provider use the deterministic templates unless WEFT_BACKGROUND_LLM=1 (SPEC 9.6). */
  const scripts = opts.scriptSource;
  const templateProvider: ModelProvider = planScripted({ ...scriptedProviderFrom({ source: scripts }), model: "template", label: "Template, no model" }, scripts);
  const mainProvider = planScripted(opts.provider, scripts);
  /** Pool providers, each wrapped for plan variants once, as the main provider is. */
  const wrappedPool = new Map<ModelProvider, ModelProvider>();
  const wrap = (p: ModelProvider): ModelProvider => {
    if (p === opts.provider) return mainProvider;
    if (!wrappedPool.has(p)) wrappedPool.set(p, planScripted(p, scripts));
    return wrappedPool.get(p)!;
  };
  const useTemplates = (p: ModelProvider, attended: boolean) => p.live && !attended && env.WEFT_BACKGROUND_LLM !== "1";
  /** The provider a run continues on: the one its row pins (the pool's by id on hosted, else the main provider). */
  const providerFor = (run: { provider: string; model: string }): ModelProvider => {
    if (run.model === "template") return templateProvider;
    if (run.model === "resolver") return resolverProvider(null);
    const p = opts.providers?.byId(run.provider, run.model);
    return p ? wrap(p) : mainProvider;
  };
  /** The provider a new run is created on: chosen once (hosted pool) and pinned on its row. */
  const chooseProvider = async (kind: PromptKind, attended: boolean): Promise<ModelProvider> => (opts.providers ? opts.providers.choose({ kind, attended }) : opts.provider);
  const effortFor = (p: ModelProvider): AgentRunRow["effort"] => (effortOverride && (p === opts.provider || (opts.providers !== undefined && p.id === "openai")) ? effortOverride : "low");

  /**
   * The run-start recall, with the reason when it adds nothing (wave 4 round 1, FM11): the tracer shows an empty
   * RETRIEVER span instead of no span. A recall source that throws leaves the pack unchanged; the run still starts.
   */
  async function recallFor(runId: string, input: { kind: "chat" | "routine"; query: string; subjectRefs: string[] }): Promise<string> {
    const note = (n: Omit<RecallNote, "query">) => noteRunRecall(runId, { query: input.query, ...n });
    if (!opts.contextSource?.recall) { note({ reason: "no_recall_source", chars: 0 }); return ""; }
    let block = "";
    try {
      block = await opts.contextSource.recall({ companyId, runId, ...input });
    } catch (e) {
      note({ reason: "recall_error", chars: 0, detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
      return "";
    }
    note(block ? { reason: null, chars: block.length } : { reason: "no_block", chars: 0 });
    return block;
  }

  /**
   * The cursor assistant's handoff (loop.ts handOff): a chat run in the same thread for the same person, started with
   * the assist exchange as its earlier turn and the compact page facts, tainted when the assist run was.
   */
  const handoff = async (run: AgentRunRow, handle: RunHandle, h: { reason: string; task: string; forced: boolean }): Promise<string | null> => {
    if (!opts.contextSource?.handoff) return null;
    const setup = await setupOf(run.id);
    // The request as the person wrote it, stored on the context step (never read out of the pack, where screen text sits).
    const question = (setup?.request ?? "").trim();
    if (!question) return null;
    const state = await opts.executor.runState(handle).catch(() => ({ tainted: true, taintedBy: "run" }));
    // A handoff code decided carries a task code wrote from the person's own words (for a choice, their earlier
    // request and the one they picked), so that task is the chat run's request; a model's task stays in the earlier
    // turn only, and the person's question is the request (it also picks the chat tools, as for any question).
    const text = h.forced ? h.task.trim() || question : question;
    // The person may stop the assist run while the handoff is being admitted and opened (a network call on hosted):
    // checked before the port, again just before the chat run starts, and once more after, when one it started is
    // cancelled too. A stopped request never leaves a chat run working for the person.
    const stopped = () => cancelled.has(run.id);
    if (stopped()) return null;
    let started = null as string | null;
    const to = await opts.contextSource.handoff({ companyId, fromRunId: run.id, question: text, threadId: run.threadId, taintedBy: state.tainted ? (state.taintedBy ?? "run") : null }, async (chatHandle, allowlist) => {
      if (stopped()) return;
      started = chatHandle.runId;
      await runtime.startChat(chatHandle, {
        text, recipe: "chat", pageContext: handoffPageLine(setup?.brief), ...(allowlist ? { allowlist } : {}),
        ...(run.threadId ? { threadId: run.threadId } : {}), handoff: { fromRunId: run.id, reason: h.reason, task: h.task, question },
      });
    });
    if (!stopped()) { if (to) handedTo.set(run.id, to); return to; }
    if (started) await runtime.cancel(started).catch(() => undefined);
    return null;
  };

  const loopDeps = {
    store, executor: opts.executor, provider: mainProvider, ledger: opts.ledger, clock: opts.clock, prices, checklist, handoff,
    isCancelled: (id: string) => cancelled.has(id),
    signalFor: (id: string) => aborts.get(id)?.signal,
    // A local model gets its 180 s step budget (harness 11.4) plus a margin, so the provider's own timer reports first.
    modelTimeoutMs: opts.modelTimeoutMs ?? Number(env.WEFT_T_MODEL_MS ?? (opts.provider.id === "openai_compat" ? 190_000 : 120_000)),
  };

  const notifySettled = (row: AgentRunRow) => {
    if (terminal(row.status)) forget(row.id);
    const ws = settledWaiters.get(row.id) ?? [];
    settledWaiters.delete(row.id);
    for (const w of ws) w(row);
  };

  /**
   * Hands the run's job to the host (Node: into the queue at once). `live` says whether it makes model fetches: the
   * alarm host starts at most one live run per invocation.
   */
  function enqueue(runId: string, live: boolean, restored?: RunHandle) {
    const handle = restored ?? handles.get(runId);
    if (!handle) throw new Error(`no run handle for ${runId}`);
    aborts.set(runId, new AbortController());
    const job = async () => {
      try {
        const current = await store.getRun(runId);
        // A resolved assist run plays the resolution stored on its context step (no model call).
        const used = current?.model === "resolver" ? resolverProvider((await setupOf(runId))?.resolved) : current ? providerFor(current) : mainProvider;
        const row = await runLoop({ ...loopDeps, provider: used, prices: opts.providers ? pricesOf(used) : prices }, handle);
        // Template fallback (SPEC 9.6): a routine whose real model failed (live, or a local server that is down)
        // finishes on the deterministic templates. The scripted provider never falls back, so scenarios stay exact.
        if (row.trigger.startsWith("routine:") && row.model !== "template" && (used.live || used.id === "openai_compat") && row.status === "failed"
          && (row.terminalReason === "PROVIDER_DOWN" || row.terminalReason === "MODEL_INCOMPLETE")) {
          await store.updateRun(runId, { provider: templateProvider.id, model: templateProvider.model, status: "queued", terminalReason: null, endedAt: null });
          enqueue(runId, false);
          return;
        }
        notifySettled(row);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await store.updateRun(runId, { status: "failed", terminalReason: "REPEATED_ERRORS", summary: msg.slice(0, 2000), endedAt: opts.clock.now() });
        await store.appendStep(runId, { stage: "terminal", kind: "error", parentN: null, callId: null, toolName: null, toolArgs: null, outcome: "error", result: { message: msg.slice(0, 2000) }, native: null, usage: null, costUsdMicros: 0, attempt: 1, requestId: null, prefixHash: null, timings: null });
        const row = await store.getRun(runId);
        if (row) notifySettled(row);
      }
    };
    host.submit({
      runId, live,
      start: () => {
        inQueue.add(runId);
        return queue.push(runId, job).catch(() => undefined).finally(() => { if (queue.position(runId) === null) inQueue.delete(runId); });
      },
    });
  }

  function baseRow(handle: RunHandle, p: { trigger: string; attended: boolean; routineRunId: string | null; routineId: string | null; kind: PromptKind; provider: ModelProvider; budget?: { steps: number; usd: number; minutes: number }; threadId?: string | null }): AgentRunRow {
    const b = p.budget ?? BUDGETS[p.kind];
    const provider = p.kind === "routine" && useTemplates(p.provider, p.attended) ? templateProvider : p.provider;
    return {
      id: handle.runId, companyId, kind: "main", parentRunId: null, threadId: p.threadId ?? null, routineRunId: p.routineRunId, trigger: p.trigger, attended: p.attended,
      provider: provider.id, model: provider.model, effort: effortFor(provider), cacheKey: `weft:main:${p.routineId ?? (p.kind === "routine_draft" ? "routine_draft" : p.kind === "assist" ? "assist" : "chat")}:${companyId}`,
      status: "queued", terminalReason: null, tainted: false, taintedBy: null, checklist: null, budget: { steps: b.steps, usd: b.usd, minutes: b.minutes },
      stepsUsed: 0, requeues: 0, consecutiveErrors: 0, costUsdMicros: 0, tokens: { ...ZERO_USAGE }, createdAt: opts.clock.now(), endedAt: null, summary: null,
    };
  }

  async function writeContext(runId: string, setup: RunSetup) {
    await store.appendStep(runId, { stage: "assemble", kind: "context", parentN: null, callId: null, toolName: null, toolArgs: null, outcome: "ok", result: setup, native: null, usage: null, costUsdMicros: 0, attempt: 1, requestId: null, prefixHash: null, timings: null });
  }

  const runtime: WeftAgentRuntime = {
    store,
    queue: visibleQueue,
    async boot() {
      // Running and queued runs both belonged to the previous process: nothing would ever pick a queued run up again
      // (its handle and queue slot are gone), so it fails visibly with PROCESS_RESTART instead of sitting queued.
      for (const r of await store.runsWithStatus(["running", "queued"])) {
        await store.updateRun(r.id, { status: "failed", terminalReason: "PROCESS_RESTART", endedAt: opts.clock.now(), summary: r.status === "queued" ? "The process restarted before this run started. Run it again." : "The process restarted while this run was active. Run it again." });
        if (r.routineRunId) await store.failRoutineRun(r.routineRunId, "The process restarted while this run was active. Run again.", opts.clock.now());
        await handleStore?.drop(r.id).catch(() => undefined);
      }
      // Waiting and held runs are not active, so they survive: their handle and trigger come back from the handle
      // store and the context step, and the next decision wakes them as if the process had never stopped.
      for (const r of await store.runsWithStatus(["waiting", "held"])) {
        await handleOf(r.id);
        await triggerOf(r).catch(() => undefined);
      }
    },
    async startChat(handle, input) {
      await remember(handle);
      const kind: PromptKind = input.recipe === "routine_draft" ? "routine_draft" : input.recipe === "assist" && input.assist ? "assist" : "chat";
      // A conversation thread (the Agent page) is recorded on the run row; the side panel and every other caller pass none.
      // An assist exchange carries one too, so Continue in Agent opens it as a conversation.
      const threadId = (kind === "chat" || kind === "assist") && typeof input.threadId === "string" && input.threadId ? input.threadId : null;
      // An assist exchange in a conversation reads the thread's earlier turns like a chat follow-up, so a choice or a
      // short follow-up continues the request before it (a source that throws leaves them out).
      const prior = kind === "assist" && threadId && opts.contextSource?.earlier ? await opts.contextSource.earlier({ companyId, runId: handle.runId, threadId }).catch(() => []) : [];
      // A turn that read untrusted content gives no turn of its own, but the person's request in it still leads: a
      // choice after "give Lena a raise" handed to a tainted chat run continues the raise, never opens Lena instead.
      const asked = kind === "assist" && threadId && opts.contextSource?.lastRequest ? await opts.contextSource.lastRequest({ companyId, runId: handle.runId, threadId }).catch(() => null) : null;
      const earlierAssist = asked && asked !== prior.at(-1)?.question ? [...prior, { question: asked, answer: LEFT_OUT_ANSWER }] : prior;
      // The cursor assistant's instant path: a where or how question the resolver answers is pinned to its stand-in.
      const resolved: AssistResolution | null = kind === "assist" ? resolveAssist(input.text, input.assist!, { hosted: !!opts.providers, earlier: earlierAssist.at(-1)?.question ?? null }) : null;
      const provider = resolved ? resolverProvider(resolved) : opts.providers ? await chooseProvider(kind, true) : opts.provider;
      const row = baseRow(handle, { trigger: "chat", attended: true, routineRunId: null, routineId: null, kind, provider, threadId });
      await store.createRun(row);
      const nonce = (handle as { nonce?: string }).nonce ?? newNonce();   // harness 6.3: one nonce per run, shared with the executor wrapper
      let text: string;
      let principal: string | null = null;
      if (kind === "assist") {
        const c = (await opts.contextSource?.chat({ companyId, runId: handle.runId })) ?? { actingFor: "the person in this chat", grants: {}, companySummary: "No company summary is available.", openLoops: [] };
        principal = principalOf(c);
        const earlier = earlierAssist.length ? earlierConversationBlock(earlierAssist) : "";
        text = assistPack({ nonce, now: opts.clock.now(), actingFor: c.actingFor, grants: c.grants, request: input.text, assist: input.assist!, ...(earlier ? { earlier } : {}) });
        noteRunRecall(handle.runId, { query: input.text, reason: "assist_run", chars: 0 });
      } else if (kind === "chat") {
        const c = (await opts.contextSource?.chat({ companyId, runId: handle.runId })) ?? { actingFor: "the person in this chat", grants: {}, companySummary: "No company summary is available.", openLoops: [] };
        principal = principalOf(c);
        if (typeof input.pageContext === "string" && input.pageContext.startsWith(PORTAL_PAGE_MARKER)) {
          // Wave 4 (w4-parity-agent, T9): a portal run gets the portal pack and role. No company summary, no open-loops
          // board and no recall block, since those can name other people; the portal tools read only the asker's record.
          text = `${portalPack({ nonce, now: opts.clock.now(), actingFor: c.actingFor, request: input.text })}\n${ROLE_PORTAL}`;
          noteRunRecall(handle.runId, { query: input.text, reason: "portal_run", chars: 0 });
        } else {
          // A follow-up reads the thread's earlier turns (question and final answer only, bounded); a source that
          // throws leaves them out and the run still starts.
          const prior = threadId && opts.contextSource?.earlier ? await opts.contextSource.earlier({ companyId, runId: handle.runId, threadId }).catch(() => []) : [];
          // A handoff from the cursor assistant: that exchange is the earlier turn this run continues.
          const turns = input.handoff ? [...prior, { question: input.handoff.question ?? input.text, answer: `The assistant at the pointer handed this to you (${input.handoff.reason}): ${input.handoff.task}` }] : prior;
          const earlier = turns.length ? earlierConversationBlock(turns) : "";
          text = chatPack({ nonce, now: opts.clock.now(), actingFor: c.actingFor, grants: c.grants, companySummary: c.companySummary, openLoops: c.openLoops, request: input.text, pageContext: input.pageContext, ...(earlier ? { earlier } : {}) });
          text = withRecall(text, await recallFor(handle.runId, { kind: "chat", query: input.text, subjectRefs: [] }));
        }
      } else {
        const channels = (await opts.contextSource?.channels?.(companyId)) ?? ["#people-ops", "#new-hires", "#payroll"];
        text = routineDraftPack({ nonce, now: opts.clock.now(), actingFor: "the person in this chat", request: input.text, channels, tools: [...CHAT_TOOLS, "comms.send_message"] });
      }
      const allowlist = kind === "chat" ? [...(input.allowlist ?? CHAT_TOOLS)] : kind === "assist" ? [...(input.allowlist ?? ASSIST_TOOLS)] : [...DRAFT_TOOLS];
      // An assist run keeps the compact page facts a handoff passes on: the route, the kind and id under the pointer
      // and the record ids, never a label or any other text of the screen map.
      const brief = kind === "assist" && input.assist ? {
        route: input.assist.screen.route,
        under: input.assist.cursor.under ? { entity: input.assist.cursor.under.entity, kind: input.assist.cursor.under.kind } : null,
        recordIds: [...new Set(input.assist.records.flatMap((r) => r.rows.map((x) => x.id)))].slice(0, 20),
      } : undefined;
      await writeContext(handle.runId, {
        promptKind: kind, allowlist, nonce, routineId: null, text, pack: true, principal, ...(resolved ? { resolved } : {}), ...(brief ? { brief, request: input.text } : {}),
        ...(input.handoff ? { handoffFrom: { runId: input.handoff.fromRunId, reason: input.handoff.reason, task: input.handoff.task } } : {}),
      });
      enqueue(handle.runId, providerFor(row).live);
    },
    async startRoutineRun(handle, input: { routine: RoutineDef; routineRun: RoutineRun; trigger: WeftEvent | null; precheck: PrecheckResult }) {
      await remember(handle);
      if (input.precheck.action !== "run") throw new Error("startRoutineRun needs a precheck with action run");
      const trigger: Record<string, unknown> = input.trigger ? { event: input.trigger.type, event_id: input.trigger.id, subject_ref: input.trigger.subjectRef, ...input.trigger.payload } : { trigger_ref: input.routineRun.triggerRef, attended: input.routineRun.attended };
      triggers.set(handle.runId, { routine: input.routine, trigger });
      const row = baseRow(handle, {
        trigger: `routine:${input.routineRun.id}`, attended: input.routineRun.attended, routineRunId: input.routineRun.id, routineId: input.routine.id, kind: "routine",
        provider: opts.providers ? await chooseProvider("routine", input.routineRun.attended) : opts.provider, budget: input.routine.budget,
      });
      await store.createRun(row);
      const nonce = (handle as { nonce?: string }).nonce ?? newNonce();   // harness 6.3: one nonce per run, shared with the executor wrapper
      // Recall first (wave 4 round 2): a recalled procedure is listed in the derived arguments and cited by them.
      const recall = await recallFor(handle.runId, { kind: "routine", query: routineRecallQuery(input.routine.name, input.precheck.findings), subjectRefs: input.precheck.subjectRefs ?? [] });
      const packed = routinePack({
        nonce, now: opts.clock.now(), actingFor: input.routine.ownerPrincipalId, limits: { ...BUDGETS.routine, ...input.routine.budget, toolCallsPerStep: BUDGETS.routine.toolCallsPerStep },
        routine: { id: input.routine.id, name: input.routine.name, instructions: input.routine.instructions }, trigger,
        precheck: { severity: input.precheck.severity, findings: input.precheck.findings, derivedArgs: withRecalledProcedures(input.precheck.derivedArgs ?? null, recall) }, checklist: input.routine.checklist,
      });
      const text = withRecall(packed, recall);
      await writeContext(handle.runId, { promptKind: "routine", allowlist: [...input.routine.tools], nonce, routineId: input.routine.id, text, pack: true, trigger, principal: input.routine.ownerPrincipalId ?? null });
      enqueue(handle.runId, providerFor(row).live);
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
      const setup = await setupOf(runId);
      const handle = await handleOf(runId);
      if (run.routineRunId) await triggerOf(run);
      await store.updateRun(runId, { status: "queued", requeues });
      await store.appendStep(runId, { stage: "post", kind: "notice", parentN: null, callId: null, toolName: null, toolArgs: null, outcome: "ok", result: { notice: notice.kind, attrs: { ...notice.attrs, n: setup?.nonce ?? "" }, text: notice.text }, native: null, usage: null, costUsdMicros: 0, attempt: 1, requestId: null, prefixHash: null, timings: null });
      if (!handle) {
        await store.updateRun(runId, { status: "failed", terminalReason: "PROCESS_RESTART", endedAt: opts.clock.now(), summary: "The run handle was lost in a restart. Run it again." });
        notifySettled((await store.getRun(runId))!);
        return;
      }
      enqueue(runId, providerFor(run).live, handle);
    },
    async wake(runId, notice) {
      const run = await store.getRun(runId);
      if (!run || run.status !== "waiting") return "ignored";
      const handle = await handleOf(runId);
      const items = await checklist(run);
      const pending = handle ? (await opts.executor.runState(handle)).pendingProposalIds : [];
      if (!items || items.every((i) => i.passed)) {
        if (pending.length > 0) return "waiting";
        await store.updateRun(runId, { status: "done", terminalReason: "DONE", checklist: items ?? run.checklist, endedAt: opts.clock.now() });
        await store.appendStep(runId, { stage: "terminal", kind: "verify", parentN: null, callId: null, toolName: null, toolArgs: null, outcome: "ok", result: { status: "done", reason: "DONE", zeroTokenWake: true }, native: null, usage: null, costUsdMicros: 0, attempt: 1, requestId: null, prefixHash: null, timings: null });
        await traceWakeSegment(store, runId, items);   // wave 4 telemetry: the wake is its own AGENT segment
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
      // Read before the first await: the assist run may settle (and forget it) while the row is read.
      const opened = handedTo.get(runId);
      const run = await store.getRun(runId);
      if (run && ["queued", "waiting", "held"].includes(run.status) && queue.position(runId) === null) {
        await store.updateRun(runId, { status: "cancelled", terminalReason: "CANCELLED", endedAt: opts.clock.now() });
        notifySettled((await store.getRun(runId))!);
      }
      // An assist run that already handed off: its chat run is the same request still going, so it stops too. The
      // cursor assistant sends this only while the person has not seen the handoff (no progress card, no Stop yet);
      // once they have, a dismissal leaves the chat run going and its own Stop cancels it by its id.
      const to = opened ?? (run?.terminalReason === "HANDED_OFF" ? handedToOf(await store.steps(runId)) : null);
      if (to && to !== runId) await runtime.cancel(to);
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
    traceRoutineRun: (t) => traceRoutineRunSpan(t),
    async drain(timeoutMs = 5_000) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = await Promise.race([queue.idle().then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), timeoutMs); })]);
      clearTimeout(timer);
      // Past the bound, abort what is still running so no provider call outlives the database; the boot rule fails
      // those runs with PROCESS_RESTART on the next start.
      if (!idle) for (const c of aborts.values()) c.abort();
      return idle;
    },
  };
  return runtime;
}
