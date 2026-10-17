// /v1 life events, enrollment windows, carrier submissions and check-ins routes (wave 4, docs/wave4.md). Owner: w4-parity-people. Paths come from packages/contracts/src/api.ts.
// Every route answers 501 until the owner registers real handlers before stubRoutes and lists them in `except`.
//
// Reads for HR run the R0 benefits.* commands as the session's person. The portal routes act on the caller's own
// worker only (the new hire persona reaches only /v1/portal/*): reporting a life event runs benefits.report_life_event
// and answering a check-in runs onboarding.submit_checkin_form, both human only. GET /v1/checkins is the manager's
// view: the check-ins of the caller's direct reports, never anyone else's.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { CheckinAnswers, Forbidden, LifeEventReport, Unauthorized, ValidationError, type ExecutorBundle, type HumanSession, type ToolOutcome } from "@weft/contracts";
import { lifeEvents as le, pageById, ptDateOf } from "@weft/core";
import { benefitPlans, type Db } from "@weft/db";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";
import { parsePage, toPage } from "../http/paging";
import { outcomeJson } from "./offers";

const IMPLEMENTED = [
  "GET /v1/life-events", "GET /v1/enrollment-windows", "POST /v1/portal/life-events", "GET /v1/portal/checkins", "POST /v1/portal/checkins/:id/submit", "GET /v1/checkins",
] as const;

/** The portal election body (extension; see docs/tracks/w4-parity-people.md). */
const PortalElections = z.object({
  elections: z.array(z.object({ planId: z.string().startsWith("bpl_"), tier: z.enum(["ee", "ee_spouse", "ee_children", "family"]).nullable().optional(), deferralBps: z.number().int().min(0).max(10_000).nullable().optional() }).strict()).max(6).default([]),
  noChange: z.boolean().default(false),
}).strict();

const need = (s: HumanSession | null): HumanSession => { if (!s) throw new Unauthorized(); return s; };
const q = (c: Context<WeftEnv>, k: string) => c.req.query(k) || undefined;
const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }) => ({ issues: e.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) });

export function lifeEventsRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
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
  const ownWorker = async (c: Context<WeftEnv>) => { const s = need(c.var.session); return le.workerOfPrincipal(weft.db, s.companyId, s.principalId); };

  r.get("/v1/life-events", async (c) => {
    const page = parsePage(c);
    const res = await read(c, "benefits.list_life_events", { worker_id: q(c, "workerId"), status: q(c, "status") });
    if (res instanceof Response) return res;
    return c.json(toPage(pageById(res.data.life_events as { id: string }[], page), page.limit));
  });
  r.get("/v1/enrollment-windows", async (c) => {
    const res = await read(c, "benefits.list_windows", { worker_id: q(c, "workerId"), kind: q(c, "kind"), status: q(c, "status") });
    return res instanceof Response ? res : c.json(res.data.windows);
  });

  r.post("/v1/portal/life-events", async (c) => {
    const body = LifeEventReport.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw new ValidationError("Body must be a LifeEventReport { kind, eventDate, note }", issues(body.error));
    return write(c, "benefits.report_life_event", { kind: body.data.kind, event_date: body.data.eventDate, ...(body.data.note ? { note: body.data.note } : {}) });
  });

  // Not yet rows in the frozen route table (contract request w4-parity-people 1): the portal's own life events and
  // windows, and the employee's elections in an open window. UI sessions only, like every /v1/portal route.
  const uiOnly = (c: Context<WeftEnv>) => { if (need(c.var.session).via !== "ui") throw new Forbidden("UI_SESSION_REQUIRED", { code: "UI_SESSION_REQUIRED" }); };
  r.get("/v1/portal/life-events", async (c) => {
    uiOnly(c);
    const s = need(c.var.session);
    const w = await ownWorker(c);
    if (!w) return c.json({ workerId: null, lifeEvents: [], windows: [], plans: [] });
    const plans = await weft.db.select({ id: benefitPlans.id, name: benefitPlans.name, type: benefitPlans.type, carrier: benefitPlans.carrier }).from(benefitPlans).where(eq(benefitPlans.companyId, s.companyId));
    return c.json({ workerId: w, lifeEvents: await le.listLifeEvents(weft.db, s.companyId, { workerId: w }), windows: await le.listWindows(weft.db, s.companyId, { workerId: w }), plans: plans.filter((p) => p.type !== "hsa") });
  });
  r.post("/v1/portal/enrollment-windows/:id/elections", async (c) => {
    uiOnly(c);
    const body = PortalElections.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw new ValidationError("Body must be { elections: [{ planId, tier, deferralBps }], noChange }", issues(body.error));
    const elections = body.data.elections.map((e) => ({ plan_id: e.planId, ...(e.tier ? { tier: e.tier } : {}), ...(e.deferralBps !== null && e.deferralBps !== undefined ? { deferral_bps: e.deferralBps } : {}) }));
    return write(c, "benefits.elect_in_window", { window_id: c.req.param("id"), elections, ...(body.data.noChange ? { no_change: true } : {}) });
  });

  r.get("/v1/portal/checkins", async (c) => {
    const w = await ownWorker(c);
    return c.json(w ? await le.checkinsFor(weft.db, [w]) : []);
  });
  r.post("/v1/portal/checkins/:id/submit", async (c) => {
    const body = CheckinAnswers.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw new ValidationError("Body must be CheckinAnswers { settled 1 to 5, tools, clarity, blocker, manager_note }", issues(body.error));
    return write(c, "onboarding.submit_checkin_form", { checkin_id: c.req.param("id"), answers: body.data });
  });
  r.get("/v1/checkins", async (c) => {
    const s = need(c.var.session);
    const w = await ownWorker(c);
    const reports = w ? await le.directReports(weft.db, s.companyId, w) : [];
    return c.json(await le.checkinsFor(weft.db, reports, q(c, "status")));
  });

  return stubRoutes(r, "life-events", IMPLEMENTED);
}

/**
 * The scheduler's window date sweep (wave 4): when a window is due to open or close, svc_scheduler runs
 * benefits.close_windows (R1, system only). A cheap count first, so an idle tick writes nothing.
 */
export async function sweepEnrollmentWindows(o: { db: Db; executor: ExecutorBundle; now: string }): Promise<void> {
  const day = ptDateOf(o.now);
  const due = await o.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM enrollment_windows WHERE (status = 'open' AND closes_on < ${day}) OR (status = 'scheduled' AND opens_on <= ${day})`);
  if (!due[0]?.n) return;
  await o.executor.system.exec("svc_scheduler", "benefits.close_windows", { as_of: day }, { eventId: null, attended: false, requestedBy: null });
}
