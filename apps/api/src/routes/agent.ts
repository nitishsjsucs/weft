// /v1 agent routes. Owner: t4-agent. Paths from packages/contracts/src/api.ts.
// Runs execute in the background: POST returns { runId } at once; the UI follows GET .../events (SSE) and falls back
// to polling GET .../trace every second. The trace adds the stage summary (timings, tokens, cache-hit ratio, USD) and
// the run's proposals from the executor's table.
import { Hono } from "hono";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { NotFound, Unauthorized, ValidationError, type Proposal, type RunStepRow } from "@weft/contracts";
import { proposals } from "@weft/db";
import { createRunStore, summarize, type WeftAgentRuntime } from "@weft/agent";
import type { Weft, WeftEnv } from "../http/context";
import { sse } from "../http/sse";
import { stubRoutes } from "../http/stub";

const StartBody = z.object({ text: z.string().min(1).max(4000), pageContext: z.string().max(400).nullable().optional(), threadId: z.string().nullable().optional() });
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

export function agentRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  const store = createRunStore(weft.db);
  const runtime = weft.agent as Partial<WeftAgentRuntime>;
  const getRun = async (id: string) => {
    const run = await store.getRun(id);
    if (!run) throw new NotFound(`No agent run ${id}`);
    return run;
  };

  r.post("/v1/agent/runs", async (c) => {
    const session = c.get("session");
    if (!session) throw new Unauthorized();
    const body = StartBody.parse(await c.req.json());
    const handle = await weft.executor.runs.openChatRun(session, { threadId: body.threadId ?? null, surface: "human_ui" });
    await weft.agent.startChat(handle, { text: body.text, recipe: "chat", pageContext: body.pageContext ?? null });
    return c.json({ runId: handle.runId }, 202);
  });

  r.get("/v1/agent/runs", async (c) => {
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 25) || 25));
    const session = c.get("session");
    const rows = await store.listRuns({ companyId: session?.companyId, limit: limit + 1 });
    return c.json({ hasMore: rows.length > limit, count: Math.min(rows.length, limit), data: rows.slice(0, limit) });
  });

  r.get("/v1/agent/runs/:id", async (c) => c.json(await getRun(c.req.param("id"))));

  r.get("/v1/agent/runs/:id/trace", async (c) => {
    const id = c.req.param("id");
    const run = await getRun(id);
    const steps = await store.steps(id);
    const props = (await weft.db.select().from(proposals).where(eq(proposals.proposerRunId, id)).orderBy(desc(proposals.createdAt))).map(toProposal);
    const actions = steps.flatMap((s) => {
      const o = (s.result as { outcome?: { ok: boolean; status?: string; actionSeq?: number | null; summary?: string } } | null)?.outcome;
      return s.kind === "tool_call" && o?.ok && o.status === "done" && typeof o.actionSeq === "number" ? [{ seq: o.actionSeq, command: s.toolName ?? "", summary: o.summary ?? "" }] : [];
    });
    return c.json({ run, steps, proposals: props, actions, children: [], summary: summarize(steps), queuePosition: runtime.queue?.position(id) ?? null });
  });

  r.get("/v1/agent/runs/:id/events", async (c) => {
    const id = c.req.param("id");
    await getRun(id);
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
        send("step", s);
        if (s.stage === "terminal") void store.getRun(id).then((row) => { if (row && TERMINAL.has(row.status)) finish(row.status); });
      };
      const stop = weft.agent.subscribe(id, forward);
      void (async () => {
        for (const s of await store.steps(id)) forward(s);
        const row = await store.getRun(id);
        if (row && TERMINAL.has(row.status) && (runtime.queue?.position(id) ?? null) === null) finish(row.status);
      })();
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

  return stubRoutes(r, "agent", [
    "POST /v1/agent/runs", "GET /v1/agent/runs", "GET /v1/agent/runs/:id", "GET /v1/agent/runs/:id/trace", "GET /v1/agent/runs/:id/events",
    "POST /v1/agent/runs/:id/cancel", "GET /v1/agent/costs",
  ]);
}
