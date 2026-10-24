// /v1 agent routes. Owner: t4-agent. Paths from packages/contracts/src/api.ts.
// Runs execute in the background: POST returns { runId } at once; the UI follows GET .../events (SSE) and falls back
// to polling GET .../trace every second. The trace adds the stage summary (timings, tokens, cache-hit ratio, USD) and
// the run's proposals from the executor's table.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { CHAT_TOOLS, Forbidden, NotFound, ReportResult, Unauthorized, ValidationError, type ApprovalCardW3, type ExecutorBundle, type HumanSession, type Proposal, type RunStepRow } from "@weft/contracts";
import { agentRuns, execRuns, notices, offboardingCases, payrollRuns, principals, proposals, routines, runArtifacts, withWriteLock, workers, type Db } from "@weft/db";
import { assistUntrustedSource, closingShow, createRunStore, summarize, type ChatContextSource, type WeftAgentRuntime } from "@weft/agent";
import { proposalVisible, readScopeFor } from "@weft/core";
import { approvalCardOf, assistScreenKey, executorInternals, fileRunFiles } from "@weft/executor";
import { ASSIST_TOOLS, AssistInput, assistKnownRecords, assistRecordIds, cleanAssistInput, SCREEN_LIMITS, type AssistHandoffLink, type AssistRunAccepted, type AssistTraceExtras } from "../../../../packages/contracts/src/ext/assist";
import { RUN_LONG_POLL_MAX_S } from "../../../../packages/contracts/src/ext/cf-agent";
import type { RunAdmission } from "../../../../packages/contracts/src/ext/cf-platform";
import type { Weft, WeftEnv } from "../http/context";
import { chooseChatTools } from "../agent/chat-allowlist";
import { sse } from "../http/sse";
import { stubRoutes } from "../http/stub";
import { createMemoryRecall } from "../memory/recall";
import { viewerScope } from "../http/scope";
import { earlierTurns, lastRequest, questionsOf, runsActingFor, threadBelongsToSomeoneElse } from "../agent/threads";
import { AGENT_RUN_TRIGGERS, isThreadId, THREAD_ID_RE, type AgentRunTriggerFilter, type ConversationRunRow } from "../../../../packages/contracts/src/ext/agent-page";

// Steps carry raw model call args, so the trace and the SSE stream go through the executor's redactor (harness 9).
// Route tests that pass a fake executor without a redactor get the value unchanged.
function redactSafe<T>(weft: Weft, v: T): T {
  const r = (weft.executor as { redact?: (s: string) => string }).redact;
  return typeof r === "function" ? (JSON.parse(r.call(weft.executor, JSON.stringify(v))) as T) : v;
}

// threadId (the Agent page): a conversation thread the client minted (`thr_` and 8 to 40 characters); null or omitted
// starts a single run, as the side panel, MCP and every older caller do.
// recipe "assist" (the cursor assistant, ext/assist.ts): the body also carries the screen map, the cursor context, the
// page's records and the trail, validated here and capped at SCREEN_LIMITS.bodyBytes; any other recipe is chat.
const StartBody = z.object({
  text: z.string().min(1).max(4000), pageContext: z.string().max(400).nullable().optional(), threadId: z.string().regex(THREAD_ID_RE, "threadId is thr_ and 8 to 40 letters, digits, _ or -").nullable().optional(),
  recipe: z.enum(["chat", "assist"]).optional(), assist: AssistInput.optional(),
});
/** A conversation id as the Agent page mints them: thr_ and 20 hex characters. */
function newThreadId(): string {
  const b = new Uint8Array(10);
  globalThis.crypto.getRandomValues(b);
  return `thr_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
const TERMINAL = new Set(["waiting", "held", "done", "failed", "refused", "escalated", "expired", "cancelled"]);
const parse = <T>(s: string | null, d: T): T => { if (!s) return d; try { return JSON.parse(s) as T; } catch { return d; } };

type ProposalRow = typeof proposals.$inferSelect;
function toProposal(r: ProposalRow): Proposal {
  return {
    id: r.id, companyId: r.companyId, kind: r.kind as Proposal["kind"], command: r.command, args: parse(r.argsJson, null), argsHash: r.argsHash, subjectRef: r.subjectRef,
    subjectHash: r.subjectHash, risk: r.risk as Proposal["risk"], moneyCents: r.moneyCents, reversible: Boolean(r.reversible), headline: r.headline,
    diff: parse(r.diffJson, []), content: parse(r.contentJson, []), evidence: parse(r.evidenceJson, []), agentNote: r.agentNote, taintedBy: r.taintedBy,
    proposerRunId: r.proposerRunId, routineRunId: r.routineRunId, onBehalfOf: r.onBehalfOf, supersedes: r.supersedes, createdAt: r.createdAt, expiresAt: r.expiresAt,
    status: r.status as Proposal["status"], decidedBy: r.decidedBy, decidedAt: r.decidedAt, decisionCode: r.decisionCode, decisionNote: r.decisionNote,
    executedActionSeq: r.executedActionSeq,
  };
}

/**
 * The chat pack's deterministic company summary and open-loops board from DB rows (harness 7.2). The brain never reads
 * domain tables, so apps/api builds this and the integrator passes it as createAgentRuntime({ contextSource }).
 */
export type { RunAdmission };

export interface ChatContextDeps {
  /** The executor bundle, for the cursor assistant's handoff (a chat run for the same person, tainted when the assist run was). */
  executor?: Pick<ExecutorBundle, "runs" | "registry">;
  liveProvider?: () => boolean;
  /** The host's gates for the handoff's chat run; a refusal leaves the assist run to end with its own answer. */
  admitRun?: RunAdmission;
}

export function createChatContextSource(db: Db, deps: ChatContextDeps = {}): ChatContextSource {
  return {
    async chat({ companyId, runId }) {
      const [run] = await db.select().from(execRuns).where(eq(execRuns.id, runId)).limit(1);
      const who = run?.onBehalfOf ? (await db.select().from(principals).where(eq(principals.id, run.onBehalfOf)).limit(1))[0] : undefined;
      const active = await db.select({ state: workers.workState }).from(workers).where(and(eq(workers.companyId, companyId), eq(workers.status, "active")));
      const byState = new Map<string, number>();
      for (const w of active) byState.set(w.state ?? "none", (byState.get(w.state ?? "none") ?? 0) + 1);
      const drafts = await db.select().from(payrollRuns).where(and(eq(payrollRuns.companyId, companyId), eq(payrollRuns.status, "draft")));
      const open = await db.select().from(proposals).where(and(eq(proposals.companyId, companyId), eq(proposals.status, "pending"))).orderBy(desc(proposals.createdAt));
      const openNotices = await db.select({ id: notices.id, kind: notices.kind, respondBy: notices.respondBy }).from(notices).where(and(eq(notices.companyId, companyId), inArray(notices.status, ["new", "in_review", "proposed"])));
      const summary = [
        `active headcount ${active.length} (${[...byState.entries()].sort().map(([k, v]) => `${k} ${v}`).join(", ")})`,
        `open payroll drafts: ${drafts.map((d) => `${d.id} payday ${d.payday} approval deadline ${d.approvalDeadline}`).join("; ") || "none"}`,
        `pending approvals: ${open.length}`,
        `open notices: ${openNotices.map((n) => `${n.id} ${n.kind}${n.respondBy ? ` respond by ${n.respondBy}` : ""}`).join("; ") || "none"}`,
      ].join("\n");
      return {
        actingFor: who ? `${who.display} (${who.id}), role ${who.role ?? "none"}` : (run?.onBehalfOf ?? "the person in this chat"),
        grants: who ? (JSON.parse(who.grantsJson) as Record<string, string>) : {},
        companySummary: summary,
        openLoops: open.slice(0, 20).map((p) => ({ id: p.id, title: p.headline, owner: p.onBehalfOf ?? "people ops", due: p.expiresAt })),
      };
    },
    async channels() { return ["#general", "#new-hires", "#payroll", "#people-ops"]; },
    recall: createMemoryRecall(db),   // wave 2 (w2-memory); "" until that track lands recall
    earlier: (input) => earlierTurns(db, input),   // the Agent page's conversation threads (agent/threads.ts)
    lastRequest: (input) => lastRequest(db, input),   // a cursor assistant choice continues the request before it
    // The cursor assistant's handoff: an ordinary chat run for the person the assist run acted for, with the chat
    // tools code picks for the question (proposals only when Chat can propose is on), the same caps, in the same
    // thread, tainted when the assist run was. It gains no power the person's own chat question would not have.
    ...(deps.executor ? { handoff: async (input, start) => {
      const [er] = await db.select({ onBehalfOf: execRuns.onBehalfOf, companyId: execRuns.companyId, surface: execRuns.surface }).from(execRuns).where(eq(execRuns.id, input.fromRunId)).limit(1);
      if (!er?.onBehalfOf) return null;
      // One more run: the same admission as a person's own POST /v1/agent/runs (on hosted, RL_RUN and the rows budget).
      if (deps.admitRun && !(await deps.admitRun({ kind: "assist_handoff", fromRunId: input.fromRunId }).catch(() => ({ ok: false as const })))?.ok) return null;
      // The chat run keeps the assist run's surface: an MCP run (the route takes assist only from the app, so this is
      // a second guard) stays an MCP run, which never gets the act list, as the same key's own chat question would not.
      const mcp = er.surface === "mcp";
      const session: HumanSession = { principalId: er.onBehalfOf, companyId: er.companyId, via: mcp ? "api_key" : "ui", keyScope: mcp ? "mcp" : null };
      const choice = await chooseChatTools({ db, registry: deps.executor!.registry, liveProvider: deps.liveProvider?.() === true }, session, input.question);
      const allowlist = choice.allowlist ?? [...CHAT_TOOLS];
      const handle = await deps.executor!.runs.openChatRun(session, { threadId: input.threadId, surface: mcp ? "mcp" : "human_ui", allowlist });
      if (input.taintedBy) await executorInternals(deps.executor as ExecutorBundle)?.taintRun(handle.runId, `run:${input.fromRunId}`);
      await start(handle, choice.allowlist ?? null);
      return handle.runId;
    } } satisfies Pick<ChatContextSource, "handoff"> : {}),
  };
}

/**
 * Which of the ids a cursor assistant request names (assistRecordIds: record pages, threads, the selected paycheck)
 * exist in this company. Looked up by prefix, one query each, so a sender's words spelled as an id are found out.
 */
async function knownAssistRecords(db: Db, companyId: string, ids: readonly string[]): Promise<Set<string>> {
  const of = (p: string) => ids.filter((id) => id.startsWith(p));
  const found = new Set<string>();
  const add = (rows: { id: string | null }[]) => { for (const r of rows) if (r.id) found.add(r.id); };
  const look = async (p: string, q: (xs: string[]) => Promise<{ id: string | null }[]>) => { const xs = of(p); if (xs.length) add(await q(xs)); };
  await look("wrk_", (xs) => db.select({ id: workers.id }).from(workers).where(and(eq(workers.companyId, companyId), inArray(workers.id, xs))));
  await look("pay_", (xs) => db.select({ id: payrollRuns.id }).from(payrollRuns).where(and(eq(payrollRuns.companyId, companyId), inArray(payrollRuns.id, xs))));
  await look("run_", (xs) => db.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.companyId, companyId), inArray(agentRuns.id, xs))));
  await look("rt_", (xs) => db.select({ id: routines.id }).from(routines).where(and(eq(routines.companyId, companyId), inArray(routines.id, xs))));
  await look("ofb_", (xs) => db.select({ id: offboardingCases.id }).from(offboardingCases).where(and(eq(offboardingCases.companyId, companyId), inArray(offboardingCases.id, xs))));
  await look("thr_", (xs) => db.select({ id: agentRuns.threadId }).from(agentRuns).where(and(eq(agentRuns.companyId, companyId), inArray(agentRuns.threadId, xs))));
  return found;
}

export function agentRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  const store = createRunStore(weft.db);
  const runtime = weft.agent as Partial<WeftAgentRuntime>;
  const getRun = async (id: string, c?: Context<WeftEnv>) => {
    const run = await store.getRun(id);
    if (!run) throw new NotFound(`No agent run ${id}`);
    if (c) { const mine = await ownRuns(c); if (mine && !mine.has(run.id)) throw new NotFound(`No agent run ${id}`); }
    return run;
  };
  /**
   * The runs a narrowed person (a manager) may read: the ones that acted for her. Anyone else's chat, routine and
   * MCP runs carry their tool results (pay, leave, terminations) and summaries, so they are not hers to read. Null
   * for the People and payroll roles, who read every run.
   */
  const ownRuns = async (c: Context<WeftEnv>): Promise<Set<string> | null> => {
    const scope = await viewerScope(weft, c);
    if (!scope) return null;
    // A run records its person on the executor's run row; a run with no executor row, on the agent run row.
    return runsActingFor(weft.db, c.var.session?.companyId ?? "cmp_larkspur", scope.viewerId);
  };

  r.post("/v1/agent/runs", async (c) => {
    const session = c.get("session");
    if (!session) throw new Unauthorized();
    // No valid body is larger than an assist request, so a bigger one is refused before it is parsed.
    const raw = await c.req.text();
    if (new TextEncoder().encode(raw).length > SCREEN_LIMITS.bodyBytes) {
      return c.json({ _tag: "ValidationError", ok: false, message: `The body is at most ${SCREEN_LIMITS.bodyBytes} bytes` }, 413);
    }
    let json: unknown;
    try { json = JSON.parse(raw); } catch { throw new ValidationError("The body is JSON: { text, pageContext?, threadId?, recipe?, assist? }"); }
    const body = StartBody.parse(json);
    // A thread is one person's conversation: a follow-up into a thread whose runs acted for someone else is refused as
    // if the thread did not exist (its earlier turns would otherwise reach this person's context pack).
    if (body.threadId && await threadBelongsToSomeoneElse(weft.db, session.companyId, body.threadId, session.principalId)) throw new NotFound(`No conversation ${body.threadId}`);
    if (body.recipe === "assist") {
      // The cursor assistant: one run with the assist recipe's frozen tools (the chat reads and the presentation
      // tools), the request's screen map in the run workspace for the executor's checks, and taint when the request
      // carries text people typed (a selection, an untrusted label), as for any untrusted read. It is the app's own
      // assistant, so only a person signed in to the app starts one: an API key (MCP, CLI) asks through chat.
      if (session.via !== "ui" || session.keyScope !== null) throw new Forbidden("The cursor assistant runs only in the app; ask through chat instead", { code: "NOT_PERMITTED" });
      if (!body.assist) throw new ValidationError("recipe assist needs assist: { screen, cursor, records, trail }");
      // The page's route and view state as the registry knows them (cleanAssistInput), and only with records that
      // exist (assistKnownRecords): text in a link someone sent never reaches the model, the handoff or the
      // executor's checks as the page's own words, not even spelled as an id.
      const hosted = { hosted: !!weft.platform?.world };
      const cleaned = cleanAssistInput(body.assist, hosted);
      const known = await knownAssistRecords(weft.db, session.companyId, assistRecordIds(cleaned, hosted));
      const input = assistKnownRecords(cleaned, (id) => known.has(id), hosted);
      const registry = weft.executor.registry as { get?: (n: string) => unknown } | undefined;
      const allowlist = ASSIST_TOOLS.filter((n) => !registry?.get || registry.get(n));
      // Every exchange is a conversation (Open in Agent shows it; a handoff and a choice continue it): one is minted
      // when the client sends none, exactly as the Agent page mints them.
      const threadId = body.threadId ?? newThreadId();
      const handle = await weft.executor.runs.openChatRun(session, { threadId, surface: "human_ui", allowlist });
      const files = weft.runFiles ?? fileRunFiles(weft.dataDir);
      const screenKey = assistScreenKey(session.companyId, handle.runId);
      await withWriteLock(() => files.write(screenKey, JSON.stringify(input.screen)));
      const untrusted = assistUntrustedSource(input);
      if (untrusted) await executorInternals(weft.executor)?.taintRun(handle.runId, untrusted);
      await weft.agent.startChat(handle, { text: body.text, recipe: "assist", pageContext: body.pageContext ?? null, allowlist, threadId, assist: input });
      // The screen map is only for this run's own checks: it goes when the run ends, so the run files hold the screens
      // of the runs in flight and no more (on hosted they are rows of a workspace that may last 30 days).
      void runtime.settled?.(handle.runId).then(() => withWriteLock(() => files.removePrefix(screenKey))).catch(() => undefined);
      const accepted: AssistRunAccepted = { runId: handle.runId, chatMode: "assist", threadId };
      return c.json(accepted, 202);
    }
    // Harness 5.3 wave 3 amendment: code picks the chat tools (reads, or proposals when the setting is on and the
    // request reads as an action). With no registry wired (route tests), the wave 1 list stays.
    const choice = await chooseChatTools({ db: weft.db, registry: weft.executor.registry, liveProvider: weft.provider?.live === true }, session, body.text);
    const allowlist = choice.allowlist ?? [...CHAT_TOOLS];
    const handle = await weft.executor.runs.openChatRun(session, { threadId: body.threadId ?? null, surface: "human_ui", allowlist });
    await weft.agent.startChat(handle, { text: body.text, recipe: "chat", pageContext: body.pageContext ?? null, ...(choice.allowlist ? { allowlist } : {}), ...(body.threadId ? { threadId: body.threadId } : {}) });
    return c.json({ runId: handle.runId, chatMode: choice.mode, ...(body.threadId ? { threadId: body.threadId } : {}) }, 202);
  });

  // Filters (the Agent page, all optional; none keeps the list exactly as before): `thread_id` one conversation thread,
  // `trigger=chat` conversations, `trigger=background` routine and notice runs. Conversations are personal: `chat` and
  // `thread_id` keep only the runs that acted for the viewer, and add each run's question and where it was asked
  // (ConversationRunRow). `background` keeps the usual visibility (ownRuns for a narrowed person).
  r.get("/v1/agent/runs", async (c) => {
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 25) || 25));
    const session = c.get("session");
    const rawTrigger = c.req.query("trigger");
    const rawThread = c.req.query("thread_id");
    if (rawTrigger !== undefined && !(AGENT_RUN_TRIGGERS as readonly string[]).includes(rawTrigger)) throw new ValidationError(`trigger is one of ${AGENT_RUN_TRIGGERS.join(", ")}`);
    if (rawThread !== undefined && !isThreadId(rawThread)) throw new ValidationError("thread_id is thr_ and 8 to 40 letters, digits, _ or -");
    const trigger = rawTrigger as AgentRunTriggerFilter | undefined;
    const conversation = trigger === "chat" || rawThread !== undefined;
    const companyId = session?.companyId;
    const scoped = conversation
      ? (session ? await runsActingFor(weft.db, session.companyId, session.principalId) : new Set<string>())
      : await ownRuns(c);
    const filter = { companyId, ...(trigger ? { trigger } : {}), ...(rawThread ? { threadId: rawThread } : {}) };
    const rows = scoped
      ? (await store.listRuns({ ...filter, limit: 100_000 })).filter((x) => scoped.has(x.id)).slice(0, limit + 1)
      : await store.listRuns({ ...filter, limit: limit + 1 });
    const page = rows.slice(0, limit);
    if (!conversation) return c.json({ hasMore: rows.length > limit, count: Math.min(rows.length, limit), data: page });
    const questions = await questionsOf(weft.db, page.filter((x) => x.trigger === "chat"));
    const data: ConversationRunRow[] = page.map((x) => ({ ...x, question: questions.get(x.id)?.question ?? null, askedFrom: questions.get(x.id)?.askedFrom ?? "agent" }));
    return c.json({ hasMore: rows.length > limit, count: Math.min(rows.length, limit), data });
  });

  // Additive long poll (docs/cloudflare/design.md 5.3, remote MCP agent_ask): ?wait=N (1 to 25 seconds) answers when the
  // run reaches a settled status (waiting, held, done or another end state) or when N seconds pass, whichever comes
  // first, so a hosted MCP client asks at most 3 times per question. Without wait the route answers at once, as before.
  r.get("/v1/agent/runs/:id", async (c) => {
    const id = c.req.param("id");
    const first = await getRun(id, c);
    const raw = c.req.query("wait");
    if (raw === undefined) return c.json(first);
    if (!/^\d{1,2}$/.test(raw) || Number(raw) < 1 || Number(raw) > RUN_LONG_POLL_MAX_S) throw new ValidationError(`wait is a whole number of seconds from 1 to ${RUN_LONG_POLL_MAX_S}`);
    if (TERMINAL.has(first.status)) return c.json(first);
    (weft.platform?.guard)?.assertNotInTx("long poll");
    const deadline = Date.now() + Number(raw) * 1000;
    let wake: () => void = () => undefined;
    const stop = weft.agent.subscribe(id, (s) => { if (s.stage === "terminal") wake(); });
    try {
      while (Date.now() < deadline) {
        await new Promise<void>((r) => { wake = r; const t = setTimeout(r, Math.min(1_000, Math.max(0, deadline - Date.now()))); (t as { unref?: () => void }).unref?.(); });
        const row = await store.getRun(id);
        if (row && TERMINAL.has(row.status)) return c.json(row);
      }
    } finally { stop(); }
    return c.json(await getRun(id));
  });

  r.get("/v1/agent/runs/:id/trace", async (c) => {
    const id = c.req.param("id");
    const run = await getRun(id, c);
    const steps = await store.steps(id);
    const filed = await weft.db.select().from(proposals).where(eq(proposals.proposerRunId, id)).orderBy(desc(proposals.createdAt));
    // An assist run that showed an existing proposal's approval card (ui.show approval.card) gets that card too, built
    // from the stored preview like every card, so the person can decide it from the popover.
    const shown = [...new Set(steps.flatMap((s) => {
      const d = (s.result as { outcome?: { ok?: boolean; data?: { intent?: string; params?: { proposalId?: string } } } } | null)?.outcome;
      return s.kind === "tool_call" && s.toolName === "ui__show" && d?.ok && d.data?.intent === "approval.card" && d.data.params?.proposalId ? [d.data.params.proposalId] : [];
    }))].filter((p) => !filed.some((f) => f.id === p));
    // Only those the viewer could read in their own Inbox (the proposals routes' rule): the executor refuses the card
    // for a proposal outside a narrowed person's scope, and a run recorded before that, or a proposal whose subject
    // moved out of their reports since, is narrowed here as well.
    const scope = shown.length ? await readScopeFor(weft.db, run.companyId, c.var.session?.principalId ?? null) : null;
    const extra = shown.length ? (await weft.db.select().from(proposals).where(and(inArray(proposals.id, shown), eq(proposals.companyId, run.companyId)))).filter((p) => proposalVisible(scope, p)) : [];
    const propRows = [...filed, ...extra];
    const props = propRows.map(toProposal);
    // Wave 3: one approval card per proposal, built from the stored preview (never model text).
    const cards: ApprovalCardW3[] = [];
    for (const p of propRows) cards.push(await approvalCardOf(weft.db, p));
    const actions = steps.flatMap((s) => {
      const o = (s.result as { outcome?: { ok: boolean; status?: string; actionSeq?: number | null; summary?: string } } | null)?.outcome;
      return s.kind === "tool_call" && o?.ok && o.status === "done" && typeof o.actionSeq === "number" ? [{ seq: o.actionSeq, command: s.toolName ?? "", summary: o.summary ?? "" }] : [];
    });
    // The cursor assistant: the handoff link on both runs (an assist run's terminal step names the chat run it handed
    // to; that chat run's context step names the assist run), and the closing show code builds from the steps.
    const handedTo = steps.flatMap((s) => { const h = (s.result as { handoff?: { to?: string; reason?: string; forced?: boolean } } | null)?.handoff; return s.stage === "terminal" && h?.to ? [h] : []; })[0] ?? null;
    const from = (steps.find((s) => s.kind === "context" && (s.result as { pack?: boolean } | null)?.pack)?.result as { handoffFrom?: { runId: string; reason: string } } | undefined)?.handoffFrom ?? null;
    const handoff: AssistHandoffLink | null = handedTo || from ? { to: handedTo?.to ?? null, from: from?.runId ?? null, reason: (handedTo?.reason ?? from?.reason ?? null) as AssistHandoffLink["reason"], forced: handedTo?.forced ?? null } : null;
    // The closing show is for the cursor assistant only: a finished assist run (not one that handed off) and the chat
    // run a handoff started. The side panel and the Agent page get none.
    const assistRun = (steps.find((s) => s.kind === "context" && (s.result as { pack?: boolean } | null)?.pack)?.result as { promptKind?: string } | undefined)?.promptKind === "assist";
    const closing = run.trigger === "chat" && (assistRun || from) && TERMINAL.has(run.status) && run.terminalReason !== "HANDED_OFF" ? closingShow(steps, run.summary, { hosted: !!weft.platform?.world }) : null;
    const extras: AssistTraceExtras = { handoff, closing };
    return c.json(redactSafe(weft, { run, steps, proposals: props, cards, actions, children: [], summary: summarize(steps), queuePosition: runtime.queue?.position(id) ?? null, ...extras }));
  });

  r.get("/v1/agent/runs/:id/events", async (c) => {
    const id = c.req.param("id");
    await getRun(id, c);
    return sse<RunStepRow | { status: string }>(c, (send, close) => {
      let live = true;
      let finished = false;
      const seen = new Set<number>();
      // The status event is written before the stream closes; closing on the next tick lets the write flush.
      const finish = (status: string) => {
        if (finished) return;
        finished = true;
        send("status", { status });
        setTimeout(close, 20);
      };
      const forward = (s: RunStepRow) => {
        if (!live || seen.has(s.n)) return;
        seen.add(s.n);
        // Model call args are stored raw by the loop, so every streamed step goes through the redactor (harness 9).
        send("step", redactSafe(weft, s));
        if (s.stage === "terminal") void store.getRun(id).then((row) => { if (row && TERMINAL.has(row.status)) finish(row.status); }).catch(() => undefined);
      };
      const stop = weft.agent.subscribe(id, forward);
      void (async () => {
        for (const s of await store.steps(id)) forward(s);
        const row = await store.getRun(id);
        if (row && TERMINAL.has(row.status) && (runtime.queue?.position(id) ?? null) === null) finish(row.status);
      })().catch(() => undefined);
      return () => { live = false; stop(); };
    });
  });

  r.post("/v1/agent/runs/:id/cancel", async (c) => {
    const id = c.req.param("id");
    await getRun(id);
    await weft.agent.cancel(id);
    return c.json(await getRun(id));
  });

  r.get("/v1/agent/costs", async (c) => {
    const day = c.req.query("day") ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ValidationError("day must be yyyy-mm-dd");
    const [daySettled, liveSettled] = await Promise.all([weft.ledger.spent({ day }), weft.ledger.spent({ live: true })]);
    return c.json({ day, daySpentUsd: daySettled / 1e6, liveSpentUsd: liveSettled / 1e6, provider: { id: weft.provider.id, model: weft.provider.model, label: weft.provider.label, live: weft.provider.live } });
  });

  // Wave 3 (w3-parity-chat): a large tool result the executor saved to the run workspace (harness 7.4). Only the person
  // a chat run acted for may read its artifacts; anyone else in the company needs view on the artifact's domain, and a
  // routine run's artifacts follow the same domain rule. The file path comes from the row, never from the request.
  r.get("/v1/agent/runs/:id/artifacts/:ref", async (c) => {
    const s = c.get("session");
    if (!s) throw new Unauthorized();
    const id = c.req.param("id"), ref = c.req.param("ref");
    const [run] = await weft.db.select({ companyId: execRuns.companyId, onBehalfOf: execRuns.onBehalfOf, routineRunId: execRuns.routineRunId, parentRunId: execRuns.parentRunId }).from(execRuns).where(eq(execRuns.id, id)).limit(1);
    if (!run || run.companyId !== s.companyId) throw new NotFound(`No agent run ${id}`);
    const [a] = await weft.db.select().from(runArtifacts).where(and(eq(runArtifacts.id, ref), eq(runArtifacts.runId, id))).limit(1);
    if (!a) throw new NotFound(`No artifact ${ref} in run ${id}`);
    if (!run.routineRunId && run.onBehalfOf && run.onBehalfOf !== s.principalId) throw new Forbidden(`Run ${id} belongs to another person`, { code: "NOT_PERMITTED" });
    const [me] = await weft.db.select({ grantsJson: principals.grantsJson }).from(principals).where(and(eq(principals.id, s.principalId), eq(principals.companyId, s.companyId))).limit(1);
    const grants = parse<Record<string, string>>(me?.grantsJson ?? null, {});
    if (!grants[a.domain] || grants[a.domain] === "none") throw new Forbidden(`Artifact ${ref} needs view access to ${a.domain}`, { code: "NOT_PERMITTED" });
    // The body comes from the world's RunFileStore by the row's own path (files under the data dir on Node, run_files on
    // hosted); a path that would climb out of the run workspace is refused by the store.
    const body = await (weft.runFiles ?? fileRunFiles(weft.dataDir)).read(a.path);
    let data: unknown;
    try { data = JSON.parse(body ?? ""); } catch { throw new NotFound(`Artifact ${ref} has no readable file`); }
    const chart = ReportResult.safeParse(data);
    return c.json(redactSafe(weft, {
      ref: a.id, runId: a.runId, stepN: a.stepN, kind: chart.success ? "chart" : "rows", summary: a.summary, domain: a.domain, bytes: a.bytes, sha256: a.sha256,
      taintedBy: a.taintedBy, data,
    }));
  });

  return stubRoutes(r, "agent", [
    "POST /v1/agent/runs", "GET /v1/agent/runs", "GET /v1/agent/runs/:id", "GET /v1/agent/runs/:id/trace", "GET /v1/agent/runs/:id/events",
    "POST /v1/agent/runs/:id/cancel", "GET /v1/agent/costs", "GET /v1/agent/runs/:id/artifacts/:ref",
  ]);
}
