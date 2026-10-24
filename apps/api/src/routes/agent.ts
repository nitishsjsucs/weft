// /v1 agent routes. Owner: t4-agent. Paths from packages/contracts/src/api.ts.
// Runs execute in the background: POST returns { runId } at once; the UI follows GET .../events (SSE) and falls back
// to polling GET .../trace every second. The trace adds the stage summary (timings, tokens, cache-hit ratio, USD) and
// the run's proposals from the executor's table.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { CHAT_TOOLS, Forbidden, NotFound, ReportResult, Unauthorized, ValidationError, type ApprovalCardW3, type Proposal, type RunStepRow } from "@weft/contracts";
import { execRuns, notices, payrollRuns, principals, proposals, runArtifacts, workers, type Db } from "@weft/db";
import { createRunStore, summarize, type ChatContextSource, type WeftAgentRuntime } from "@weft/agent";
import { approvalCardOf, fileRunFiles } from "@weft/executor";
import { RUN_LONG_POLL_MAX_S } from "../../../../packages/contracts/src/ext/cf-agent";
import type { Weft, WeftEnv } from "../http/context";
import { chooseChatTools } from "../agent/chat-allowlist";
import { sse } from "../http/sse";
import { stubRoutes } from "../http/stub";
import { createMemoryRecall } from "../memory/recall";
import { viewerScope } from "../http/scope";
import { earlierTurns, questionsOf, runsActingFor, threadBelongsToSomeoneElse } from "../agent/threads";
import { AGENT_RUN_TRIGGERS, isThreadId, THREAD_ID_RE, type AgentRunTriggerFilter, type ConversationRunRow } from "../../../../packages/contracts/src/ext/agent-page";

// Steps carry raw model call args, so the trace and the SSE stream go through the executor's redactor (harness 9).
// Route tests that pass a fake executor without a redactor get the value unchanged.
function redactSafe<T>(weft: Weft, v: T): T {
  const r = (weft.executor as { redact?: (s: string) => string }).redact;
  return typeof r === "function" ? (JSON.parse(r.call(weft.executor, JSON.stringify(v))) as T) : v;
}

// threadId (the Agent page): a conversation thread the client minted (`thr_` and 8 to 40 characters); null or omitted
// starts a single run, as the side panel, MCP and every older caller do.
const StartBody = z.object({ text: z.string().min(1).max(4000), pageContext: z.string().max(400).nullable().optional(), threadId: z.string().regex(THREAD_ID_RE, "threadId is thr_ and 8 to 40 letters, digits, _ or -").nullable().optional() });
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
export function createChatContextSource(db: Db): ChatContextSource {
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
  };
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
    const body = StartBody.parse(await c.req.json());
    // A thread is one person's conversation: a follow-up into a thread whose runs acted for someone else is refused as
    // if the thread did not exist (its earlier turns would otherwise reach this person's context pack).
    if (body.threadId && await threadBelongsToSomeoneElse(weft.db, session.companyId, body.threadId, session.principalId)) throw new NotFound(`No conversation ${body.threadId}`);
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
    const propRows = await weft.db.select().from(proposals).where(eq(proposals.proposerRunId, id)).orderBy(desc(proposals.createdAt));
    const props = propRows.map(toProposal);
    // Wave 3: one approval card per proposal, built from the stored preview (never model text).
    const cards: ApprovalCardW3[] = [];
    for (const p of propRows) cards.push(await approvalCardOf(weft.db, p));
    const actions = steps.flatMap((s) => {
      const o = (s.result as { outcome?: { ok: boolean; status?: string; actionSeq?: number | null; summary?: string } } | null)?.outcome;
      return s.kind === "tool_call" && o?.ok && o.status === "done" && typeof o.actionSeq === "number" ? [{ seq: o.actionSeq, command: s.toolName ?? "", summary: o.summary ?? "" }] : [];
    });
    return c.json(redactSafe(weft, { run, steps, proposals: props, cards, actions, children: [], summary: summarize(steps), queuePosition: runtime.queue?.position(id) ?? null }));
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
