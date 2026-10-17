// Route tests for /v1/routines (owner: t4-agent): a real routines engine on a temp database, a fake agent runtime,
// a read-only executor that answers the digest precheck, and a recording HumanExecutor for draft, enable and disable.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentRuntime, HumanSession, RoutineDef, SimClock, ToolOutcome } from "@weft/contracts";
import { closeDb, events, migrate, openDb, type Db } from "@weft/db";
import { createRoutines, type WeftRoutinesEngine } from "@weft/routines";
import type { Weft, WeftEnv } from "../src/http/context";
import { toErrorResponse } from "../src/http/errors";
import { createRoutinesEventSource, routinesRoutes } from "../src/routes/routines";

const clock: SimClock & { at: string } = { at: "2026-10-26T15:30:00.000Z", now: () => clock.at, rate: () => 0, advance: async () => undefined, set: async () => undefined };
const session: HumanSession = { principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui", keyScope: null };
const ok = (data: unknown): ToolOutcome => ({ ok: true, status: "done", resultId: "res_1", data, summary: "ok", actionSeq: 1, artifactRef: null, tainted: false, label: "synthetic" });
let dir: string;
let db: Db;
let app: Hono<WeftEnv>;
let engine: WeftRoutinesEngine;
const humanCalls: { command: string; args: unknown }[] = [];
let kicks = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "weft-routine-routes-"));
  db = openDb({ dataDir: dir });
  await migrate(db);
  const agent = { startRoutineRun: async () => undefined, subscribe: () => () => undefined, requeue: async () => undefined } as unknown as AgentRuntime;
  let runN = 0;
  engine = createRoutines({
    db, clock, agent, runs: { openRoutineRun: async () => ({ runId: `run_${String(++runN).padStart(4, "0")}`, token: "t" }) },
    readOnly: { exec: async (_c, command) => ok(command === "people.search" ? { total: 48 } : { runs: [] }) },
  });
  const weft = {
    db, clock, routines: engine, provider: { id: "scripted", model: "scripted", label: "Scripted, no model", live: false },
    scheduler: { kick: async () => { kicks++; } },
    executor: { human: { exec: async (_s: HumanSession, command: string, args: unknown) => { humanCalls.push({ command, args }); return ok({ routine_id: "rt_custom_0001", enabled: false }); } } },
  } as unknown as Weft;
  app = new Hono<WeftEnv>();
  app.onError((err, c) => toErrorResponse(err, c));
  app.use("*", async (c, next) => { c.set("weft", weft); c.set("session", session); await next(); });
  app.route("/", routinesRoutes(weft));
});
afterAll(async () => {
  await closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body?: unknown) => app.request(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("/v1/routines routes", () => {
  it("lists the prebuilt routines (wave 1, wave 2 and wave 3) and reads one", async () => {
    const list = (await (await app.request("/v1/routines")).json()) as RoutineDef[];
    expect(list.map((r) => r.id)).toEqual(["rt_agency_notice", "rt_ats_hire", "rt_benefits_window_reminders", "rt_contractor_forms", "rt_exec_briefing", "rt_expense_review", "rt_first_day_message", "rt_life_event_window", "rt_memory_digest", "rt_milestones", "rt_monthly_exec_report", "rt_new_hire", "rt_new_hire_ready", "rt_onboarding_nudge", "rt_open_enrollment", "rt_people_digest", "rt_pre_payroll", "rt_screening_follow_up", "rt_thirty_day_checkin", "rt_time_off_requests"]);
    const one = (await (await app.request("/v1/routines/rt_pre_payroll")).json()) as RoutineDef;
    expect(one.trigger).toEqual({ type: "cron", cron: "0 9 * * 1-5", tz: "America/Los_Angeles" });
    expect((await app.request("/v1/routines/rt_nope")).status).toBe(404);
  });

  it("GP4: after +30 min the digest run shows in the run log with its cron trigger", async () => {
    clock.at = "2026-10-26T16:00:00.000Z";
    await engine.tick(clock.now());
    const page = (await (await app.request("/v1/routines/rt_people_digest/runs")).json()) as { count: number; data: { id: string; triggerRef: string; attended: boolean }[] };
    expect(page.count).toBe(1);
    expect(page.data[0]).toMatchObject({ triggerRef: "cron:2026-10-26T16:00:00.000Z", attended: false });
    const run = await app.request(`/v1/routine-runs/${page.data[0]!.id}`);
    expect(run.status).toBe(200);
  });

  it("draft runs the parser, then routines.draft as the human, and kicks the scheduler", async () => {
    const before = kicks;
    const res = await post("/v1/routines/draft", { prompt: "Every Friday, post open approvals to #payroll" });
    expect(res.status).toBe(200);
    expect(humanCalls.at(-1)).toMatchObject({ command: "routines.draft", args: { cron: "0 9 * * 5", tz: "America/Los_Angeles", channel: "#payroll", tools: ["comms.send_message"] } });
    expect(kicks).toBe(before + 1);
    const bad = await post("/v1/routines/draft", { prompt: "remind me sometimes" });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ _tag: "Refused", code: "NO_SCHEDULE" });
  });

  it("trigger is attended and returns the routine run id; enable and disable go through the HumanExecutor", async () => {
    const res = await post("/v1/routines/rt_people_digest/trigger");
    expect(res.status).toBe(200);
    const { routineRunId } = (await res.json()) as { routineRunId: string };
    expect((await engine.getRun(routineRunId))?.attended).toBe(true);
    expect((await post("/v1/routines/rt_people_digest/disable")).status).toBe(200);
    expect(humanCalls.at(-1)).toEqual({ command: "routines.disable", args: { routine_id: "rt_people_digest" } });
  });

  it("the events source lists unconsumed events in order and consume marks only the routines consumer", async () => {
    const src = createRoutinesEventSource(db);
    const base = { ts: clock.at, subjectRef: "ntc_1", attended: false, requestedBy: null };
    await db.insert(events).values([
      { id: "evt_a", type: "notice.received", payloadJson: JSON.stringify({ notice_id: "ntc_1" }), consumedJson: "[]", ...base },
      { id: "evt_b", type: "worker.hired", payloadJson: JSON.stringify({ worker_id: "wkr_1" }), consumedJson: JSON.stringify(["handler"]), ...base, attended: true, requestedBy: "usr_dana" },
    ]);
    const first = await src.unconsumed();
    expect(first.map((e) => e.id)).toEqual(["evt_a", "evt_b"]);
    expect(first[1]).toMatchObject({ type: "worker.hired", payload: { worker_id: "wkr_1" }, attended: true, requestedBy: "usr_dana" });
    await src.consume("evt_a");
    await src.consume("evt_a");
    expect((await src.unconsumed()).map((e) => e.id)).toEqual(["evt_b"]);
    await src.consume("evt_b");
    expect(await src.unconsumed()).toEqual([]);
    const rows = await db.select().from(events);
    expect(Object.fromEntries(rows.map((r) => [r.id, JSON.parse(r.consumedJson)]))).toEqual({ evt_a: ["routines"], evt_b: ["handler", "routines"] });
  });
});
