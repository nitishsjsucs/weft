// Scenario GP18 (docs/wave3.md 5). Owner: w3-integrations-screening-esign. Scripted provider, createTestWeft().
// After acceptance the agent proposes screening.order (R4, priced from the package row); Vic approves; the candidate
// consents on the simulated apply page; the report completes clear on the sim clock through a signed webhook that goes
// through verification and dedupe, and the background_check task completes. A consider result opens a human-only review
// with no record text on any agent read; adverse steps are human only and the final step waits out the notice period.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { commands, handlers } from "@weft/core";
import { createScheduler } from "@weft/api";
import type { RoutinesEngine } from "@weft/contracts";
import { ingestVendorDelivery } from "../../apps/api/src/integrations/poll-screening";
import { SIM_RECORD_MARKER } from "../../packages/sim/src/vendors/checkr";
import { createTestWeft, type TestWeft } from "./helpers";

const CANDIDATE = { candidateFirst: "Rowan", candidateLast: "Ellery", candidateEmail: "rowan.ellery@candidate.example", title: "Firmware Test Engineer", departmentId: "dpt_hardware", workState: "CO", baseCents: 13_200_000, payKind: "salary", startDate: "2026-11-02" };
const DANA = { principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui" as const, keyScope: null };

describe("GP18 background check after acceptance", () => {
  let weft: TestWeft;
  beforeAll(async () => { weft = await createTestWeft(); });
  afterAll(async () => { await weft.close(); });
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const noRoutines = { tick: async () => undefined, trigger: async () => ({ routineRunId: "rtr_none" }), onProposalDecided: async () => undefined } as RoutinesEngine;
  const tickAt = async (iso: string) => {
    await weft.clock.advance(iso);
    const s = createScheduler({ db: weft.db, clock: weft.clock, sims: weft.sims, executor: weft.executor, handlers, routines: noRoutines, log: () => undefined });
    await s.tick();
    await s.stop();
  };
  /** An offer through the GP6 path to accepted; returns ids. */
  const hire = async (first: string, email: string, extra: Record<string, unknown> = {}) => {
    const offerId = (await call("usr_dana", "POST", "/v1/offers", { ...CANDIDATE, candidateFirst: first, candidateEmail: email, ...extra })).json.data.offer_id as string;
    const sent = (await call("usr_dana", "POST", `/v1/offers/${offerId}/send`)).json.data;
    const persona = sent.persona_principal_id as string;
    await call(persona, "POST", "/v1/portal/offer/view");
    const letter = (await call(persona, "GET", "/v1/portal/me")).json.documents.find((d: { kind: string }) => d.kind === "offer_letter");
    const before = await call("usr_dana", "POST", `/v1/offers/${offerId}/screening`, {});
    const signed = await call(persona, "POST", `/v1/portal/documents/${letter.id}/sign`, { typedName: `${first} Ellery`, documentSha256: letter.sha256 });
    expect(signed.json.data.offer_status).toBe("accepted");
    return { offerId, persona, workerId: sent.reserved_worker_id as string, before };
  };
  const agentRun = async (n: number) => {
    await weft.db.run(sql`INSERT INTO routines (id, company_id, name, description, owner_principal_id, enabled, trigger_json, instructions, tools_json, budget_json, surface_json, source, tainted_by, created_at)
      VALUES (${`rt_gp18_${n}`}, 'cmp_larkspur', 'Screening follow-up', 'test', 'usr_dana', 0, '{"type":"event","event":"offer.accepted"}', '', '["screening.order","screening.get_status","onboarding.get_checklist"]', '{}', '{}', 'custom', NULL, '2026-10-26T15:30:00.000Z') ON CONFLICT DO NOTHING`);
    return weft.executor.runs.openRoutineRun({ routineId: `rt_gp18_${n}`, routineRunId: `rtr_gp18_${n}`, triggerRef: `event:offer.accepted:${n}`, attended: false });
  };

  let clear: Awaited<ReturnType<typeof hire>>;
  let orderId = "";
  it("refuses screening before acceptance, then the agent's order is an R4 proposal priced from the package row", async () => {
    clear = await hire("Rowan", "rowan.ellery@candidate.example");
    expect([clear.before.status, clear.before.json.code]).toEqual([422, "DOMAIN_SCREENING_BEFORE_OFFER"]);
    // The price comes from screening_packages, not from the model or the vendor at call time.
    await weft.db.run(sql`UPDATE screening_packages SET price_cents = 4200 WHERE vendor = 'checkr' AND slug = 'weft_standard_sim'`);
    const run = await agentRun(1);
    const out = await weft.executor.agent.exec(run, { callId: "1", command: "screening__order", args: { offer_id: clear.offerId, package_slug: null }, batch: 1 } as never);
    expect(out).toMatchObject({ ok: true, status: "pending_approval" });
    const proposalId = (out as { proposalId: string }).proposalId;
    const [p] = await weft.db.all<{ money_cents: number; risk: string }>(sql`SELECT * FROM proposals WHERE id = ${proposalId}`);
    expect(p).toMatchObject({ risk: "R4" });
    expect(JSON.stringify(p)).toContain("4200");
    expect((await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM screening_orders`))[0]!.n).toBe(0);
    const d = await weft.executor.human.decide({ proposalId, decision: "approve", reasonCode: null, note: null, session: DANA });
    expect(d.ok, JSON.stringify(d)).toBe(true);
    const [o] = await weft.db.all<{ id: string; status: string; price_cents: number; mode: string; vendor: string; phase: string }>(sql`SELECT * FROM screening_orders`);
    expect(o).toMatchObject({ status: "invited", price_cents: 4200, mode: "simulated", vendor: "checkr", phase: "full" });
    orderId = o!.id;
    const again = await weft.executor.agent.exec(run, { callId: "2", command: "screening__order", args: { offer_id: clear.offerId, package_slug: null }, batch: 2 } as never);
    expect(again).toMatchObject({ ok: false, refusal: { code: "DOMAIN_SCREENING_EXISTS" } });
    const task = await weft.db.all<{ status: string; owner: string }>(sql`SELECT status, owner FROM onboarding_tasks WHERE worker_id = ${clear.workerId} AND kind = 'background_check'`);
    expect(task).toEqual([{ status: "pending", owner: "agent" }]);
    const byHand = await weft.executor.human.exec(DANA, "onboarding.complete_task", { worker_id: clear.workerId, kind: "background_check" });
    expect(byHand).toMatchObject({ ok: false, refusal: { code: "DOMAIN_SYSTEM_TASK" } });
  });

  it("the candidate consents on the simulated apply page; a signed webhook completes the check clear and the task", async () => {
    const mine = (await call(clear.persona, "GET", "/v1/portal/screening")).json;
    expect(mine).toEqual([expect.objectContaining({ orderId, status: "invited", consentNeeded: true, mode: "simulated", vendorLabel: "Checkr" })]);
    expect((await call(clear.persona, "POST", "/v1/portal/screening/consent", { orderId, typedName: "Rowan Ellery" })).json).toEqual({ ok: true, orderId });
    await tickAt("2026-10-26T16:00:00.000Z");
    expect((await call("usr_dana", "GET", `/v1/screening/orders/${orderId}`)).json).toMatchObject({ status: "in_progress", etaOn: "2026-10-27" });
    await tickAt("2026-10-27T15:30:00.000Z");   // one business day of turnaround on the sim clock
    expect((await call("usr_dana", "GET", `/v1/screening/orders/${orderId}`)).json).toMatchObject({ status: "complete_clear", result: "clear", reviewRequired: false });
    const task = await weft.db.all<{ status: string }>(sql`SELECT status FROM onboarding_tasks WHERE worker_id = ${clear.workerId} AND kind = 'background_check'`);
    expect(task).toEqual([{ status: "done" }]);
    const dl = await weft.db.all<{ vendor: string; action: string; verified: number; applied_at: string | null; error: string | null }>(sql`SELECT vendor, action, verified, applied_at, error FROM integration_deliveries ORDER BY id`);
    expect(dl.map((x) => x.action)).toEqual(["invitation.created", "invitation.completed", "report.created", "report.completed"]);
    expect(dl.every((x) => x.vendor === "checkr" && x.verified === 1 && x.applied_at && !x.error)).toBe(true);
    // The completion came from the webhook path: the apply action ran as svc_events on the report.completed delivery.
    const acts = await weft.db.all<{ actor_id: string; args_json: string }>(sql`SELECT actor_id, args_json FROM actions WHERE command = 'screening.apply_vendor_event' ORDER BY seq`);
    expect(acts.some((a) => a.actor_id === "svc_events" && JSON.parse(a.args_json).kind === "report.completed")).toBe(true);
    // Redelivery is a no-op, and a body that is re-serialized fails verification.
    const [row] = await weft.db.all<{ body_json: string; signature: string }>(sql`SELECT body_json, signature FROM sim_webhook_outbox WHERE vendor = 'checkr' ORDER BY id DESC LIMIT 1`);
    const conn = weft.sims.vendors.checkr;
    const d = { db: weft.db, executor: weft.executor, now: weft.clock.now() };
    expect((await ingestVendorDelivery(d, "checkr", conn, new TextEncoder().encode(row!.body_json), { "X-Checkr-Signature": row!.signature })).status).toBe("duplicate");
    expect((await ingestVendorDelivery(d, "checkr", conn, new TextEncoder().encode(JSON.stringify(JSON.parse(row!.body_json), null, 2)), { "X-Checkr-Signature": row!.signature })).status).toBe("rejected");
    const evts = await weft.db.all<{ payload_json: string }>(sql`SELECT payload_json FROM events WHERE type = 'screening.status_changed' ORDER BY rowid`);
    expect(evts.map((e) => JSON.parse(e.payload_json).status)).toEqual(["invited", "in_progress", "complete_clear"]);   // Checkr creates the report with the consent
  });

  it("a consider result opens a human-only review; agent reads never carry record text; adverse steps are human only and wait out the notice", async () => {
    await weft.db.run(sql`INSERT INTO sim_faults (target, kind, mode, armed, fired_count) VALUES ('checkr.consider', 'error', 'once', 1, 0) ON CONFLICT(target) DO UPDATE SET armed = 1`);
    const h = await hire("Juno", "juno.ellery@candidate.example");
    const placed = await weft.executor.human.exec(DANA, "screening.order", { offer_id: h.offerId });
    expect(placed).toMatchObject({ ok: true, status: "done" });
    const id = (placed as { data: { order_id: string } }).data.order_id;
    await call(h.persona, "POST", "/v1/portal/screening/consent", { orderId: id, typedName: "Juno Ellery" });
    await tickAt("2026-10-28T15:30:00.000Z");
    const view = (await call("usr_dana", "GET", `/v1/screening/orders/${id}`)).json;
    expect(view).toMatchObject({ status: "complete_review", result: "consider", reviewRequired: true, nextSteps: ["engage", "pre_adverse"] });
    const task = await weft.db.all<{ status: string; blocked_reason: string }>(sql`SELECT status, blocked_reason FROM onboarding_tasks WHERE worker_id = ${h.workerId} AND kind = 'background_check'`);
    expect(task).toEqual([{ status: "blocked", blocked_reason: "Waiting on a person: review required" }]);

    const run = await agentRun(2);
    const read = await weft.executor.agent.exec(run, { callId: "1", command: "screening__get_status", args: { offer_id: h.offerId, worker_id: null, order_id: null }, batch: 1 } as never);
    expect(read).toMatchObject({ ok: true, status: "done", tainted: false });
    expect(JSON.stringify(read)).not.toContain(SIM_RECORD_MARKER);
    expect(JSON.stringify(read)).toContain("complete_review");
    for (const name of ["screening.review", "screening.engage", "screening.start_pre_adverse", "screening.send_final_adverse", "screening.cancel_adverse", "screening.proceed_to_criminal"]) {
      const out = await weft.executor.agent.exec(run, { callId: name, command: name.replace(".", "__"), args: { order_id: id }, batch: 2 } as never);
      expect(out.ok, name).toBe(false);
      expect(JSON.stringify(out)).not.toContain(SIM_RECORD_MARKER);
      expect(() => weft.executor.registry.toolSpecs({ agentKind: "main", allowlist: [name] }), name).toThrow();
    }
    expect((await weft.executor.agent.runState(run)).tainted).toBe(false);
    // Everything the executor handed the agent in this run (exec_calls) and every run step stays free of record text.
    const calls = await weft.db.all<{ outcome_json: string }>(sql`SELECT outcome_json FROM exec_calls WHERE run_id = ${run.runId}`);
    expect(calls.length).toBeGreaterThanOrEqual(7);
    for (const c of calls) expect(c.outcome_json).not.toContain(SIM_RECORD_MARKER);
    const steps = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM run_steps WHERE result_json LIKE ${`%${SIM_RECORD_MARKER}%`} OR tool_args_json LIKE ${`%${SIM_RECORD_MARKER}%`}`);
    expect(steps[0]!.n).toBe(0);

    // The person opens the report (audited) and starts pre-adverse; the final step waits out 7 days.
    const detail = (await call("usr_dana", "GET", `/v1/screening/orders/${id}?detail=items`)).json;
    expect(detail.items[0].text).toContain(SIM_RECORD_MARKER);
    expect((await call("usr_dana", "POST", `/v1/screening/orders/${id}/adjudicate`, { step: "pre_adverse" })).json).toMatchObject({ ok: true, data: { adjudication: "pre_adverse" } });
    const early = await call("usr_dana", "POST", `/v1/screening/orders/${id}/adjudicate`, { step: "final_adverse" });
    expect([early.status, early.json.code]).toEqual([422, "DOMAIN_SCREENING_WAITING_PERIOD"]);
    await tickAt("2026-11-04T15:30:00.000Z");
    const final = await call("usr_dana", "POST", `/v1/screening/orders/${id}/adjudicate`, { step: "final_adverse" });
    expect(final.json, JSON.stringify(final.json)).toMatchObject({ ok: true, data: { adjudication: "post_adverse" } });
    expect((await call("usr_dana", "GET", `/v1/offers/${h.offerId}`)).json.status).toBe("accepted");   // never ended automatically
    const actors = await weft.db.all<{ command: string; actor_id: string }>(sql`SELECT command, actor_id FROM actions WHERE command IN ('screening.review', 'screening.start_pre_adverse', 'screening.send_final_adverse') ORDER BY seq`);
    expect(actors).toEqual([{ command: "screening.review", actor_id: "usr_dana" }, { command: "screening.start_pre_adverse", actor_id: "usr_dana" }, { command: "screening.send_final_adverse", actor_id: "usr_dana" }]);
  });

  it("registry: no screening command named adverse, engage, review or proceed is on any model surface", () => {
    const named = commands.filter((c) => c.name.startsWith("screening.") && /adverse|engage|review|proceed/.test(c.name));
    expect(named.map((c) => c.name).sort()).toEqual(["screening.cancel_adverse", "screening.engage", "screening.proceed_to_criminal", "screening.review", "screening.send_final_adverse", "screening.start_pre_adverse"]);
    for (const c of named) expect([c.access, c.tiers.main, c.tiers.task, c.mcp, c.sandbox], c.name).toEqual(["human_only", "unavailable", "unavailable", "hidden", "hidden"]);
    const order = commands.find((c) => c.name === "screening.order")!;
    expect([order.risk({} as never), order.approval, order.autoAllow, order.ceilingKey]).toEqual(["R4", "always", "never", "agent.screening_cents"]);
    expect(commands.find((c) => c.name === "screening.apply_vendor_event")!.access).toBe("system_only");
  });
});
