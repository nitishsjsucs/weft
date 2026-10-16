// /v1 proposals routes (SPEC 10). Owner: t3-governance. Decisions accept only the UI session (the auth middleware
// refuses API keys on ui_only routes; decide() refuses them again with UI_SESSION_REQUIRED).
import { Hono } from "hono";
import { and, asc, eq, gt, type SQL } from "drizzle-orm";
import { z } from "zod";
import { CHAT_TOOLS, NotFound, Unauthorized, ValidationError, type DecisionInput } from "@weft/contracts";
import { proposals } from "@weft/db";
import { executorInternals, toProposal } from "@weft/executor";
import type { Weft, WeftEnv } from "../http/context";
import { parsePage, toPage } from "../http/paging";

// `value` answers a secret_request card on approve: the approver types the simulator credential, decide() runs the
// usual checks, and only then the value goes into the vault (it joins the redactor before anything else sees it).
const DecisionBody = z.object({
  reasonCode: z.string().max(64).nullable().optional(), note: z.string().max(2000).nullable().optional(), value: z.string().min(1).max(4096).optional(),
}).default({});

export function redactJson<T>(weft: Weft, v: T): T {
  return JSON.parse(weft.executor.redact(JSON.stringify(v))) as T;
}
export async function kick(weft: Weft): Promise<void> {
  try { await weft.scheduler.kick(); } catch { /* a stubbed part must not fail the human's request */ }
}

export function proposalsRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();

  r.get("/v1/proposals", async (c) => {
    const s = c.var.session;
    if (!s) throw new Unauthorized();
    const page = parsePage(c);
    const conds: SQL[] = [eq(proposals.companyId, s.companyId)];
    const status = c.req.query("status"), kind = c.req.query("kind");
    if (status) conds.push(eq(proposals.status, status));
    if (kind) conds.push(eq(proposals.kind, kind));
    if (page.afterId) conds.push(gt(proposals.id, page.afterId));
    const rows = await weft.db.select().from(proposals).where(and(...conds)).orderBy(asc(proposals.id)).limit(page.limit + 1);
    return c.json(redactJson(weft, toPage(rows.map(toProposal), page.limit)));
  });

  r.get("/v1/proposals/:id", async (c) => {
    const s = c.var.session;
    if (!s) throw new Unauthorized();
    const [row] = await weft.db.select().from(proposals).where(and(eq(proposals.id, c.req.param("id")), eq(proposals.companyId, s.companyId))).limit(1);
    if (!row) throw new NotFound(`No proposal ${c.req.param("id")}`);
    return c.json(redactJson(weft, toProposal(row)));
  });

  for (const decision of ["approve", "deny", "dismiss", "start"] as const) {
    r.post(`/v1/proposals/:id/${decision}`, async (c) => {
      const s = c.var.session;
      if (!s) throw new Unauthorized();
      const raw = await c.req.json().catch(() => ({}));
      const body = DecisionBody.parse(raw ?? {});
      if (body.value !== undefined) executorInternals(weft.executor)?.addSecret(body.value);
      const [target] = await weft.db.select({ kind: proposals.kind, status: proposals.status, args: proposals.argsJson, note: proposals.agentNote }).from(proposals)
        .where(and(eq(proposals.id, c.req.param("id")), eq(proposals.companyId, s.companyId))).limit(1);
      const secretCard = target?.kind === "secret_request" && target.status === "pending" && decision === "approve";
      if (secretCard && body.value === undefined) throw new ValidationError("Approving a secret request needs the credential value", { issues: [{ path: "value", message: "required" }] });
      if (!secretCard && body.value !== undefined) throw new ValidationError("Only approving a pending secret request takes a value", { issues: [{ path: "value", message: "not allowed here" }] });
      const input: DecisionInput = { proposalId: c.req.param("id"), decision, reasonCode: body.reasonCode ?? null, note: body.note ?? null, session: s };
      const result = await weft.executor.human.decide(input);
      if (result.ok && secretCard && result.proposal.status === "approved") {
        const req = JSON.parse(target.args ?? "{}") as { name: string; kind: string };
        await weft.executor.vault.put({ name: req.name, kind: req.kind, value: body.value!, description: target.note ?? "Requested by the Weft agent", by: s.principalId });
      }
      await kick(weft);
      if (!result.ok) return c.json(redactJson(weft, { ...result, _tag: "Refused" }), 422);
      if (decision === "start" && result.proposal.kind === "suggestion") {
        // A started suggestion opens a chat run carrying the suggestion's provenance (best-effort until T4 lands).
        try {
          const run = await weft.executor.runs.openChatRun(s, { threadId: null, surface: "human_ui", allowlist: CHAT_TOOLS });
          if (result.proposal.taintedBy) await executorInternals(weft.executor)?.taintRun(run.runId, `suggestion:${result.proposal.id}`);
          await weft.agent.startChat(run, { text: result.proposal.headline, recipe: "chat", pageContext: `proposal:${result.proposal.id}` });
          return c.json(redactJson(weft, { ...result, runId: run.runId }));
        } catch { /* agent runtime not available */ }
      }
      return c.json(redactJson(weft, result));
    });
  }
  return r;
}
