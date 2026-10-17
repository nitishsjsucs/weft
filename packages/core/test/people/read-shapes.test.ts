// Wave 4 read shapes (docs/evals/error-analysis.md FM2, FM7, FM8) on the payroll fixture world: people.search's start
// window and limit report, people.get's onboarding and offboarding blocks, and the approval facts on pay run reads.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExecContext, SimClock, Simulators } from "@weft/contracts";
import { onboardingTasks, principals, workers, type Db } from "@weft/db";
import { eq } from "drizzle-orm";
import { idMinter } from "../../src/shared/ids";
import { peopleCommands, SEARCH_MAX } from "../../src/commands/people";
import { onboardingCommands } from "../../src/commands/onboarding";
import { payrollCommands } from "../../src/commands/payroll";
import { insertCase } from "../../src/offboarding/cases";
import { seedPayHistory } from "../../src/payroll/index";
import type { CommandDeps } from "../../src/shared/deps";
import { buildFixtureWorld, CO, fakeBank, openTempDb, PS, TS, type FixtureIds } from "../payroll/fixture-world";

let db: Db;
let ids: FixtureIds;
let close: () => Promise<void>;
const bank = fakeBank();
const clock: SimClock = { now: () => TS, rate: () => 0, advance: async () => {}, set: async () => {} };

beforeAll(async () => {
  const t = await openTempDb();
  db = t.db; close = t.close;
  ids = await buildFixtureWorld(db);
  await db.insert(principals).values({ id: "usr_theo", companyId: CO, kind: "human", workerId: null, display: "Theo Marsh (demo)", email: "theo@larkspur.example", role: "payroll_admin", grantsJson: "[]" });
  await seedPayHistory(db, { newId: idMinter(db), bank: bank.bank, credential: "vault:sim-bank-operating", approvedBy: "usr_theo", draftCreatedAt: TS }, { companyId: CO, payScheduleId: PS });
});
afterAll(async () => { await close(); });

const deps = (): CommandDeps => ({ tx: db, sims: { bank: bank.bank } as unknown as Simulators, clock, newId: idMinter(db), resolveCredential: async (ref) => `secret-for-${ref}` });
const ctx = (): ExecContext => ({ companyId: CO, principal: { id: "usr_theo", kind: "human", role: "payroll_admin" }, onBehalfOf: null, surface: "human_ui", agentKind: null, run: null, tainted: false, routineRunId: null, approvedProposalId: null, now: TS });
const all = [...peopleCommands, ...onboardingCommands, ...payrollCommands];
async function exec<T = Record<string, unknown>>(name: string, args: unknown): Promise<T> {
  const def = all.find((c) => c.name === name)!;
  return (await def.run(def.input.parse(args) as never, ctx(), deps())).data as T;
}

describe("people.search", () => {
  it("filters by an inclusive start date window and echoes it", async () => {
    const d = await exec<{ total: number; start_window: unknown; workers: { id: string; start_date: string }[] }>("people.search", { start_from: "2026-10-01", start_to: "2026-10-19" });
    expect(d.start_window).toEqual({ from: "2026-10-01", to: "2026-10-19" });
    expect(d.workers.map((w) => w.id).sort()).toEqual([...ids.caOct1, ids.caOct19].sort());
    expect(d.workers.every((w) => w.start_date >= "2026-10-01" && w.start_date <= "2026-10-19")).toBe(true);
    const none = await exec<{ total: number }>("people.search", { start_from: "2027-01-01" });
    expect(none.total).toBe(0);
    const plain = await exec<Record<string, unknown>>("people.search", { query: "zzz-nobody" });
    expect(plain).not.toHaveProperty("start_window");
  });

  it("reports a clamped limit and a truncated list instead of dropping rows silently", async () => {
    // The fixture world has 48 workers: limit 100 is clamped to 50 (all fit), limit 10 truncates.
    const d = await exec<Record<string, unknown> & { workers: unknown[]; total: number }>("people.search", { limit: 100 });
    expect(d).toMatchObject({ total: 48, count: 48, limit_applied: SEARCH_MAX });
    expect(String(d.limit_note)).toContain(`used ${SEARCH_MAX}`);
    expect(d).not.toHaveProperty("truncated_note");
    const t = await exec<Record<string, unknown> & { workers: unknown[] }>("people.search", { limit: 10 });
    expect(t.workers).toHaveLength(10);
    expect(t).toMatchObject({ total: 48, count: 10, limit_applied: 10 });
    expect(String(t.truncated_note)).toContain("10 of 48");
    expect(t).not.toHaveProperty("limit_note");
    const zero = await exec<Record<string, unknown>>("people.search", { state: "TX", limit: 0 });
    expect(zero).toMatchObject({ limit_applied: 1 });
    expect(String(zero.limit_note)).toContain("used 1");
  });

  it("counts by department with ids, so a department-scoped read can follow", async () => {
    const d = await exec<{ total: number; by_department: { department_id: string; count: number }[] }>("people.search", {});
    expect(d.by_department.reduce((s, x) => s + x.count, 0)).toBeLessThanOrEqual(d.total);
    for (const x of d.by_department) expect(typeof x.department_id).toBe("string");
  });
});

describe("people.get", () => {
  it("an onboarding worker carries the open checklist items with status and the done ones by label", async () => {
    const id = ids.caOct19;
    await db.update(workers).set({ status: "onboarding" }).where(eq(workers.id, id));
    await db.insert(onboardingTasks).values([
      { id: "obt_9001", workerId: id, kind: "federal_w4", status: "done", owner: "employee", dueOn: "2026-10-19", doneAt: TS, blockedReason: null },
      { id: "obt_9002", workerId: id, kind: "i9_sim", status: "pending", owner: "hr", dueOn: "2026-10-22", doneAt: null, blockedReason: null },
      { id: "obt_9003", workerId: id, kind: "direct_deposit", status: "blocked", owner: "employee", dueOn: "2026-10-19", doneAt: null, blockedReason: "no bank account" },
    ] as never);
    const w = (await exec<{ worker: { onboarding: { open_count: number; done_count: number; open_items: { kind: string; label: string; status: string; blocked_reason: string | null }[]; done: string[] } } }>("people.get", { worker_id: id })).worker;
    expect(w.onboarding.open_count).toBe(2);
    expect(w.onboarding.done_count).toBe(1);
    expect(w.onboarding.done).toEqual(["Federal W-4"]);
    expect(w.onboarding.open_items.map((t) => [t.kind, t.status])).toEqual([["direct_deposit", "blocked"], ["i9_sim", "pending"]]);
    expect(w.onboarding.open_items.find((t) => t.kind === "i9_sim")!.label).toBe("Form I-9 (simulated)");
    expect(w.onboarding.open_items.find((t) => t.kind === "direct_deposit")!.blocked_reason).toBe("no bank account");
    // The checklist read labels its items the same way.
    const cl = await exec<{ tasks: { kind: string; label: string }[] }>("onboarding.get_checklist", { worker_id: id });
    expect(cl.tasks.find((t) => t.kind === "i9_sim")!.label).toBe("Form I-9 (simulated)");
  });

  it("an offboarding worker carries the case and every step with status", async () => {
    const id = ids.nyOffboard;
    await db.update(workers).set({ status: "offboarding" }).where(eq(workers.id, id));
    await insertCase(db, { newId: idMinter(db) as never, now: TS }, { companyId: CO, workerId: id, kind: "voluntary", lastDay: "2026-10-23", reasonNote: "", payUnusedPto: true });
    const w = (await exec<{ worker: { offboarding: { case_id: string; case_status: string; last_day: string; open_count: number; finished_count: number; steps: { kind: string; label: string; status: string }[] } } }>("people.get", { worker_id: id })).worker;
    expect(w.offboarding.case_id).toMatch(/^ofb_/);
    expect(w.offboarding).toMatchObject({ case_status: "open", last_day: "2026-10-23" });
    expect(w.offboarding.steps).toHaveLength(8);
    expect(w.offboarding.open_count + w.offboarding.finished_count).toBe(8);
    expect(w.offboarding.steps.find((s) => s.kind === "cobra_notice")!.label).toBe("COBRA notice");
  });

  it("an active worker has neither block", async () => {
    const w = (await exec<{ worker: Record<string, unknown> }>("people.get", { worker_id: ids.txSpike })).worker;
    expect(w).not.toHaveProperty("onboarding");
    expect(w).not.toHaveProperty("offboarding");
  });
});

describe("pay run approval facts", () => {
  it("list_runs and get_run name the approver (readable) and the time; drafts carry nulls", async () => {
    const runs = (await exec<{ runs: { run_id: string; status: string; approved_by: string | null; approved_by_id: string | null; approved_at: string | null }[] }>("payroll.list_runs", {})).runs;
    const submitted = runs.filter((r) => r.status !== "draft");
    expect(submitted.length).toBeGreaterThan(0);
    for (const r of submitted) expect(r).toMatchObject({ approved_by: "Theo Marsh (demo)", approved_by_id: "usr_theo", approved_at: expect.stringMatching(/^2026-/) });
    for (const r of runs.filter((x) => x.status === "draft")) expect(r).toMatchObject({ approved_by: null, approved_by_id: null, approved_at: null });
    const one = await exec<Record<string, unknown>>("payroll.get_run", { run_id: submitted.at(-1)!.run_id });
    expect(one).toMatchObject({ approved_by: "Theo Marsh (demo)", approved_by_id: "usr_theo", approved_at: submitted.at(-1)!.approved_at });
  });

  it("an approver with no principal row falls back to the id", async () => {
    await db.delete(principals).where(eq(principals.id, "usr_theo"));
    const runs = (await exec<{ runs: { status: string; approved_by: string | null }[] }>("payroll.list_runs", { status: "processed" })).runs;
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) expect(r.approved_by).toBe("usr_theo");
  });
});
