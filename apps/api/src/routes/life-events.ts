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
import { CheckinAnswers, Forbidden, LifeEventReport, TimeOffSubmission, Unauthorized, ValidationError, type ExecutorBundle, type HumanSession, type ToolOutcome } from "@weft/contracts";
import { lifeEvents as le, pageById, ptDateOf } from "@weft/core";
import { benefitPlans, carrierSubmissions, type Db } from "@weft/db";
import { fileElections, type CarrierFiling } from "@weft/sim";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";
import { parsePage, toPage } from "../http/paging";
import { outcomeJson } from "./offers";

const IMPLEMENTED = [
  "GET /v1/life-events", "GET /v1/enrollment-windows", "GET /v1/carrier-submissions", "POST /v1/portal/life-events", "GET /v1/portal/checkins", "POST /v1/portal/checkins/:id/submit", "GET /v1/checkins",
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

  r.get("/v1/carrier-submissions", async (c) => {
    const res = await read(c, "benefits.list_carrier_submissions", { worker_id: q(c, "workerId"), status: q(c, "status"), window_id: q(c, "windowId") });
    return res instanceof Response ? res : c.json(res.data.submissions);
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

  // The portal Request time off form (wave 3 left it open): the caller's own balances and requests, and a request for
  // the caller's own worker through time_off.submit (human only; mayActFor refuses anyone else). Not yet table rows.
  r.get("/v1/portal/time-off", async (c) => {
    uiOnly(c);
    const w = await ownWorker(c);
    if (!w) return c.json({ workerId: null, balances: [], requests: [] });
    const bal = await read(c, "time_off.get_balance", { worker_id: w });
    if (bal instanceof Response) return bal;
    const reqs = await read(c, "time_off.list_requests", { worker_id: w });
    if (reqs instanceof Response) return reqs;
    const balances = (bal.data.balances as { policyId: string; policyName: string; typeName: string; availableMinutes: number; available_display: string }[])
      .map((b) => ({ policyId: b.policyId, policyName: b.policyName, typeName: b.typeName, availableMinutes: b.availableMinutes, available: b.available_display }));
    const requests = (reqs.data.requests as { id: string; policyName: string; status: string; startDate?: string; endDate?: string; startAt?: string; endAt?: string; requestedMinutes: number }[])
      .map((x) => ({ id: x.id, policyName: x.policyName, status: x.status, startDate: (x.startDate ?? x.startAt ?? "").slice(0, 10), endDate: (x.endDate ?? x.endAt ?? "").slice(0, 10), requestedMinutes: x.requestedMinutes }));
    return c.json({ workerId: w, balances, requests });
  });
  r.post("/v1/portal/time-off/requests", async (c) => {
    uiOnly(c);
    const body = TimeOffSubmission.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw new ValidationError("Body must be a TimeOffSubmission { policyId, startDate, endDate, partialDayMinutes, reason }", issues(body.error));
    const w = await ownWorker(c);
    if (!w) throw new Forbidden("NO_WORKER", { code: "NO_WORKER" });
    return write(c, "time_off.submit", { worker_id: w, policy_id: body.data.policyId, start_date: body.data.startDate, end_date: body.data.endDate,
      ...(body.data.partialDayMinutes !== null ? { partial_day_minutes: body.data.partialDayMinutes } : {}), ...(body.data.reason ? { reason: body.data.reason } : {}) });
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
 * The scheduler's benefits sweep (wave 4), run by svc_scheduler only when something is due: windows due to open or
 * close go to benefits.close_windows (R1, system only); filings the people team sent go to the simulated carrier or
 * 401(k) provider, and its receipts are recorded with benefits.record_carrier_receipt (R1, system only).
 */
export async function sweepEnrollmentWindows(o: { db: Db; executor: ExecutorBundle; now: string }): Promise<void> {
  const day = ptDateOf(o.now);
  const src = { eventId: null, attended: false, requestedBy: null };
  const due = await o.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM enrollment_windows WHERE (status = 'open' AND closes_on < ${day}) OR (status = 'scheduled' AND opens_on <= ${day})`);
  if (due[0]?.n) await o.executor.system.exec("svc_scheduler", "benefits.close_windows", { as_of: day }, src);
  const sent = await o.db.select().from(carrierSubmissions).where(eq(carrierSubmissions.status, "sent"));
  if (sent.length === 0) return;
  const receipts = sent.slice(0, 50).map((r) => {
    const e = JSON.parse(r.electionsJson) as { effective_on: string; lines: CarrierFiling["lines"] };
    const a = fileElections({ submissionId: r.id, carrier: r.carrier, workerId: r.workerId, effectiveOn: e.effective_on, lines: e.lines.map((l) => ({ plan_id: l.plan_id, type: l.type, tier: l.tier, deferral_bps: l.deferral_bps })) });
    return a.status === "confirmed" ? { submission_id: r.id, status: "confirmed" as const, receipt_ref: a.receiptRef } : { submission_id: r.id, status: "rejected" as const, reason: a.reason };
  });
  await o.executor.system.exec("svc_scheduler", "benefits.record_carrier_receipt", { receipts }, src);
}
