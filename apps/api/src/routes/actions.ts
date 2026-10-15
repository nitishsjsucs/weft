// /v1 actions routes (SPEC 10). Owner: t3-governance. The audit log, chain verification and rollback (UI session only).
import { Hono } from "hono";
import { and, asc, desc, eq, gt, isNotNull, lt, type SQL } from "drizzle-orm";
import { z } from "zod";
import { NotFound, Unauthorized, ValidationError, type Action } from "@weft/contracts";
import { actions } from "@weft/db";
import type { Weft, WeftEnv } from "../http/context";
import { parsePage, toPage } from "../http/paging";
import { kick, redactJson } from "./proposals";

type ActionRow = typeof actions.$inferSelect;

function notReversibleReason(command: string): string {
  if (command.startsWith("payroll.submit")) return "A funded payroll cannot be undone; run an off-cycle correction instead.";
  if (command.startsWith("notices.send") || command.startsWith("tax.register")) return "Agency filings cannot be withdrawn once sent.";
  if (command.startsWith("comms.")) return "A sent message cannot be unsent.";
  return `${command} is not reversible.`;
}

export function toAction(r: ActionRow, reversedBySeq: number | null): Action {
  return {
    seq: r.seq, actionId: r.actionId, ts: r.ts, actorKind: r.actorKind as Action["actorKind"], actorId: r.actorId, onBehalfOf: r.onBehalfOf,
    agentRunId: r.agentRunId, routineRunId: r.routineRunId, proposalId: r.proposalId, command: r.command, resultId: r.resultId, summary: r.summary,
    reversible: r.reversible as Action["reversible"], reversesSeq: r.reversesSeq, reversedBySeq,
    notReversibleReason: r.reversible === "yes" ? null : notReversibleReason(r.command), prevHash: r.prevHash, hash: r.hash,
  };
}

const seqParam = (s: string) => {
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1) throw new ValidationError("seq must be a positive integer");
  return n;
};

export function actionsRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();

  async function reversals(): Promise<Map<number, number>> {
    const rows = await weft.db.select({ seq: actions.seq, rev: actions.reversesSeq }).from(actions).where(isNotNull(actions.reversesSeq));
    return new Map(rows.map((x) => [x.rev!, x.seq]));
  }

  r.get("/v1/actions", async (c) => {
    if (!c.var.session) throw new Unauthorized();
    const page = parsePage(c);
    const conds: SQL[] = [];
    const runId = c.req.query("runId");
    if (runId) conds.push(eq(actions.agentRunId, runId));
    if (page.beforeId) conds.push(lt(actions.seq, seqParam(page.beforeId)));
    if (page.afterId) conds.push(gt(actions.seq, seqParam(page.afterId)));
    const order = page.afterId ? asc(actions.seq) : desc(actions.seq);
    const rows = await weft.db.select().from(actions).where(conds.length ? and(...conds) : undefined).orderBy(order).limit(page.limit + 1);
    const rev = await reversals();
    return c.json(redactJson(weft, toPage(rows.map((x) => toAction(x, rev.get(x.seq) ?? null)), page.limit)));
  });

  r.get("/v1/actions/verify", async (c) => {
    if (!c.var.session) throw new Unauthorized();
    return c.json(await weft.executor.verifyChain());
  });

  r.get("/v1/actions/:seq", async (c) => {
    if (!c.var.session) throw new Unauthorized();
    const seq = seqParam(c.req.param("seq"));
    const [row] = await weft.db.select().from(actions).where(eq(actions.seq, seq)).limit(1);
    if (!row) throw new NotFound(`No action #${seq}`);
    const rev = await reversals();
    return c.json(redactJson(weft, toAction(row, rev.get(seq) ?? null)));
  });

  r.post("/v1/actions/:seq/rollback", async (c) => {
    const s = c.var.session;
    if (!s) throw new Unauthorized();
    const seq = seqParam(c.req.param("seq"));
    const body = z.object({ reason: z.string().min(1).max(500) }).parse(await c.req.json().catch(() => ({})));
    const outcome = await weft.executor.human.rollback(s, { seq, reason: body.reason });
    await kick(weft);
    if (!outcome.ok) return c.json({ ...outcome, _tag: "Refused", code: outcome.refusal.code, message: outcome.refusal.message }, 422);
    return c.json(redactJson(weft, outcome));
  });
  return r;
}
