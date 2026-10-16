// Scenario GP18, dispute half (docs/wave3.md 5). Owner: w3-integrations-screening-esign. Scripted provider.
// A California hire's consider result goes to pre-adverse; the candidate disputes (the simulator's dispute fault), which
// pauses the waiting period; when the dispute finishes the final step stays refused until the 7 day waiting period plus
// 5 business days (California's extension, applied everywhere) has passed. Every step here is a person's.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { handlers } from "@weft/core";
import { createScheduler } from "@weft/api";
import type { RoutinesEngine } from "@weft/contracts";
import { addBusinessDaysPt, disputesSince, finalNotAllowedBefore } from "../../packages/core/src/screening/orders";
import { createTestWeft, type TestWeft } from "./helpers";

const CANDIDATE = { candidateFirst: "Sage", candidateLast: "Morrow", candidateEmail: "sage.morrow@candidate.example", title: "Firmware Test Engineer", departmentId: "dpt_hardware", workState: "CA", baseCents: 13_200_000, payKind: "salary", startDate: "2026-11-30" };
const DANA = { principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui" as const, keyScope: null };

describe("business days and the waiting period", () => {
  it("adds business days by the PT calendar and extends the waiting period per dispute", () => {
    expect(addBusinessDaysPt("2026-10-30T16:00:00.000Z", 1)).toBe("2026-11-02T16:00:00.000Z");   // Fri to Mon
    expect(addBusinessDaysPt("2026-10-28T15:30:00.000Z", 5)).toBe("2026-11-04T15:30:00.000Z");   // Wed to Wed
    expect(finalNotAllowedBefore("2026-10-28T15:30:00.000Z")).toBe("2026-11-04T15:30:00.000Z");
    expect(finalNotAllowedBefore("2026-10-28T15:30:00.000Z", 1)).toBe("2026-11-11T15:30:00.000Z");
    expect(finalNotAllowedBefore("2026-10-28T15:30:00.000Z", 2)).toBe("2026-11-18T15:30:00.000Z");
  });
});

describe("GP18 dispute extends the waiting period", () => {
  let weft: TestWeft;
  beforeAll(async () => {
    weft = await createTestWeft();
    // This scenario is about the waiting period only: no routine runs in the background while the sim clock jumps.
    await (weft.routines as unknown as { ensurePrebuilt(): Promise<void> }).ensurePrebuilt();
    await weft.db.run(sql`UPDATE routines SET enabled = 0`);
  });
  afterAll(async () => { await settle(); await weft.close(); });
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const noRoutines = { tick: async () => undefined, trigger: async () => ({ routineRunId: "rtr_none" }), onProposalDecided: async () => undefined } as RoutinesEngine;
  /** Lets the routine and agent runs the app started in the background finish, so they never hold the database during a tick. */
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      const runs = await weft.db.all<{ id: string }>(sql`SELECT id FROM agent_runs WHERE status IN ('queued', 'running')`);
      const open = await weft.db.all<{ id: string }>(sql`SELECT id FROM routine_runs WHERE status IN ('queued', 'running')`);
      if (!runs.length && !open.length) return;
      for (const r of runs) await (weft.agent as unknown as { settled(id: string): Promise<unknown> }).settled(r.id);
      for (const r of open) await (weft.routines as unknown as { settled(id: string): Promise<unknown> }).settled(r.id);
    }
  };
  const tickAt = async (iso: string) => {
    await weft.clock.advance(iso);
    await settle();
    const s = createScheduler({ db: weft.db, clock: weft.clock, sims: weft.sims, executor: weft.executor, handlers, routines: noRoutines, log: (l: string) => { throw new Error(l); } });   // a failed step fails the test
    // Run on the test app's tick chain so a tick the app kicked meanwhile never overlaps this one.
    await (weft.scheduler as unknown as { exclusive<T>(fn: () => Promise<T>): Promise<T> }).exclusive(() => s.tick());
    await s.stop();
  };

  it("a dispute pauses the final step, then holds it 5 business days past the waiting period", async () => {
    await weft.db.run(sql`INSERT INTO sim_faults (target, kind, mode, armed, fired_count) VALUES ('checkr.consider', 'error', 'once', 1, 0) ON CONFLICT(target) DO UPDATE SET armed = 1`);
    const offerId = (await call("usr_dana", "POST", "/v1/offers", CANDIDATE)).json.data.offer_id as string;
    const persona = (await call("usr_dana", "POST", `/v1/offers/${offerId}/send`)).json.data.persona_principal_id as string;
    const letter = (await call(persona, "GET", "/v1/portal/me")).json.documents.find((d: { kind: string }) => d.kind === "offer_letter");
    expect((await call(persona, "POST", `/v1/portal/documents/${letter.id}/sign`, { typedName: "Sage Morrow", documentSha256: letter.sha256 })).json.data.offer_status).toBe("accepted");
    const placed = await weft.executor.human.exec(DANA, "screening.order", { offer_id: offerId });
    expect(placed).toMatchObject({ ok: true, status: "done" });
    const id = (placed as { data: { order_id: string } }).data.order_id;
    await call(persona, "POST", "/v1/portal/screening/consent", { orderId: id, typedName: "Sage Morrow" });
    await tickAt("2026-10-27T15:30:00.000Z");
    const view = (await call("usr_dana", "GET", `/v1/screening/orders/${id}`)).json;
    expect(view).toMatchObject({ status: "complete_review", result: "consider" });

    // The candidate disputes once the pre-adverse notice arrives (the simulator's dispute fault on the report).
    const rid = (await weft.db.all<{ vendor_report_id: string }>(sql`SELECT vendor_report_id FROM screening_orders WHERE id = ${id}`))[0]!.vendor_report_id;
    const [rec] = await weft.db.all<{ body_json: string }>(sql`SELECT body_json FROM sim_vendor_records WHERE ext_id = ${rid}`);
    const body = JSON.parse(rec!.body_json); body._sim.fault = "dispute";
    await weft.db.run(sql`UPDATE sim_vendor_records SET body_json = ${JSON.stringify(body)} WHERE ext_id = ${rid}`);
    await tickAt("2026-10-28T15:30:00.000Z");
    const pre = await call("usr_dana", "POST", `/v1/screening/orders/${id}/adjudicate`, { step: "pre_adverse" });
    expect(pre.json, JSON.stringify(pre.json)).toMatchObject({ ok: true, data: { adjudication: "pre_adverse", final_not_before: "2026-11-04T15:30:00.000Z" } });
    expect((await call("usr_dana", "GET", `/v1/screening/orders/${id}`)).json).toMatchObject({ status: "disputed" });
    const paused = await call("usr_dana", "POST", `/v1/screening/orders/${id}/adjudicate`, { step: "final_adverse" });
    expect([paused.status, paused.json.code]).toEqual([422, "DOMAIN_SCREENING_TIMER_PAUSED"]);

    // Five business days later the dispute completes; the 7 day period alone would end now, but the extension holds.
    await tickAt("2026-11-04T17:00:00.000Z");
    expect((await call("usr_dana", "GET", `/v1/screening/orders/${id}`)).json).toMatchObject({ status: "complete_review", adjudication: "pre_adverse" });
    expect(await disputesSince(weft.db as never, id, "2026-10-28T15:30:00.000Z")).toBe(1);
    const held = await call("usr_dana", "POST", `/v1/screening/orders/${id}/adjudicate`, { step: "final_adverse" });
    expect([held.status, held.json.code]).toEqual([422, "DOMAIN_SCREENING_WAITING_PERIOD"]);
    expect(held.json.message ?? JSON.stringify(held.json)).toContain("2026-11-11T15:30:00.000Z");

    await tickAt("2026-11-11T16:00:00.000Z");
    const final = await call("usr_dana", "POST", `/v1/screening/orders/${id}/adjudicate`, { step: "final_adverse" });
    expect(final.json, JSON.stringify(final.json)).toMatchObject({ ok: true, data: { adjudication: "post_adverse" } });
    expect((await call("usr_dana", "GET", `/v1/offers/${offerId}`)).json.status).toBe("accepted");   // never ended automatically
  });
});
