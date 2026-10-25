// /v1 payrolls routes. Owner: t1-payroll. Paths follow packages/contracts/src/api.ts.
// Reads come straight from the payroll read models; every mutation goes through the executor with the caller's
// HumanSession and then scheduler.kick() (SPEC 10). A refused ToolOutcome answers 422 Refused with its code.
import { Hono, type Context } from "hono";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import { idInMessage, NotFound, Unauthorized, type HumanSession, type ToolOutcome } from "@weft/contracts";
import { paychecks, payrollRuns, workers } from "@weft/db";
import { payroll } from "@weft/core";
import type { Weft, WeftEnv } from "../http/context";
import { parsePage, toPage } from "../http/paging";
import { needDomain, viewerScope } from "../http/scope";

function session(c: Context<WeftEnv>): HumanSession {
  const s = c.var.session;
  if (!s) throw new Unauthorized();
  return s;
}

async function outcome(c: Context<WeftEnv>, weft: Weft, command: string, args: unknown): Promise<Response> {
  const out: ToolOutcome = await weft.executor.human.exec(session(c), command, args);
  await weft.scheduler.kick();
  if (!out.ok) return c.json({ _tag: "Refused", message: out.refusal.message, code: out.refusal.code, hint: out.refusal.hint, example: out.refusal.example, tainted: out.tainted }, 422);
  return c.json(out);
}

const Group = z.enum(["needs_review", "ready"]).optional();
const SubmitBody = z.object({ excludeBlocked: z.boolean().default(false) });
const DraftBody = z.object({ payScheduleId: z.string().startsWith("ps_"), periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

export function payrollsRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  // Every payroll read needs payroll view, as payroll.list_runs and payroll.get_run do on the agent surfaces: a
  // manager (payroll: none) reads no run, total or paycheck here, her own included (the portal shows her own pay).
  const canRead = async (c: Context<WeftEnv>) => needDomain(await viewerScope(weft, c), "payroll", "pay runs and paychecks");

  r.get("/v1/payrolls", async (c) => {
    await canRead(c);
    const s = session(c);
    const page = parsePage(c);
    const { rows, counts } = await payroll.listRuns(weft.db, s.companyId, { limit: page.limit + 1, afterId: page.afterId });
    return c.json(toPage(rows.map((x) => payroll.runDto(x, counts.get(x.id) ?? 0)), page.limit));
  });

  r.post("/v1/payrolls/drafts", async (c) => {
    const body = DraftBody.parse(await c.req.json().catch(() => ({})));
    return outcome(c, weft, "payroll.create_draft", { pay_schedule_id: body.payScheduleId, period_end: body.periodEnd });
  });

  r.get("/v1/payrolls/:id", async (c) => {
    await canRead(c);
    const s = session(c);
    const run = (await weft.db.select().from(payrollRuns).where(and(eq(payrollRuns.id, c.req.param("id")), eq(payrollRuns.companyId, s.companyId))))[0];
    if (!run) throw new NotFound(`No payroll run ${idInMessage(c.req.param("id"))}`);
    const n = (await weft.db.select({ id: paychecks.id }).from(paychecks).where(eq(paychecks.payrollRunId, run.id))).length;
    return c.json(payroll.runDto(run, n));
  });

  r.get("/v1/payrolls/:id/paychecks", async (c) => {
    await canRead(c);
    const s = session(c);
    const runId = c.req.param("id");
    const run = (await weft.db.select().from(payrollRuns).where(and(eq(payrollRuns.id, runId), eq(payrollRuns.companyId, s.companyId))))[0];
    if (!run) throw new NotFound(`No payroll run ${runId}`);
    const page = parsePage(c);
    const group = Group.parse(c.req.query("group") || undefined);
    const workerId = c.req.query("workerId") || null;
    const state = c.req.query("state") || null;
    const conds = [eq(paychecks.payrollRunId, runId)];
    if (group) conds.push(eq(paychecks.reviewGroup, group));
    if (workerId) conds.push(eq(paychecks.workerId, workerId));
    if (page.afterId) conds.push(gt(paychecks.id, page.afterId));
    if (state) {
      const inState = (await weft.db.select({ id: workers.id }).from(workers).where(and(eq(workers.companyId, s.companyId), eq(workers.workState, state)))).map((w) => w.id);
      conds.push(inArray(paychecks.workerId, inState.length ? inState : ["__none__"]));
    }
    const rows = await weft.db.select().from(paychecks).where(and(...conds)).orderBy(asc(paychecks.id)).limit(page.limit + 1);
    const names = await payroll.workerNames(weft.db, rows.map((p) => p.workerId));
    return c.json(toPage(rows.map((p) => payroll.paycheckDto(p, names.get(p.workerId)?.name ?? p.workerId)), page.limit));
  });

  r.get("/v1/paychecks/:id", async (c) => {
    await canRead(c);
    const s = session(c);
    const p = (await weft.db.select().from(paychecks).where(eq(paychecks.id, c.req.param("id"))))[0];
    const run = p ? (await weft.db.select().from(payrollRuns).where(eq(payrollRuns.id, p.payrollRunId)))[0] : undefined;
    if (!p || !run || run.companyId !== s.companyId) throw new NotFound(`No paycheck ${c.req.param("id")}`);
    const names = await payroll.workerNames(weft.db, [p.workerId]);
    return c.json(payroll.paycheckDto(p, names.get(p.workerId)?.name ?? p.workerId, await payroll.paycheckTrace(weft.db, p)));
  });

  r.post("/v1/payrolls/:id/preview", async (c) => outcome(c, weft, "payroll.preview_run", { run_id: c.req.param("id") }));

  r.post("/v1/payrolls/:id/submit", async (c) => {
    const body = SubmitBody.parse(await c.req.json().catch(() => ({})));
    return outcome(c, weft, "payroll.submit_run", { run_id: c.req.param("id"), exclude_blocked: body.excludeBlocked });
  });

  return r;
}
