// Scenario (wave 4, w4-parity-people): life-event elections reach the carrier simulator as a proposal and come back
// with a receipt. Scripted provider (scenarios/rt_life_event_window.json). The employee elects in the window, the
// routine proposes benefits.submit_elections (R3, never executed by the agent), Vic approves, the scheduler hands
// the filing to the simulated carrier and records the receipt with carrier.submission_confirmed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { AgentRunRow, RoutineRun } from "@weft/contracts";
import { carrierSubmissions, principals, workers } from "@weft/db";
import { fileElections } from "../../packages/sim/src/carriers/index";
import { PREBUILT } from "../../packages/routines/src/prebuilt";
import { createTestWeft, type TestWeft } from "./helpers";

let weft: TestWeft;
const HIRE = "usr_t_filer";
beforeAll(async () => {
  weft = await createTestWeft();
  // A portal sign-in with the persona's grants (people and benefits view) for one active employee.
  const [w] = await weft.db.select().from(workers).where(and(eq(workers.type, "employee"), eq(workers.status, "active"))).limit(1);
  await weft.db.insert(principals).values({ id: HIRE, companyId: "cmp_larkspur", kind: "human", workerId: w!.id, display: "Test filer", email: null, role: "employee",
    grantsJson: JSON.stringify({ people: "view", payroll: "none", tax: "none", benefits: "view", it: "none", comms: "none", company: "none" }) });
});
afterAll(async () => {
  for (let i = 0; i < 10; i++) {
    const open = await weft.db.all<{ id: string }>(sql`SELECT id FROM routine_runs WHERE status IN ('queued', 'running')`);
    if (!open.length) break;
    for (const r of open) await (weft.routines as unknown as { settled(id: string): Promise<unknown> }).settled(r.id);
  }
  await weft?.close();
});

const call = async (method: string, path: string, body?: unknown, who = "usr_dana") => {
  const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};
const trigger = async (routineId: string): Promise<RoutineRun> => {
  const { json } = await call("POST", `/v1/routines/${routineId}/trigger`, {});
  const engine = weft.routines as unknown as { settled(id: string): Promise<RoutineRun> };
  const run = await engine.settled(json.routineRunId);
  if (run.agentRunId) await (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(run.agentRunId);
  await (weft.routines as unknown as { drain(ms?: number): Promise<boolean> }).drain(5_000);
  return (await (weft.routines as unknown as { getRun(id: string): Promise<RoutineRun> }).getRun(run.id));
};

describe("life-event elections filed with the carrier and the 401(k) provider", () => {
  let windowId = "";
  let filings: { id: string; carrier: string; status: string }[] = [];

  it("ships disabled, on the window close event, with the filing command only as a proposal", () => {
    const r = PREBUILT.find((x) => x.id === "rt_life_event_window");
    expect(r).toMatchObject({ enabled: false, trigger: { type: "event", event: "enrollment_window.closed" } });
    expect(r!.tools.length).toBeLessThanOrEqual(8);
    expect(r!.tools).not.toContain("benefits.record_carrier_receipt");
  });

  it("the employee's elections queue one filing per carrier", async () => {
    const rep = await call("POST", "/v1/portal/life-events", { kind: "adoption", eventDate: "2026-10-23" }, HIRE);
    expect(rep.status, JSON.stringify(rep.json)).toBe(200);
    windowId = rep.json.data.window_id;
    const mine = (await call("GET", "/v1/portal/life-events", undefined, HIRE)).json as { plans: { id: string; type: string }[] };
    const medical = mine.plans.find((p) => p.type === "medical")!;
    const k401 = mine.plans.find((p) => p.type === "401k")!;
    const el = await call("POST", `/v1/portal/enrollment-windows/${windowId}/elections`, { elections: [{ planId: medical.id, tier: "family" }, { planId: k401.id, deferralBps: 600 }] }, HIRE);
    expect(el.status, JSON.stringify(el.json)).toBe(200);
    filings = (await call("GET", `/v1/carrier-submissions?windowId=${windowId}`)).json;
    expect(filings.map((f) => [f.carrier, f.status])).toEqual([["Juniper Mutual", "queued"], ["Tidewater Retirement", "queued"]]);
  });

  it("the routine proposes the filing; nothing is sent until a person approves", async () => {
    const run = await trigger("rt_life_event_window");
    expect(["done", "waiting_approval"]).toContain(run.status);
    const props = (await call("GET", "/v1/proposals?status=pending")).json.data as { id: string; command: string; headline: string }[];
    const p = props.find((x) => x.command === "benefits.submit_elections");
    expect(p, JSON.stringify(props.map((x) => x.command))).toBeDefined();
    expect(p!.headline).toBe("File 2 benefit election filings with Juniper Mutual and Tidewater Retirement");
    expect(((await call("GET", `/v1/carrier-submissions?windowId=${windowId}`)).json as { status: string }[]).every((f) => f.status === "queued")).toBe(true);

    expect((await call("POST", `/v1/proposals/${p!.id}/approve`, { reasonCode: "looks_right", note: "" })).status).toBe(200);
    const sent = (await call("GET", `/v1/carrier-submissions?windowId=${windowId}`)).json as { status: string; proposal_id: string | null }[];
    expect(sent.every((f) => f.status === "sent" || f.status === "confirmed")).toBe(true);   // the approval kicks a tick
    expect(sent.every((f) => f.proposal_id === p!.id)).toBe(true);
  });

  it("the next tick records each carrier's receipt and emits carrier.submission_confirmed once", async () => {
    await weft.scheduler.tick();
    const done = (await call("GET", `/v1/carrier-submissions?windowId=${windowId}`)).json as { id: string; status: string; receipt_ref: string; confirmed_at: string }[];
    expect(done.map((f) => f.status)).toEqual(["confirmed", "confirmed"]);
    expect(done[0]!.receipt_ref).toMatch(/^JM-[0-9A-F]{10}$/);
    expect(done[1]!.receipt_ref).toMatch(/^TW-[0-9A-F]{10}$/);
    const [row] = await weft.db.select().from(carrierSubmissions).where(eq(carrierSubmissions.id, done[0]!.id));
    const e = JSON.parse(row!.electionsJson) as { effective_on: string; lines: { plan_id: string; type: string; tier: string | null; deferral_bps: number | null }[] };
    expect(fileElections({ submissionId: row!.id, carrier: row!.carrier, workerId: row!.workerId, effectiveOn: e.effective_on, lines: e.lines.map((l) => ({ plan_id: l.plan_id, type: l.type, tier: l.tier, deferral_bps: l.deferral_bps })) }).receiptRef).toBe(done[0]!.receipt_ref);
    await weft.scheduler.tick();
    const n = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM events WHERE type = 'carrier.submission_confirmed'`);
    expect(n[0]!.n).toBe(2);
  });

  it("the carrier simulator rejects a line it does not take", () => {
    expect(fileElections({ submissionId: "csb_x", carrier: "Tidewater Retirement", workerId: "wrk_x", effectiveOn: "2026-10-23", lines: [{ plan_id: "bpl_x", type: "medical", tier: "ee", deferral_bps: null }] }))
      .toEqual({ status: "rejected", receiptRef: null, reason: "Tidewater Retirement does not take medical elections" });
  });
});
