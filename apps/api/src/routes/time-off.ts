// /v1 time-off routes (wave 3, docs/wave3.md). Owner: w3-timeoff. Paths come from packages/contracts/src/api.ts.
// Every route goes through the executor as the session's person: reads run the R0 time_off.* commands, writes run
// time_off.submit, time_off.decide and time_off.cancel (a person's own decision runs; managers decide only for
// direct reports, checked inside the command).
import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { TimeOffDecideBody, TimeOffSubmission, Unauthorized, ValidationError, type HumanSession, type ToolOutcome } from "@weft/contracts";
import { pageById } from "@weft/core";
import { principals } from "@weft/db";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";
import { parsePage, toPage } from "../http/paging";
import { outcomeJson } from "./offers";

const IMPLEMENTED = [
  "GET /v1/time-off/policies", "GET /v1/time-off/balances", "GET /v1/time-off/ledger", "GET /v1/time-off/requests", "GET /v1/time-off/requests/:id",
  "POST /v1/time-off/requests", "POST /v1/time-off/requests/:id/decide", "POST /v1/time-off/requests/:id/cancel", "GET /v1/time-off/calendar", "GET /v1/time-off/holidays",
] as const;

const need = (s: HumanSession | null): HumanSession => { if (!s) throw new Unauthorized(); return s; };
const q = (c: Context<WeftEnv>, k: string) => c.req.query(k) || undefined;
const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }) => ({ issues: e.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) });

export function timeOffRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  /** Runs a read command as the session and returns its data, or the refusal as 422. */
  const read = async (c: Context<WeftEnv>, command: string, args: Record<string, unknown>): Promise<{ data: Record<string, unknown> } | Response> => {
    const out: ToolOutcome = await weft.executor.human.exec(need(c.var.session), command, Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)));
    if (!out.ok || out.status !== "done") return outcomeJson(c, out);
    return { data: out.data as Record<string, unknown> };
  };
  const write = async (c: Context<WeftEnv>, command: string, args: Record<string, unknown>) => {
    const out = await weft.executor.human.exec(need(c.var.session), command, args);
    await weft.scheduler.kick();
    return outcomeJson(c, out);
  };

  r.get("/v1/time-off/policies", async (c) => {
    const res = await read(c, "time_off.list_policies", {});
    return res instanceof Response ? res : c.json(res.data.policies);
  });
  r.get("/v1/time-off/holidays", async (c) => {
    const res = await read(c, "time_off.list_policies", {});
    if (res instanceof Response) return res;
    const year = q(c, "year");
    return c.json((res.data.holidays as { date: string; name: string }[]).filter((h) => !year || h.date.startsWith(`${year}-`)));
  });
  r.get("/v1/time-off/balances", async (c) => {
    const res = await read(c, "time_off.get_balance", { worker_id: q(c, "workerId"), as_of: q(c, "asOf") });
    if (res instanceof Response) return res;
    return c.json(q(c, "workerId") ? res.data.balances : (res.data.workers as { balances: unknown[] }[]).flatMap((w) => w.balances));
  });
  r.get("/v1/time-off/ledger", async (c) => {
    const workerId = q(c, "workerId");
    if (!workerId) throw new ValidationError("workerId is required", { issues: [{ path: "workerId", message: "required" }] });
    const res = await read(c, "time_off.get_balance", { worker_id: workerId, policy_id: q(c, "policyId"), include_ledger: true });
    if (res instanceof Response) return res;
    return c.json((res.data.balances as { policyId: string; ledger: Record<string, unknown>[] }[]).flatMap((b) => b.ledger.map((l) => ({ ...l, policy_id: b.policyId }))));
  });
  r.get("/v1/time-off/requests", async (c) => {
    const page = parsePage(c);
    const res = await read(c, "time_off.list_requests", { status: q(c, "status"), worker_id: q(c, "workerId"), department_id: q(c, "departmentId"), from: q(c, "from"), to: q(c, "to"), approver: q(c, "approver") });
    if (res instanceof Response) return res;
    return c.json(toPage(pageById(res.data.requests as { id: string }[], page), page.limit));
  });
  r.get("/v1/time-off/requests/:id", async (c) => {
    const res = await read(c, "time_off.list_requests", { request_id: c.req.param("id") });
    if (res instanceof Response) return res;
    const one = (res.data.requests as unknown[])[0];
    if (!one) return c.json({ _tag: "NotFound", message: `No time-off request ${c.req.param("id")}` }, 404);
    return c.json(one);
  });
  r.post("/v1/time-off/requests", async (c) => {
    const s = need(c.var.session);
    const body = TimeOffSubmission.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw new ValidationError("Body must be a TimeOffSubmission { policyId, startDate, endDate, partialDayMinutes, reason }", issues(body.error));
    // The person's own worker, unless an admin names one with ?workerId=.
    const [me] = await weft.db.select({ workerId: principals.workerId }).from(principals).where(and(eq(principals.id, s.principalId), eq(principals.companyId, s.companyId))).limit(1);
    const workerId = q(c, "workerId") ?? me?.workerId ?? null;
    if (!workerId) throw new ValidationError("workerId is required for a person without a worker record", { issues: [{ path: "workerId", message: "required" }] });
    const b = body.data;
    return write(c, "time_off.submit", { worker_id: workerId, policy_id: b.policyId, start_date: b.startDate, end_date: b.endDate, ...(b.partialDayMinutes !== null ? { partial_day_minutes: b.partialDayMinutes } : {}), reason: b.reason });
  });
  r.post("/v1/time-off/requests/:id/decide", async (c) => {
    const body = TimeOffDecideBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw new ValidationError("Body must be { decision: approve | deny, note }", issues(body.error));
    return write(c, "time_off.decide", { request_id: c.req.param("id"), decision: body.data.decision, note: body.data.note });
  });
  r.post("/v1/time-off/requests/:id/cancel", async (c) => write(c, "time_off.cancel", { request_id: c.req.param("id") }));
  r.get("/v1/time-off/calendar", async (c) => {
    const departmentId = q(c, "departmentId"), from = q(c, "from"), to = q(c, "to");
    if (!departmentId || !from || !to) throw new ValidationError("departmentId, from and to are required", { issues: [{ path: "departmentId", message: "required" }] });
    const res = await read(c, "time_off.team_calendar", { department_id: departmentId, from, to });
    return res instanceof Response ? res : c.json(res.data);
  });
  return stubRoutes(r, "time-off", IMPLEMENTED);
}
