// Wave 4 read shapes on the chat surface (docs/evals/error-analysis.md FM2, FM7, FM8), through the executor as a chat
// run calls them (redaction, offload and the frozen allowlist included), on the seeded world plus the ON-02 and OF-01
// mutations. Scripted provider only; nothing here calls a live model.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { CHAT_TOOLS_W3, type ToolOutcome } from "@weft/contracts";
import { registered } from "../src/agent/chat-allowlist";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
const CAP = 8000;   // the executor's observation cap (packages/executor/src/workspace.ts)
const session = (principalId: string) => ({ principalId, companyId: "cmp_larkspur", via: "ui" as const, keyScope: null });
async function call(method: string, path: string, body?: unknown) {
  const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status >= 300) throw new Error(`${method} ${path} answered ${res.status} ${(await res.text()).slice(0, 200)}`);
}

let handle: Awaited<ReturnType<TestWeft["executor"]["runs"]["openChatRun"]>>;
let n = 0;
async function exec(command: string, args: unknown): Promise<ToolOutcome> {
  return weft.executor.agent.exec(handle, { callId: `c${++n}`, command, args });
}
const refOf = (o: ToolOutcome): string | null | undefined => (o.ok && o.status === "done" ? o.artifactRef : undefined);
function done<T = Record<string, unknown>>(o: ToolOutcome): T {
  if (!(o.ok && o.status === "done")) throw new Error(JSON.stringify(o).slice(0, 400));
  return o.data as T;
}

beforeAll(async () => {
  weft = await createTestWeft();
  // ON-02: Noor accepts; OF-01: Imani gets an SSO account and is terminated with last day Oct 30.
  await call("POST", "/v1/offers/offr_0001/accept");
  await call("POST", "/v1/tools/it.create_account", { worker_id: "wrk_0004", system: "sso" });
  await call("POST", "/v1/workers/wrk_0004/terminate", { kind: "voluntary", lastDay: "2026-10-30", reasonNote: "Moving abroad", payUnusedPto: true });
  handle = await weft.executor.runs.openChatRun(session("usr_dana"), { threadId: null, surface: "human_ui", allowlist: registered(weft.executor.registry, CHAT_TOOLS_W3)! });
});
afterAll(async () => { await weft.close(); });

type Item = { kind: string; label: string; status: string };

describe("people.get carries the open onboarding items and the offboarding steps (FM2)", () => {
  it("an onboarding worker: open checklist items with status, the I-9 among them", async () => {
    const o = await exec("people.get", { worker_id: "wrk_0052" });
    expect(refOf(o)).toBeNull();
    const w = done<{ worker: { status: string; onboarding: { open_count: number; done_count: number; open_items: Item[]; done: string[] } } }>(o).worker;
    expect(w.status).toBe("onboarding");
    const i9 = w.onboarding.open_items.find((t) => t.kind === "i9_sim");
    expect(i9).toMatchObject({ status: "pending" });
    expect(i9!.label).toContain("I-9");
    expect(w.onboarding.open_count).toBe(w.onboarding.open_items.length);
    expect(w.onboarding.open_items.every((t) => t.status !== "done")).toBe(true);
    expect(w.onboarding.done).toContain("Federal W-4");
    expect(JSON.stringify(done(o)).length).toBeLessThan(CAP);
  });

  it("an offboarding worker: every case step with status, COBRA included", async () => {
    const o = await exec("people.get", { worker_id: "wrk_0004" });
    const w = done<{ worker: { status: string; offboarding: { case_id: string; last_day: string; open_count: number; steps: Item[] } } }>(o).worker;
    expect(w.status).toBe("offboarding");
    expect(w.offboarding.case_id).toMatch(/^ofb_/);
    expect(w.offboarding.last_day).toBe("2026-10-30");
    expect(w.offboarding.steps.map((s) => s.kind)).toEqual(["final_pay", "directory_suspend", "sso_deactivate", "group_removal", "app_removal", "device_lock", "cobra_notice", "benefits_terminate"]);
    expect(w.offboarding.steps.find((s) => s.kind === "cobra_notice")).toMatchObject({ label: "COBRA notice", status: "pending" });
    expect(w.offboarding.open_count).toBe(w.offboarding.steps.filter((s) => s.status !== "done" && s.status !== "skipped").length);
  });

  it("an active worker gets neither block", async () => {
    const w = done<{ worker: Record<string, unknown> }>(await exec("people.get", { worker_id: "wrk_0001" })).worker;
    expect(w.status).toBe("active");
    expect(w).not.toHaveProperty("onboarding");
    expect(w).not.toHaveProperty("offboarding");
  });
});

describe("people.search start window and limits (FM7)", () => {
  it("filters by start date, inclusive, and echoes the window", async () => {
    const d = done<{ total: number; start_window: unknown; workers: { name: string; start_date: string }[] }>(await exec("people.search", { start_from: "2026-10-26", start_to: "2026-11-09" }));
    expect(d.start_window).toEqual({ from: "2026-10-26", to: "2026-11-09" });
    expect(d.workers.length).toBe(d.total);
    expect(d.workers.every((w) => w.start_date >= "2026-10-26" && w.start_date <= "2026-11-09")).toBe(true);
    expect(d.workers.some((w) => w.name.includes("wrk_0052"))).toBe(true);
    const open = done<{ start_window: unknown; total: number }>(await exec("people.search", { start_from: "2026-10-01" }));
    expect(open.start_window).toEqual({ from: "2026-10-01", to: null });
  });

  it("a clamped limit is reported, the offloaded payload keeps total next to row_count, and its page is never offloaded again", async () => {
    const o = await exec("people.search", { limit: 100 });
    if (!(o.ok && o.status === "done")) throw new Error("search failed");
    const d = o.data as { total: number; row_count: number; limit_applied: number; limit_note: string; truncated_note: string; total_note: string; preview: unknown[] };
    expect(o.artifactRef).toMatch(/^art_/);
    expect(d.limit_applied).toBe(50);
    expect(d.limit_note).toContain("used 50");
    expect(d.row_count).toBe(50);
    expect(d.total).toBeGreaterThan(50);
    expect(d.truncated_note).toContain(`50 of ${d.total}`);
    expect(d.total_note).toContain(String(d.total));
    const page = await exec("agent.read_artifact", { ref: o.artifactRef, offset: 0, limit: 50 });
    if (!(page.ok && page.status === "done")) throw new Error("page failed");
    expect(page.artifactRef).toBeNull();
    const p = page.data as { rows: unknown[]; total: number; row_count: number; next_offset: number | null; has_more: boolean; returned: number };
    expect(JSON.stringify(p).length).toBeLessThanOrEqual(CAP);
    expect(p.total).toBe(d.total);
    expect(p.row_count).toBe(50);
    expect(p.returned).toBe(p.rows.length);
    expect(p.rows.length).toBeGreaterThan(10);
    if (p.rows.length < 50) expect(p).toMatchObject({ has_more: true, next_offset: p.rows.length });
    const rest = done<{ rows: unknown[]; offset: number }>(await exec("agent.read_artifact", { ref: o.artifactRef, offset: p.rows.length }));
    expect(rest.offset).toBe(p.rows.length);
    expect(p.rows.length + rest.rows.length).toBe(50);
  });
});

describe("payroll run reads carry the approval facts (FM8, CQ-06)", () => {
  it("list_runs and get_run name the approver and the time once a run is submitted; drafts have nulls", async () => {
    const runs = done<{ runs: { run_id: string; status: string; approved_by: string | null; approved_by_id: string | null; approved_at: string | null }[] }>(await exec("payroll.list_runs", {})).runs;
    const processed = runs.filter((r) => r.status === "processed");
    expect(processed.length).toBeGreaterThan(0);
    const display = new Map((await weft.db.all<{ id: string; display: string }>(sql`SELECT id, display FROM principals`)).map((p) => [p.id, p.display]));
    for (const r of processed) {
      expect(r.approved_by_id).toMatch(/^usr_/);
      expect(r.approved_by).toBe(display.get(r.approved_by_id!));
      expect(r.approved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    for (const r of runs.filter((x) => x.status === "draft")) expect(r).toMatchObject({ approved_by: null, approved_by_id: null, approved_at: null });
    const last = processed.at(-1)!;
    const one = done<{ approved_by: string; approved_at: string }>(await exec("payroll.get_run", { run_id: last.run_id }));
    expect(one).toMatchObject({ approved_by: last.approved_by, approved_at: last.approved_at });
  });
});

describe("actions.list arguments (FM8)", () => {
  it("a pay run id is refused with a pointer to payroll.get_run", async () => {
    const o = await exec("actions.list", { agent_run_id: "pay_2026_10_30" });
    expect(o.ok).toBe(false);
    if (o.ok) return;
    expect(o.refusal.code).toBe("INVALID_INPUT");
    expect(o.refusal.hint).toContain("payroll.get_run");
  });

  it("an over-large limit is clamped and reported, not refused", async () => {
    const d = done<{ limit_applied: number; limit_note: string; actions: unknown[] }>(await exec("actions.list", { limit: 100 }));
    expect(d.limit_applied).toBe(50);
    expect(d.limit_note).toContain("used 50");
    expect(d.actions.length).toBeLessThanOrEqual(50);
  });

  it("an unknown command filter answers with the nearest names, ones with audit rows first", async () => {
    const o = await exec("actions.list", { command: "payroll.approve" });
    expect(o.ok).toBe(false);
    if (o.ok) return;
    expect(o.refusal.code).toBe("UNKNOWN_REFERENCE");
    expect(o.refusal.message).toMatch(/nearest: payroll\./);
    // A small namespace is listed whole, so the real verb is there although it shares no letters with the guess.
    expect(o.refusal.message).toContain("payroll.submit_run");
    expect(o.refusal.hint).toContain("never in the audit log");
    const named = done<{ actions: { command: string }[] }>(await exec("actions.list", { command: "offboarding.terminate" }));
    expect(named.actions.length).toBeGreaterThan(0);
    // A registered command with no audit rows yet is a plain empty list, not a refusal.
    const empty = done<{ actions: unknown[] }>(await exec("actions.list", { command: "tax.update_rate" }));
    expect(empty.actions).toEqual([]);
  });
});
