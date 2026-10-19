// /v1 benefits routes. Owner: t2-world (wave 2 reconciliation and open enrollment: w2-benefits-contractors).
// Reads come from the core read models; every mutation goes through the executor with the caller's HumanSession.
// Enrollments, reconciliation findings and open enrollment name each person's elections and premiums, so they need
// the benefits grant like the benefits.* read commands (a manager has benefits: none and gets 403 NOT_PERMITTED, as
// payroll and IT do). The plan list is the company's catalog and names no one.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { Unauthorized, ValidationError, type ToolOutcome } from "@weft/contracts";
import { listEnrollments, listFindings, listOpenEnrollment, listPlans, pageById, toEnrollmentDto, toFindingDto, toPlanDto } from "@weft/core";
import type { Weft, WeftEnv } from "../http/context";
import { needDomain, viewerScope } from "../http/scope";
import { stubRoutes } from "../http/stub";
import { parsePage, toPage } from "../http/paging";

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const RunBody = z.object({ month: Month });
const Status = z.enum(["open", "disputed", "resolved", "dismissed"]).optional();

async function outcome(c: Context<WeftEnv>, weft: Weft, command: string, args: unknown): Promise<Response> {
  const s = c.var.session;
  if (!s) throw new Unauthorized();
  const out: ToolOutcome = await weft.executor.human.exec(s, command, args);
  await weft.scheduler.kick();
  if (!out.ok) return c.json({ _tag: "Refused", message: out.refusal.message, code: out.refusal.code, hint: out.refusal.hint, example: out.refusal.example, tainted: out.tainted }, 422);
  return c.json(out);
}

export function benefitsRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/benefits/plans", async (c) => {
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    return c.json((await listPlans(weft.db, companyId)).map(toPlanDto));
  });
  r.get("/v1/benefits/enrollments", async (c) => {
    needDomain(await viewerScope(weft, c), "benefits", "benefits enrollments");
    const page = parsePage(c);
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    const rows = await listEnrollments(weft.db, companyId, c.req.query("workerId") || undefined);
    return c.json(toPage(pageById(rows, page).map(toEnrollmentDto), page.limit));
  });
  r.get("/v1/benefits/reconciliation", async (c) => {
    needDomain(await viewerScope(weft, c), "benefits", "benefits reconciliation");
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    const month = c.req.query("month") || undefined;
    if (month && !Month.safeParse(month).success) throw new ValidationError("month must be YYYY-MM", { issues: [{ path: "month", message: "YYYY-MM" }] });
    const status = Status.safeParse(c.req.query("status") || undefined);
    if (!status.success) throw new ValidationError("status must be open, disputed, resolved or dismissed", { issues: [{ path: "status", message: "enum" }] });
    return c.json((await listFindings(weft.db, companyId, { month, status: status.data })).map(toFindingDto));
  });
  r.post("/v1/benefits/reconciliation/run", async (c) => {
    const body = RunBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw new ValidationError("Body must be { month: YYYY-MM }", { issues: body.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    return outcome(c, weft, "benefits.reconcile", { month: body.data.month });
  });
  r.get("/v1/benefits/open-enrollment", async (c) => {
    needDomain(await viewerScope(weft, c), "benefits", "open enrollment");
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    return c.json(await listOpenEnrollment(weft.db, companyId, { status: c.req.query("status") || undefined }));
  });
  stubRoutes(r, "benefits", ["GET /v1/benefits/plans", "GET /v1/benefits/enrollments", "GET /v1/benefits/reconciliation", "POST /v1/benefits/reconciliation/run", "GET /v1/benefits/open-enrollment"]);
  return r;
}
