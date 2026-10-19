// /v1 hand-offs to a person routes (wave 4, docs/wave4.md). Owner: w4-parity-compliance. Paths come from packages/contracts/src/api.ts.
// Every route answers 501 until the owner registers real handlers before stubRoutes and lists them in `except`.
// The Inbox reads the open cases here; resolving runs handoffs.resolve (human only) as the signed-in person.
// A case about a person (a worker or an offer) follows the person read scope: a manager reads the cases about her
// own record and her reports only (an outsider's case is a 404, never a "you may not"); company cases stay.
import { Hono } from "hono";
import { z } from "zod";
import { HandoffKind, HandoffStatus, NotFound, Unauthorized } from "@weft/contracts";
import { getHandoff, listHandoffs, scopeHandoffs, toHandoffDto } from "../../../../packages/core/src/compliance/handoffs";
import type { Weft, WeftEnv } from "../http/context";
import { viewerScope } from "../http/scope";
import { stubRoutes } from "../http/stub";
import { parsePage, toPage } from "../http/paging";

const Query = z.object({ kind: HandoffKind.optional(), status: HandoffStatus.optional() });
const ResolveBody = z.object({ note: z.string().max(400).optional(), status: z.enum(["acknowledged", "resolved", "cancelled"]).optional() });

export function handoffsRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/handoffs", async (c) => {
    const q = Query.parse({ kind: c.req.query("kind"), status: c.req.query("status") });
    const page = parsePage(c);
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    let rows = (await scopeHandoffs(weft.db, companyId, await viewerScope(weft, c), await listHandoffs(weft.db, companyId, q))).shown;
    if (page.afterId) rows = rows.filter((x) => x.id > page.afterId!);
    return c.json(toPage(rows.slice(0, page.limit + 1).map(toHandoffDto), page.limit));
  });
  r.get("/v1/handoffs/:id", async (c) => {
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    const h = await getHandoff(weft.db, companyId, c.req.param("id"));
    if (!h || !(await scopeHandoffs(weft.db, companyId, await viewerScope(weft, c), [h])).shown.length) throw new NotFound(`No hand-off ${c.req.param("id")}`);
    return c.json(toHandoffDto(h));
  });
  r.post("/v1/handoffs/:id/resolve", async (c) => {
    const s = c.var.session;
    if (!s) throw new Unauthorized();
    const body = ResolveBody.parse(await c.req.json().catch(() => ({})));
    const out = await weft.executor.human.exec(s, "handoffs.resolve", { handoff_id: c.req.param("id"), ...body });
    await weft.scheduler.kick();
    if (!out.ok) return c.json({ _tag: "Refused", message: out.refusal.message, code: out.refusal.code, hint: out.refusal.hint, example: out.refusal.example, tainted: out.tainted }, 422);
    return c.json(out);
  });
  return stubRoutes(r, "handoffs", ["GET /v1/handoffs", "GET /v1/handoffs/:id", "POST /v1/handoffs/:id/resolve"]);
}
