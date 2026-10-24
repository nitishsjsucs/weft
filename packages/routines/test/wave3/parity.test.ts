// Wave 3 parity routines in isolation (packages/routines/src/wave3/parity.ts). Owner: w3-parity-routines.
// Every routine ships disabled with at most 8 tools, a registered precheck, checklist predicates that exist and a
// scripted scenario; each precheck skips when there is nothing to do and derives exactly the arguments its write
// needs; each predicate passes on a done or live pending call and fails on a refused or dead one.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Cron } from "croner";
import type { ReadOnlyExecutor, ToolOutcome } from "@weft/contracts";
import { PRECHECKS } from "../../src/index";
import { predicates, prechecks, routines } from "../../src/wave3/parity";
import type { RunCall, RunFacts } from "../../src/checks";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const done = (data: unknown): ToolOutcome => ({ ok: true, status: "done", resultId: "res_1", data, summary: "ok", actionSeq: null, artifactRef: null, tainted: false, label: "synthetic" });
const exec = (answers: Record<string, unknown>): ReadOnlyExecutor & { seen: { command: string; args: unknown }[] } => {
  const seen: { command: string; args: unknown }[] = [];
  return { seen, async exec(_c, command, args) { seen.push({ command, args }); return done(answers[command] ?? {}); } };
};
const failing: ReadOnlyExecutor = { async exec() { return { ok: false, status: "refused", code: "NOT_PERMITTED", message: "no", hint: null, example: null } as unknown as ToolOutcome; } };
// Mon Nov 2 2026, 09:00 PT.
const ctx = { companyId: "cmp_larkspur", now: "2026-11-02T17:00:00.000Z", triggerRef: "cron:2026-11-02T17:00:00.000Z", payload: {} };
const facts = (calls: RunCall[], status: Record<string, string> = {}): RunFacts => ({ calls, proposalStatus: (id) => status[id] ?? null });
const call = (command: string, statusOf: RunCall["status"], data: unknown = null, proposalId: string | null = null, args: unknown = {}): RunCall => ({ command, args, status: statusOf, proposalId, data });

describe("wave 3 parity routine definitions", () => {
  it("every routine is disabled, has at most 8 tools, a registered precheck, known predicates and a scenario", () => {
    expect(routines.map((r) => r.id).sort()).toEqual(["rt_contractor_forms", "rt_exec_briefing", "rt_milestones", "rt_monthly_exec_report", "rt_new_hire_ready", "rt_thirty_day_checkin"]);
    for (const r of routines) {
      expect(r.enabled, r.id).toBe(false);
      expect(r.autonomy, r.id).toBe("approve");
      expect(r.tools.length, r.id).toBeLessThanOrEqual(8);
      expect(new Set(r.tools).size, r.id).toBe(r.tools.length);
      expect(PRECHECKS[r.precheck!], r.id).toBe(prechecks[r.precheck!]);
      for (const c of r.checklist) {
        const name = c.check.split(":")[0]!;
        expect(["posted", ...Object.keys(predicates)], `${r.id} ${c.check}`).toContain(name);
      }
      expect(r.trigger.type).toBe("cron");
      if (r.trigger.type === "cron") expect(new Cron(r.trigger.cron, { timezone: r.trigger.tz }).nextRun(new Date(ctx.now)), r.id).not.toBeNull();
      const file = `${root}scenarios/${r.id}.json`;
      expect(existsSync(file), file).toBe(true);
      const script = JSON.parse(readFileSync(file, "utf8")) as { agents: { main: { output: { type: string; name?: string }[] }[] } };
      for (const step of script.agents.main) for (const o of step.output) if (o.type === "function_call") expect(r.tools, `${r.id} scripts ${o.name}`).toContain(o.name!.replace("__", "."));
      expect(`${r.name} ${r.description} ${r.instructions}`, r.id).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("wave 3 parity prechecks", () => {
  it("every precheck skips when its read fails", async () => {
    for (const [name, p] of Object.entries(prechecks)) expect((await p(ctx, failing)).action, name).toBe("skip");
  });

  it("new_hire_ready skips with no hires, and derives the post and the blocked ids", async () => {
    expect((await prechecks.new_hire_ready!(ctx, exec({ "onboarding.ready_check": { hires: [], window_end: "2026-11-05" } }))).action).toBe("skip");
    const r = await prechecks.new_hire_ready!(ctx, exec({ "onboarding.ready_check": { window_end: "2026-11-05", hires: [
      { worker_id: "wrk_0901", name: "Robin Tester", start_date: "2026-11-02", first_day: true, ready: true, blocked: [] },
      { worker_id: "wrk_0902", name: "Kai Tester", start_date: "2026-11-04", first_day: false, ready: false, blocked: [{ item: "w4", label: "federal W-4", owner: "the hire" }] },
    ] } }));
    expect(r).toMatchObject({ action: "run", severity: "interrupt", derivedArgs: { as_of: "2026-11-02", blocked_count: 1, "onboarding.flag_not_ready": { worker_ids: ["wrk_0902"], as_of: "2026-11-02" } } });
    const text = (r as { derivedArgs: Record<string, { text: string }> }).derivedArgs["comms.send_message"]!.text;
    expect(text).toBe("First day today: please welcome Robin Tester! Accounts, laptop, pay and paperwork are all set.\nNot ready yet: Kai Tester starts 2026-11-04. Blocking: federal W-4 (the hire).");
  });

  it("an all-ready window is a digest, not an interrupt", async () => {
    const r = await prechecks.new_hire_ready!(ctx, exec({ "onboarding.ready_check": { window_end: "2026-11-05", hires: [{ worker_id: "wrk_0901", name: "R", start_date: "2026-11-04", first_day: false, ready: true, blocked: [] }] } }));
    expect(r).toMatchObject({ action: "run", severity: "digest", derivedArgs: { blocked_count: 0, "onboarding.flag_not_ready": { worker_ids: [] } } });
  });

  it("the report prechecks pass only kind, month and as_of to the write", async () => {
    const ex = exec({ "reports.exec_figures": { month: "2026-10", headcount: 48, cost: { total_cost_cents: 123 } } });
    const m = await prechecks.monthly_exec_report!(ctx, ex);
    expect((m as { derivedArgs: Record<string, unknown> }).derivedArgs["comms.send_exec_report"]).toEqual({ kind: "monthly", month: "2026-10", as_of: "2026-11-02" });
    const w = await prechecks.exec_briefing!(ctx, ex);
    expect((w as { derivedArgs: Record<string, unknown> }).derivedArgs["comms.send_exec_report"]).toEqual({ kind: "weekly", month: "2026-10", as_of: "2026-11-02" });
    expect(ex.seen.map((s) => s.args)).toEqual([{ kind: "monthly", as_of: "2026-11-02" }, { kind: "weekly", as_of: "2026-11-02" }]);
  });

  it("milestones post only today's, and the findings never carry a date of birth", async () => {
    const r = await prechecks.milestones!(ctx, exec({ "people.list_milestones": { milestones: [
      { kind: "birthday", worker_id: "wrk_0002", name: "B", on: "2026-11-02", years: null },
      { kind: "work_anniversary", worker_id: "wrk_0003", name: "C", on: "2026-11-02", years: 1 },
      { kind: "work_anniversary", worker_id: "wrk_0004", name: "D", on: "2026-11-03", years: 3 },
    ] } }));
    const d = r as { findings: unknown; derivedArgs: Record<string, { text: string }> };
    expect(d.derivedArgs["comms.send_message"]!.text).toBe("Milestones today: Happy birthday, B! Happy first work anniversary, C!");
    expect((d.findings as { milestones: Record<string, unknown>[] }).milestones).toEqual([{ kind: "birthday", worker_id: "wrk_0002", years: null }, { kind: "work_anniversary", worker_id: "wrk_0003", years: 1 }]);
    expect((await prechecks.milestones!(ctx, exec({ "people.list_milestones": { milestones: [] } }))).action).toBe("skip");
  });

  it("contractor_forms derives the ids that need a request and skips when none do", async () => {
    expect((await prechecks.contractor_forms!(ctx, exec({ "contractors.list_tax_forms": { contractors: [{ worker_id: "wrk_0049", state: "valid" }], needs_request: [] } }))).action).toBe("skip");
    const r = await prechecks.contractor_forms!(ctx, exec({ "contractors.list_tax_forms": { contractors: [{ worker_id: "wrk_0049", state: "valid" }, { worker_id: "wrk_0051", state: "missing", form: null, expires_on: null }], needs_request: ["wrk_0051"] } }));
    expect(r).toMatchObject({ action: "run", subjectRefs: ["wrk_0051"], derivedArgs: { request_count: 1, "contractors.request_tax_forms": { worker_ids: ["wrk_0051"], as_of: "2026-11-02" } } });
  });

  it("thirty_day_checkin derives sends and nudges and never reads answers", async () => {
    expect((await prechecks.thirty_day_checkin!(ctx, exec({ "onboarding.list_checkins": { to_send: [], to_nudge: [] } }))).action).toBe("skip");
    const r = await prechecks.thirty_day_checkin!(ctx, exec({ "onboarding.list_checkins": { to_send: [{ worker_id: "wrk_0961", due_on: "2026-11-02" }], to_nudge: [{ worker_id: "wrk_0950", checkin_id: "chk_0004" }] } }));
    expect(r).toMatchObject({ action: "run", derivedArgs: { send_count: 1, nudge_count: 1, "onboarding.send_checkins": { send: ["wrk_0961"], nudge: ["chk_0004"], as_of: "2026-11-02" } } });
  });
});

describe("wave 3 parity predicates", () => {
  it("a count of zero passes without a call", () => {
    expect(predicates.flagged_not_ready!(["0"], facts([]), null as never)).toBe(true);
    expect(predicates.tax_forms_requested!(["0"], facts([]), null as never)).toBe(true);
    expect(predicates.checkins_sent!(["0", "0"], facts([]), null as never)).toBe(true);
  });

  it("done calls must cover the count; refused calls never pass", () => {
    expect(predicates.flagged_not_ready!(["2"], facts([call("onboarding__flag_not_ready", "done", { flagged: [{ suggestion_id: "prp_1" }, { suggestion_id: null }] })]), null as never)).toBe(false);
    expect(predicates.flagged_not_ready!(["1"], facts([call("onboarding__flag_not_ready", "done", { flagged: [{ suggestion_id: "prp_1" }] })]), null as never)).toBe(true);
    expect(predicates.tax_forms_requested!(["2"], facts([call("contractors.request_tax_forms", "done", { requested: [{}, {}] })]), null as never)).toBe(true);
    expect(predicates.tax_forms_requested!(["1"], facts([call("contractors.request_tax_forms", "refused")]), null as never)).toBe(false);
    expect(predicates.checkins_sent!(["1", "1"], facts([call("onboarding.send_checkins", "done", { sent: [{}], nudged: [] })]), null as never)).toBe(false);
    expect(predicates.checkins_sent!(["1", "1"], facts([call("onboarding.send_checkins", "done", { sent: [{}], nudged: [{}] })]), null as never)).toBe(true);
  });

  it("a pending call passes while its proposal is live and fails once it is denied", () => {
    const pending = [call("contractors.request_tax_forms", "pending_approval", null, "prp_9")];
    expect(predicates.tax_forms_requested!(["1"], facts(pending), null as never)).toBe(true);
    expect(predicates.tax_forms_requested!(["1"], facts(pending, { prp_9: "denied" }), null as never)).toBe(false);
    const report = [call("comms.send_exec_report", "pending_approval", null, "prp_8", { kind: "monthly", month: "2026-10" })];
    expect(predicates.exec_report_sent!(["monthly", "2026-10"], facts(report), null as never)).toBe(true);
    expect(predicates.exec_report_sent!(["weekly", "2026-10"], facts(report), null as never)).toBe(false);
    expect(predicates.exec_report_sent!(["monthly", "2026-10"], facts(report, { prp_8: "expired" }), null as never)).toBe(false);
  });
});
