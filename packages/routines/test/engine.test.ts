import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRuntime, PrecheckResult, ReadOnlyExecutor, RoutineDef, RoutineRun, RunStepRow, SimClock, ToolOutcome } from "@weft/contracts";
import { closeDb, migrate, openDb, type Db } from "@weft/db";
import { createRoutines, PREBUILT, ptDate, runKey } from "../src/index";

let dataDir: string;
let db: Db;
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "weft-rt-"));
  db = openDb({ dataDir });
  await migrate(db);
});
afterEach(async () => {
  await closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

function mutableClock(at: string): SimClock & { at: string } {
  const c = { at, now: () => c.at, rate: () => 0, advance: async (to: string) => { c.at = to; }, set: async (to: string) => { c.at = to; } };
  return c;
}

const done = (data: unknown): ToolOutcome => ({ ok: true, status: "done", resultId: "res_0001", data, summary: "ok", actionSeq: null, artifactRef: null, tainted: false, label: "synthetic" });

function fakeRead(): ReadOnlyExecutor & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    async exec(_c, command) {
      log.push(command);
      if (command === "payroll.list_runs") return done({ runs: [{ run_id: "pay_2026_10_30", status: "draft", approval_deadline: "2026-10-29T00:00:00.000Z" }] });
      if (command === "payroll.get_run") return done({ flagged: [{ paycheck_id: "pyc_0001", worker: "Rowan Achebe (wrk_0014)", flags: [{ rule: "GROSS_CHANGE", severity: "review", evidence: { result_id: "res_0041" } }] }] });
      if (command === "people.search") return done({ total: 48 });
      return done({});
    },
  };
}

function fakeAgent(): AgentRuntime & { started: { routine: RoutineDef; routineRun: RoutineRun; precheck: PrecheckResult }[] } {
  const started: { routine: RoutineDef; routineRun: RoutineRun; precheck: PrecheckResult }[] = [];
  const subs = new Map<string, (s: RunStepRow) => void>();
  return {
    started,
    async boot() {},
    async startChat() {},
    async startRoutineRun(_h, input) { started.push(input); },
    async requeue() {},
    async cancel() {},
    subscribe(runId, cb) { subs.set(runId, cb); return () => subs.delete(runId); },
    async trace() { throw new Error("n/a"); },
  };
}

let runN = 0;
const runs = { openRoutineRun: async () => ({ runId: `run_${String(++runN).padStart(4, "0")}`, token: "t" }) };

describe("routines engine", () => {
  it("lists the prebuilt routines (waves 1 to 4) and reads one", async () => {
    const eng = createRoutines({ db, clock: mutableClock("2026-10-26T15:30:00.000Z"), agent: fakeAgent(), runs, readOnly: fakeRead() });
    const all = await eng.list();
    expect(all.map((r) => r.id)).toEqual(["rt_agency_notice", "rt_ats_hire", "rt_benefits_window_reminders", "rt_compliance_notices", "rt_compliance_reminders", "rt_compliance_training", "rt_compliance_uploads", "rt_contractor_forms", "rt_exec_briefing", "rt_expense_review", "rt_first_day_message", "rt_laptop_hand_delivery", "rt_life_event_window", "rt_memory_digest", "rt_milestones", "rt_monthly_exec_report", "rt_new_hire", "rt_new_hire_ready", "rt_onboarding_nudge", "rt_open_enrollment", "rt_people_digest", "rt_pre_payroll", "rt_screening_follow_up", "rt_thirty_day_checkin", "rt_time_off_requests", "rt_weekly_cost_by_state"]);
    for (const r of PREBUILT) expect(r.tools.length).toBeLessThanOrEqual(8);
    expect(all.find((r) => r.id === "rt_pre_payroll")!.trigger).toEqual({ type: "cron", cron: "0 9 * * 1-5", tz: "America/Los_Angeles" });
  });

  it("GP4: the digest fires at 09:00 PT after +30 min from the seed clock, and a repeated slot is not run twice", async () => {
    const clock = mutableClock("2026-10-26T15:30:00.000Z");
    const agent = fakeAgent();
    const eng = createRoutines({ db, clock, agent, runs, readOnly: fakeRead() });
    await eng.tick(clock.now());
    expect(await eng.runs("rt_people_digest")).toHaveLength(0);
    clock.at = "2026-10-26T16:00:00.000Z";
    await eng.tick(clock.now());
    const digest = await eng.runs("rt_people_digest");
    expect(digest).toHaveLength(1);
    expect(digest[0]).toMatchObject({ triggerRef: "cron:2026-10-26T16:00:00.000Z", attended: false });
    expect(digest[0]!.runKey).toBe(runKey("rt_people_digest", "cron:2026-10-26T16:00:00.000Z"));
    expect(agent.started.map((s) => s.routine.id)).toContain("rt_people_digest");
    // Advancing again within the same slot, or replaying the tick, creates no duplicate.
    clock.at = "2026-10-26T16:10:00.000Z";
    await eng.tick(clock.now());
    await eng.fire((await eng.view.get("rt_people_digest"))!, { triggerRef: "cron:2026-10-26T16:00:00.000Z", payload: {}, attended: false, event: null });
    expect(await eng.runs("rt_people_digest")).toHaveLength(1);
  });

  it("rt_pre_payroll skips with zero tokens on Mon and Tue and runs on Wed Oct 28 09:00 PT", async () => {
    const clock = mutableClock("2026-10-26T15:30:00.000Z");
    const agent = fakeAgent();
    const eng = createRoutines({ db, clock, agent, runs, readOnly: fakeRead() });
    clock.at = "2026-10-28T16:30:00.000Z"; // Wed 09:30 PT: slots Mon 09:00, Tue 09:00, Wed 09:00
    await eng.tick(clock.now());
    const pre = (await eng.runs("rt_pre_payroll")).sort((a, b) => (a.triggerRef < b.triggerRef ? -1 : 1));
    expect(pre.map((r) => [r.triggerRef, r.status])).toEqual([
      ["cron:2026-10-26T16:00:00.000Z", "skipped"],
      ["cron:2026-10-27T16:00:00.000Z", "skipped"],
      ["cron:2026-10-28T16:00:00.000Z", "running"],
    ]);
    expect(pre[0]!.agentRunId).toBeNull();
    expect(pre[0]!.costUsdMicros).toBe(0);
    const started = agent.started.find((s) => s.routine.id === "rt_pre_payroll")!;
    expect(started.precheck).toMatchObject({ action: "run", derivedArgs: { "payroll.submit_run": { run_id: "pay_2026_10_30", exclude_blocked: true } } });
    expect(started.routineRun.attended).toBe(false);
  });

  it("'Run review now' is attended and bypasses the date gate", async () => {
    const clock = mutableClock("2026-10-26T15:30:00.000Z");
    const agent = fakeAgent();
    const eng = createRoutines({ db, clock, agent, runs, readOnly: fakeRead() });
    const { routineRunId } = await eng.trigger("rt_pre_payroll", { attended: true, requestedBy: "usr_0002" });
    const run = (await eng.getRun(routineRunId))!;
    expect(run).toMatchObject({ attended: true, status: "running" });
    expect(run.agentRunId).toMatch(/^run_/);
    expect(agent.started.at(-1)!.routineRun.attended).toBe(true);
  });

  it("converts the approval deadline to the PT calendar date", () => {
    expect(ptDate("2026-10-29T00:00:00.000Z")).toBe("2026-10-28");
    expect(ptDate("2026-10-28T16:00:00.000Z")).toBe("2026-10-28");
  });
});

describe("quiet hours and worth surfacing", () => {
  it("knows 19:00 to 07:00 PT", async () => {
    const { inQuietHours } = await import("../src/index");
    expect(inQuietHours("2026-10-27T03:00:00.000Z")).toBe(true);   // Mon 20:00 PT
    expect(inQuietHours("2026-10-26T16:00:00.000Z")).toBe(false);  // Mon 09:00 PT
    expect(inQuietHours("2026-10-27T13:59:00.000Z")).toBe(true);   // Tue 06:59 PT
  });

  it("a custom digest-severity cron routine is deferred in quiet hours and skipped when nothing changed", async () => {
    const clock = mutableClock("2026-10-26T15:30:00.000Z");
    const agent = fakeAgent();
    const eng = createRoutines({ db, clock, agent, runs, readOnly: fakeRead() });
    const base = (await eng.view.get("rt_people_digest"))!;
    const custom = { ...base, id: "rt_custom_0001", precheck: "open_approvals", source: "custom" as const, surface: { worthSurfacing: true, channel: "#payroll" } };
    const night = await eng.fire(custom, { triggerRef: "cron:2026-10-27T03:00:00.000Z", payload: {}, attended: false, event: null, at: "2026-10-27T03:00:00.000Z" });
    expect(night).toMatchObject({ status: "skipped", summary: expect.stringContaining("quiet hours") });
    const first = await eng.fire(custom, { triggerRef: "cron:2026-10-30T16:00:00.000Z", payload: {}, attended: false, event: null, at: "2026-10-30T16:00:00.000Z" });
    expect(first.status).toBe("running");
    const second = await eng.fire(custom, { triggerRef: "cron:2026-11-06T17:00:00.000Z", payload: {}, attended: false, event: null, at: "2026-11-06T17:00:00.000Z" });
    expect(second).toMatchObject({ status: "skipped", summary: "Nothing new since the last run." });
  });
});

describe("wave 4 round 1: rt_agency_notice plans, prebuilt refresh and skip spans (FG1)", () => {
  const notice = (n: Record<string, unknown>): ReadOnlyExecutor => ({
    async exec(_c, command) {
      if (command === "notices.get") return done({ notice: n });
      if (command === "tax.list_filings") return done({ filings: [{ id: "fil_0007", status: "draft", confirmation: null, filed_at: null }] });
      return done({});
    },
  });
  const event = (id: string) => ({ id: "evt_0001", type: "notice.received", ts: "2026-10-26T16:00:00.000Z", subjectRef: id, payload: { notice_id: id }, attended: true, requestedBy: "usr_dana" });

  it("a missing-filing notice starts an agent run with only its plan's tools and checklist items", async () => {
    const agent = fakeAgent();
    const engine = createRoutines({ db, clock: mutableClock("2026-10-26T16:00:00.000Z"), agent, runs, readOnly: notice({ id: "ntc_0002", kind: "missing_filing", status: "new", agency: "ny_dtf", form_code: "NYS-45", tax_account_id: "txa_0004", extracted: { formCode: "NYS-45", period: "2026-Q3", agency: "ny_dtf" } }) });
    const r = PREBUILT.find((x) => x.id === "rt_agency_notice")!;
    const run = await engine.fire(r, { triggerRef: "evt_0001", payload: { notice_id: "ntc_0002" }, attended: true, event: event("ntc_0002") as never });
    expect(run.status).toBe("running");
    const got = agent.started[0]!;
    expect(got.precheck).toMatchObject({ action: "run", derivedArgs: { plan: "file_return", "tax.prepare_filing": { filing_id: "fil_0007" }, "notices.escalate": { notice_id: "ntc_0002", reason_code: "missing_filing" } } });
    expect(got.routine.tools).toEqual(["notices.get", "notices.draft_response", "notices.send_response", "notices.escalate", "tax.prepare_filing", "tax.file_return"]);
    expect(got.routine.checklist.map((c) => c.id)).toEqual(["file_return"]);
    // The stored row keeps the whole list.
    expect((await engine.view.get("rt_agency_notice"))!.tools).toHaveLength(8);
  });

  it("the missing-filing checklist passes on the reply path or on an escalation, and fails on neither", async () => {
    const r = PREBUILT.find((x) => x.id === "rt_agency_notice")!;
    const { evaluateChecklist } = await import("../src/checks");
    const scope = { notice_id: "ntc_0002", plan: "file_return" };
    const ctx = { companyId: "cmp_larkspur", agentRunId: "run_0001", read: notice({}) };
    const facts = (calls: { command: string; status: "done" | "pending_approval"; args: unknown }[]) => ({ calls: calls.map((c, i) => ({ ...c, proposalId: c.status === "pending_approval" ? `prp_000${i}` : null, data: null })), proposalStatus: () => null });
    const reply = facts([{ command: "tax.prepare_filing", status: "done", args: { filing_id: "fil_0007" } }, { command: "notices.draft_response", status: "done", args: { notice_id: "ntc_0002" } }, { command: "tax.file_return", status: "pending_approval", args: { filing_id: "fil_0007" } }, { command: "notices.send_response", status: "pending_approval", args: { notice_id: "ntc_0002" } }]);
    const escalated = facts([{ command: "notices__escalate", status: "done", args: { notice_id: "ntc_0002", reason_code: "missing_filing" } }]);
    const draftOnly = facts([{ command: "notices.draft_response", status: "done", args: { notice_id: "ntc_0002" } }]);
    for (const [f, want] of [[reply, true], [escalated, true], [draftOnly, false]] as const) {
      const items = await evaluateChecklist(r, scope, f, ctx);
      expect(items.map((i) => [i.id, i.passed])).toEqual([["file_return", want]]);
    }
    // A rate change still has the three GP1 items.
    expect((await evaluateChecklist(r, { notice_id: "ntc_0001", plan: "update_rate" }, facts([]), ctx)).map((i) => i.id)).toEqual(["draft", "rate", "send"]);
  });

  it("a skipped routine run reports its reason to the tracer; an informational notice is skipped with why", async () => {
    const agent = fakeAgent() as ReturnType<typeof fakeAgent> & { traced: unknown[]; traceRoutineRun(t: unknown): void };
    agent.traced = [];
    agent.traceRoutineRun = (t) => { agent.traced.push(t); };
    const engine = createRoutines({ db, clock: mutableClock("2026-10-26T16:00:00.000Z"), agent, runs, readOnly: notice({ id: "ntc_0003", kind: "futa_credit_reduction", status: "new", agency: "irs", form_code: "FUTA", extracted: { formCode: "FUTA", agency: "irs" } }) });
    const r = PREBUILT.find((x) => x.id === "rt_agency_notice")!;
    const run = await engine.fire(r, { triggerRef: "evt_0003", payload: { notice_id: "ntc_0003" }, attended: false, event: event("ntc_0003") as never });
    expect(run.status).toBe("skipped");
    expect(run.summary).toContain("informational");
    expect(agent.started).toHaveLength(0);
    expect(agent.traced).toEqual([expect.objectContaining({ routineId: "rt_agency_notice", routineRunId: run.id, status: "skipped", reason: run.summary, precheck: "agency_notice", event: "notice.received", attended: false })]);
  });

  it("the folded rt_compliance_notices never runs even when enabled", async () => {
    const agent = fakeAgent();
    const engine = createRoutines({ db, clock: mutableClock("2026-10-26T16:00:00.000Z"), agent, runs, readOnly: notice({ id: "ntc_0002", kind: "missing_filing", status: "new" }) });
    const r = { ...PREBUILT.find((x) => x.id === "rt_compliance_notices")!, enabled: true };
    const run = await engine.fire(r, { triggerRef: "evt_0002", payload: { notice_id: "ntc_0002" }, attended: true, event: event("ntc_0002") as never });
    expect(run.status).toBe("skipped");
    expect(agent.started).toHaveLength(0);
  });

  it("ensurePrebuilt refreshes a prebuilt row's code-owned fields from an older build and keeps enabled and autonomy", async () => {
    const { routines } = await import("@weft/db");
    const { eq } = await import("drizzle-orm");
    const engine = createRoutines({ db, clock: mutableClock("2026-10-26T16:00:00.000Z"), agent: fakeAgent(), runs, readOnly: notice({}) });
    await engine.ensurePrebuilt();
    await db.update(routines).set({ toolsJson: JSON.stringify(["notices.get", "tax.get_rates"]), checklistJson: "[]", enabled: false, autonomy: "recommend" }).where(eq(routines.id, "rt_agency_notice"));
    const again = createRoutines({ db, clock: mutableClock("2026-10-26T16:00:00.000Z"), agent: fakeAgent(), runs, readOnly: notice({}) });
    const r = (await again.view.get("rt_agency_notice"))!;
    expect(r.tools).toEqual(PREBUILT.find((x) => x.id === "rt_agency_notice")!.tools);
    expect(r.checklist.length).toBeGreaterThan(3);
    expect(r).toMatchObject({ enabled: false, autonomy: "recommend" });
  });
});
