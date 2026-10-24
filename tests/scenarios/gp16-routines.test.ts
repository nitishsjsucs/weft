// Scenario GP16 (docs/wave3.md), routine parity. Owner: w3-parity-routines. Scripted provider (scenarios/rt_*.json).
// The New Hire Ready Check posts one ready line and one blocked line naming owners and adds an Inbox suggestion;
// the monthly exec report on the 1st posts to #leadership with numbers from the computed figures; milestones post
// anniversaries and only opted-in birthdays, never a year.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { AgentRunRow, RoutineRun } from "@weft/contracts";
import { bankAccounts, devices, itAccounts, proposals, simEmailMessages, taxProfiles, workers } from "@weft/db";
import { PREBUILT } from "../../packages/routines/src/prebuilt";
import { execFigures } from "../../packages/core/src/parity/exec-report";
import { readyLine as coreReadyLine } from "../../packages/core/src/parity/ready-check";
import { readyLine as brainReadyLine } from "../../packages/routines/src/wave3/parity";
import { createTestWeft, type TestWeft } from "./helpers";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
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
const chat = async (channel: string) => (await call("GET", `/v1/sim/chat?channel=${encodeURIComponent(channel)}`)).json as { text: string; author: string }[];

async function hire(id: string, first: string, state: string, ready: boolean) {
  const now = "2026-10-20T16:00:00.000Z";
  await weft.db.insert(workers).values({
    id, companyId: "cmp_larkspur", employeeNumber: null, type: "employee", workerType: "w2", status: "onboarding", firstName: first, lastName: "Tester",
    workEmail: `${first.toLowerCase()}.tester@larkspur.example`, title: "Robotics Engineer", departmentId: "dpt_hardware", managerId: null, workplaceId: null,
    workState: state, timezone: "America/Los_Angeles", startDate: "2026-10-28", payScheduleId: "ps_us_semimonthly", createdAt: now, updatedAt: now,
  });
  if (!ready) {
    await weft.db.insert(itAccounts).values({ id: `ita_${id.slice(4)}a`, workerId: id, system: "chat", handle: first.toLowerCase(), status: "active" });
    return;
  }
  for (const system of ["chat", "google_ws", "github"]) await weft.db.insert(itAccounts).values({ id: `ita_${id.slice(4)}${system.slice(0, 2)}`, workerId: id, system, handle: first.toLowerCase(), status: "active" });
  await weft.db.insert(devices).values({ id: `dev_${id.slice(4)}`, workerId: id, model: "Larkspur standard laptop", status: "delivered", priceCents: 189_900 });
  await weft.db.insert(bankAccounts).values({ id: `bnk_${id.slice(4)}`, workerId: id, bankName: "Tidepool Federal Credit Union", accountLast4: "4242", routingLast4: "0001", credentialRef: `vault:bank-${id}`, status: "active", source: "seed" });
  await weft.db.insert(taxProfiles).values({ workerId: id, w4Version: "2020", filingStatus: "single", source: "portal" });
}

describe("GP16 routine parity", () => {
  it("the new routines ship disabled with at most 8 tools and scripted scenarios", () => {
    for (const id of ["rt_new_hire_ready", "rt_monthly_exec_report", "rt_exec_briefing", "rt_milestones"]) {
      const r = PREBUILT.find((x) => x.id === id);
      expect(r, id).toBeDefined();
      expect(r!.enabled, id).toBe(false);
      expect(r!.tools.length, id).toBeLessThanOrEqual(8);
    }
  });

  it("GET /v1/routines carries the next cron slot for enabled routines and no last run before any run", async () => {
    const rows = (await call("GET", "/v1/routines")).json as { id: string; enabled: boolean; nextRunAt: string | null; lastRun: unknown }[];
    expect(rows.find((r) => r.id === "rt_people_digest")).toMatchObject({ enabled: true, nextRunAt: "2026-10-26T16:00:00.000Z", lastRun: null });
    expect(rows.find((r) => r.id === "rt_new_hire_ready")).toMatchObject({ enabled: false, nextRunAt: null, lastRun: null });
  });

  it("the brain's ready line matches core's", () => {
    const h = { worker_id: "wrk_x", name: "A B", start_date: "2026-10-28", work_state: "CA", first_day: false, ready: false, items: [], blocked: [{ item: "bank_verified" as const, label: "direct deposit account", owner: "the hire" as const }] };
    for (const v of [h, { ...h, ready: true, blocked: [] }, { ...h, first_day: true }, { ...h, first_day: true, ready: true, blocked: [] }]) expect(brainReadyLine(v)).toBe(coreReadyLine(v));
  });

  it("New Hire Ready Check: one ready line, one blocked line naming owners, and an Inbox suggestion", async () => {
    await hire("wrk_0901", "Robin", "CA", true);
    await hire("wrk_0902", "Kai", "CO", false);
    const run = await trigger("rt_new_hire_ready");
    expect(run.status, JSON.stringify(run)).toBe("done");
    const post = (await chat("#new-hires")).find((m) => m.text.includes("Ready for day one"));
    expect(post?.text).toBe([
      "Ready for day one: Robin Tester starts 2026-10-28. Accounts, laptop, pay and paperwork are all set.",
      "Not ready yet: Kai Tester starts 2026-10-28. Blocking: work accounts (IT), laptop delivered (IT), direct deposit account (the hire), federal W-4 (the hire), state payroll registration (payroll).",
    ].join("\n"));
    const sug = (await weft.db.select().from(proposals).where(eq(proposals.kind, "suggestion"))).filter((p) => p.status === "pending");
    expect(sug.map((p) => [p.subjectRef, p.command])).toEqual([["wrk_0902", "onboarding.flag_not_ready"]]);
    expect(sug[0]!.headline).toContain("Kai Tester");
    const inbox = (await call("GET", "/v1/proposals?status=pending")).json;
    expect(JSON.stringify(inbox)).toContain(sug[0]!.id);
    const rows = (await call("GET", "/v1/routines")).json as { id: string; lastRun: { id: string; status: string } | null }[];
    expect(rows.find((r) => r.id === "rt_new_hire_ready")?.lastRun).toMatchObject({ id: run.id, status: "done" });
  });

  it("a second run the same day refreshes the suggestion instead of adding one", async () => {
    await weft.db.update(bankAccounts).set({ status: "active" }).where(eq(bankAccounts.workerId, "wrk_0901"));
    const { json } = await call("POST", "/v1/tools/onboarding.flag_not_ready", { worker_ids: ["wrk_0902", "wrk_0901"] });
    expect(json.ok, JSON.stringify(json)).toBe(true);
    const pending = (await weft.db.select().from(proposals).where(eq(proposals.kind, "suggestion"))).filter((p) => p.status === "pending");
    expect(pending).toHaveLength(1);
  });

  it("monthly exec report on the 1st posts to #leadership and emails leadership, numbers from the computed figures", async () => {
    await weft.clock.set("2026-11-01T16:00:00.000Z", 0);   // Sun Nov 1, 09:00 PT
    const run = await trigger("rt_monthly_exec_report");
    expect(run.status, JSON.stringify(run)).toBe("done");
    const f = await execFigures(weft.db, "cmp_larkspur", { kind: "monthly", asOf: "2026-11-01" });
    expect(f.month).toBe("2026-10");
    expect(f.cost.runs).toBe(1);   // pay_2026_10_15; the Oct 30 draft is not processed
    const posts = (await chat("#leadership")).filter((m) => m.text.startsWith("Monthly exec report for October 2026"));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain(`${f.headcount} employees at month end`);
    expect(posts[0]!.text).toContain(`Payroll cost ${f.cost.total_cost_display} across 1 processed run`);
    expect(posts[0]!.text).toContain(`from September 2026 (${f.previous.total_cost_display})`);
    expect(posts[0]!.text).not.toMatch(/\u2014/);
    const list = await weft.db.select().from(simEmailMessages);
    expect(list.some((m) => m.toAddr === "leadership@larkspur.example" && m.subject === "Exec report for October 2026")).toBe(true);
    const pre = run.precheck as { action: string; derivedArgs: Record<string, unknown> };
    expect(pre.derivedArgs["comms.send_exec_report"]).toEqual({ kind: "monthly", month: "2026-10", as_of: "2026-11-01" });
  });

  it("milestones post anniversaries and only opted-in birthdays, never a year", async () => {
    const people = (await weft.db.select().from(workers)).filter((w) => w.status === "active" && w.startDate < "2026-01-01");
    const day = people.map((w) => `2026-${w.startDate.slice(5)}`).filter((d) => d >= "2026-11-02" && d <= "2026-12-31").sort()[0];
    expect(day, "an anniversary between Nov 2 and Dec 31").toBeDefined();
    await weft.clock.set(`${day}T17:00:00.000Z`, 0);
    const run = await trigger("rt_milestones");
    expect(run.status, JSON.stringify(run)).toBe("done");
    const post = (await chat("#general")).find((m) => m.text.startsWith("Milestones today"));
    expect(post).toBeDefined();
    for (const w of people.filter((p) => p.startDate.slice(5) === day!.slice(5))) expect(post!.text).toContain(`work anniversary, ${w.firstName} ${w.lastName}`);
    const birthdays = [...post!.text.matchAll(/Happy birthday, ([^!]+)!/g)].map((m) => m[1]);
    const all = await weft.db.select().from(workers);
    for (const name of birthdays) expect(all.find((w) => `${w.firstName} ${w.lastName}` === name)?.birthMonthDay).toBe(day!.slice(5));
    for (const w of all.filter((x) => x.birthMonthDay === null)) expect(post!.text).not.toContain(`Happy birthday, ${w.firstName} ${w.lastName}`);
    expect(post!.text).not.toMatch(/\b(19|20)\d{2}\b/);
  });
});
