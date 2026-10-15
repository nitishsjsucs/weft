// Scenario s2 (SPEC 12, 13). Owner: t1-payroll. GP2 pre-payroll review and payroll run, plus the STALE_SUBJECT variant.
// Uses createTestWeft() from ./helpers; ends by verifying the action chain. Script: scripts/s2-pre-payroll.json.
// Needs the merged world (T2 seed and simulators, T3 executor, T4 routines and scripted provider): until those land
// each test skips itself, naming the missing parts. The payroll pieces are covered now by packages/core/test/payroll
// and apps/api/test/payrolls.test.ts on a local fixture world.
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PayrollRun } from "@weft/contracts";
import { actions, agentRuns, bankAccounts, events, paychecks, payrollRuns, proposals, routineRuns, ytdLedger } from "@weft/db";
import { createTestWeft, type TestWeft } from "./helpers";

const RUN = "pay_2026_10_30";
let weft: TestWeft;
let missing: string[] = [];

beforeAll(async () => {
  weft = await createTestWeft();
  missing = weft.stubs.filter((s) => ["sim", "executor", "agent", "routines"].includes(s) || s.startsWith("wiring"));
  const res = await weft.app.request(`/v1/payrolls/${RUN}`, { headers: weft.uiHeaders("usr_theo") });
  if (res.status !== 200) missing.push(`seeded ${RUN} (GET answered ${res.status})`);
});
afterAll(async () => { if (weft) await closeWorld(weft); });

const get = (path: string, who = "usr_theo") => weft.app.request(path, { headers: weft.uiHeaders(who) });
const post = (path: string, body: unknown, who = "usr_theo") => weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders(who), "content-type": "application/json" }, body: JSON.stringify(body) });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls real time (the agent runs in the background); no scheduler ticks while waiting, so nothing races the run. */
async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/**
 * Waits until no agent run is queued or running, then closes the world. close() closes the database before it removes
 * the temp dir; a late background file write can make that removal fail with ENOTEMPTY, so only the removal is retried.
 */
async function closeWorld(w: TestWeft): Promise<void> {
  await waitFor("agent runs to go idle", async () => (await w.db.select().from(agentRuns)).every((r) => !["queued", "running"].includes(r.status)), 10_000).catch(() => undefined);
  try { await w.close(); } catch (e) {
    if ((e as { code?: string }).code !== "ENOTEMPTY") throw e;
    await sleep(200);
    rmSync(w.dataDir, { recursive: true, force: true });
  }
}

const SETTLED = new Set(["waiting_approval", "done", "completed", "failed", "skipped", "escalated", "cancelled", "left_for_human"]);
const routineRun = async (id: string) => (await weft.db.select().from(routineRuns).where(eq(routineRuns.id, id)))[0];
const agentRunStatus = async (id: string | null) => (id ? (await weft.db.select().from(agentRuns).where(eq(agentRuns.id, id)))[0]?.status ?? null : null);

/** "Run review now" (attended). Uses the route; while T4's routines routes are still 501 stubs, the engine directly. */
async function triggerReview(): Promise<string> {
  const trig = await post("/v1/routines/rt_pre_payroll/trigger", {}, "usr_dana");
  if (trig.status === 501) return (await weft.routines.trigger("rt_pre_payroll", { attended: true, requestedBy: "usr_dana" })).routineRunId;
  expect(trig.status).toBe(200);
  return ((await trig.json()) as { routineRunId: string }).routineRunId;
}

/** Triggers the review, waits until its agent run stops, and returns the pending payroll.submit_run proposal it made. */
async function reviewAndPropose(): Promise<{ proposalId: string; routineRunId: string }> {
  const routineRunId = await triggerReview();
  const rr = await waitFor(`routine run ${routineRunId} to settle`, async () => {
    const r = await routineRun(routineRunId);
    return r && SETTLED.has(r.status) ? r : null;
  });
  const p = (await weft.db.select().from(proposals).where(eq(proposals.command, "payroll.submit_run")))
    .find((x) => x.status === "pending" && x.subjectRef === RUN && x.proposerRunId === rr.agentRunId);
  if (!p) throw new Error(`routine run ${routineRunId} ended ${rr.status} without a pending payroll.submit_run proposal`);
  return { proposalId: p.id, routineRunId };
}

/** After a decision the engine wakes the proposing agent run; wait until it stops again before moving the clock. */
async function waitForWake(routineRunId: string): Promise<void> {
  const rr = await routineRun(routineRunId);
  await waitFor(`agent run ${rr?.agentRunId} to stop after the decision`, async () => {
    const st = await agentRunStatus(rr?.agentRunId ?? null);
    return st !== null && !["queued", "running"].includes(st);
  });
}

describe("GP2 pre-payroll review and payroll run, plus the STALE_SUBJECT variant", () => {
  it("the seeded draft has 48 paychecks, 4 Needs Review and 44 Ready", async (ctx) => {
    if (missing.some((m) => m.startsWith("seeded"))) return ctx.skip(`waiting for: ${missing.join(", ")}`);
    const run = PayrollRun.parse(await (await get(`/v1/payrolls/${RUN}`)).json());
    expect(run).toMatchObject({ status: "draft", paycheckCount: 48, anomalySummary: { needsReview: 4, ready: 44 } });
  });

  it("STALE_SUBJECT: a direct-deposit change between proposal and approval refuses the approval", async (ctx) => {
    if (missing.length) return ctx.skip(`waiting for: ${missing.join(", ")}`);
    const { proposalId, routineRunId } = await reviewAndPropose();
    const rows = await weft.db.select().from(paychecks).where(eq(paychecks.payrollRunId, RUN));
    const ready = rows.find((p) => p.reviewGroup === "ready")!;
    const acct = (await weft.db.select().from(bankAccounts).where(eq(bankAccounts.workerId, ready.workerId)))[0]!;
    await weft.db.update(bankAccounts).set({ accountLast4: "0000" }).where(eq(bankAccounts.id, acct.id));
    const res = await post(`/v1/proposals/${proposalId}/approve`, { reasonCode: null, note: null });
    const body = (await res.json()) as { ok?: boolean; code?: string };
    expect(res.status).toBe(422);
    expect(body.code ?? JSON.stringify(body)).toContain("STALE_SUBJECT");
    await weft.db.update(bankAccounts).set({ accountLast4: acct.accountLast4 }).where(eq(bankAccounts.id, acct.id));
    expect((await weft.db.select().from(proposals).where(eq(proposals.id, proposalId)))[0]!.status).not.toBe("pending");
    expect(PayrollRun.parse(await (await get(`/v1/payrolls/${RUN}`)).json()).status).toBe("draft");   // nothing moved
    await waitForWake(routineRunId);
  });

  it("runs end to end with the scripted provider: explained, proposed, approved, processing, processed", async (ctx) => {
    if (missing.length) return ctx.skip(`waiting for: ${missing.join(", ")}`);
    const { proposalId, routineRunId } = await reviewAndPropose();
    const flagged = (await weft.db.select().from(paychecks).where(eq(paychecks.payrollRunId, RUN))).filter((p) => p.reviewGroup === "needs_review");
    expect(flagged).toHaveLength(4);
    for (const p of flagged) expect(p.explanation, p.workerId).not.toBeNull();
    const approved = await post(`/v1/proposals/${proposalId}/approve`, { reasonCode: null, note: null });
    expect(approved.status).toBe(200);
    const decided = (await approved.json()) as { ok: boolean; outcome?: { ok: boolean; status?: string } };
    expect(decided.outcome, JSON.stringify(decided).slice(0, 600)).toMatchObject({ ok: true, status: "done" });
    await waitForWake(routineRunId);
    let run = PayrollRun.parse(await (await get(`/v1/payrolls/${RUN}`)).json());
    expect(run.status).toBe("processing");
    expect(run.excludedWorkerIds).toHaveLength(1);
    // submitted_action_seq points at the payroll.submit_run action row the executor appended in the same transaction.
    const stored = (await weft.db.select().from(payrollRuns).where(eq(payrollRuns.id, RUN)))[0]!;
    const submitAction = (await weft.db.select().from(actions).where(eq(actions.command, "payroll.submit_run")))[0];
    expect(submitAction, "payroll.submit_run action row").toBeDefined();
    expect(stored.submittedActionSeq).toBe(submitAction!.seq);
    expect(submitAction!.proposalId).toBe(proposalId);
    const approvedTotal = run.totals!.totalCost.amount;
    await weft.clock.advance("2026-10-30T13:00:00.000Z");   // Fri Oct 30 06:00 PT
    await weft.scheduler.tick();
    run = PayrollRun.parse(await (await get(`/v1/payrolls/${RUN}`)).json());
    expect(run.status).toBe("processed");
    expect(run.totals!.totalCost.amount).toBe(approvedTotal);
    expect((await weft.db.select().from(ytdLedger).where(eq(ytdLedger.source, `payroll:${RUN}`))).length).toBeGreaterThan(0);
    expect((await weft.db.select().from(events).where(eq(events.type, "payroll.processed"))).map((e) => e.subjectRef)).toContain(RUN);
  });

  it("verifies the action chain", async (ctx) => {
    if (missing.length) return ctx.skip(`waiting for: ${missing.join(", ")}`);
    const chain = await weft.executor.verifyChain();
    expect(chain.ok).toBe(true);
  });
});

describe("S2 fault variant: the bank returns the batch", () => {
  beforeAll(async () => {
    if (missing.length) return;
    await closeWorld(weft);
    weft = await createTestWeft();
  });

  it("arms bank.submitBatch return; after payday 06:00 PT the run is failed, nothing is paid and no YTD is written", async (ctx) => {
    if (missing.length) return ctx.skip(`waiting for: ${missing.join(", ")}`);
    const armed = await post("/v1/sim/faults", { target: "bank.submitBatch", kind: "return", mode: "once" });
    expect(armed.status).toBe(200);
    const { proposalId, routineRunId } = await reviewAndPropose();
    const approved = await post(`/v1/proposals/${proposalId}/approve`, { reasonCode: null, note: null });
    expect(((await approved.json()) as { outcome?: unknown }).outcome).toMatchObject({ ok: true, status: "done" });
    await waitForWake(routineRunId);
    expect(PayrollRun.parse(await (await get(`/v1/payrolls/${RUN}`)).json()).status).toBe("processing");
    await weft.clock.advance("2026-10-30T13:00:00.000Z");   // Fri Oct 30 06:00 PT
    await weft.scheduler.tick();
    const run = PayrollRun.parse(await (await get(`/v1/payrolls/${RUN}`)).json());
    expect(run.status).toBe("failed");
    const rows = await weft.db.select().from(paychecks).where(eq(paychecks.payrollRunId, RUN));
    expect(rows.filter((p) => p.status === "failed")).toHaveLength(47);
    expect(await weft.db.select().from(ytdLedger).where(eq(ytdLedger.source, `payroll:${RUN}`))).toEqual([]);
    expect((await weft.db.select().from(events).where(eq(events.type, "payroll.processed"))).map((e) => e.subjectRef)).not.toContain(RUN);
    expect((await weft.executor.verifyChain()).ok).toBe(true);
  });
});
