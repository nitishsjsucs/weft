// /v1 proposals routes (SPEC 10). Owner: t3-governance. Decisions accept only the UI session (the auth middleware
// refuses API keys on ui_only routes; decide() refuses them again with UI_SESSION_REQUIRED).
import { Hono } from "hono";
import { and, asc, eq, gt, type SQL } from "drizzle-orm";
import { z } from "zod";
import { NotFound, Unauthorized, type DecisionInput } from "@weft/contracts";
import { proposals } from "@weft/db";
import { toProposal } from "@weft/executor";
import type { Weft, WeftEnv } from "../http/context";
import { parsePage, toPage } from "../http/paging";

const DecisionBody = z.object({ reasonCode: z.string().max(64).nullable().optional(), note: z.string().max(2000).nullable().optional() }).default({});

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
      const input: DecisionInput = { proposalId: c.req.param("id"), decision, reasonCode: body.reasonCode ?? null, note: body.note ?? null, session: s };
      const result = await weft.executor.human.decide(input);
      await kick(weft);
      if (!result.ok) return c.json({ ...result, _tag: "Refused" }, 422);
      return c.json(redactJson(weft, result));
    });
  }
  return r;
}
