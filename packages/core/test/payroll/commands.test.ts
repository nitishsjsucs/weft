// payroll.* commands through a minimal stand-in for the executor (zod, amountCents, preview, run on the same tx),
// until T3's executor lands. The real pipeline is exercised by tests/scenarios/s2-pre-payroll.test.ts after merge.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { isWeftError, type ExecContext, type SimClock, type Simulators, type WeftEvent } from "@weft/contracts";
import { bankAccounts, employerTaxRates, paychecks, payrollRuns, ytdLedger, type Db } from "@weft/db";
import { idMinter } from "../../src/shared/ids";
import { payrollCommands, submitRunCommand } from "../../src/commands/payroll";
import { payrollHandlers } from "../../src/payroll/handlers";
import { seedPayHistory } from "../../src/payroll/index";
import type { CommandDeps } from "../../src/shared/deps";
import { buildFixtureWorld, CO, fakeBank, openTempDb, PS, TS, type FixtureIds } from "./fixture-world";

// Stand-in for T4's grounding until merge: every number with 3+ digits or a decimal must appear in the evidence,
// with *_cents leaves also accepted as dollars.
vi.mock("@weft/grounding", () => ({
  check(text: string, results: unknown[]) {
    const pool = new Set<string>();
    const walk = (v: unknown, k = "") => {
      if (typeof v === "number") { pool.add(String(v)); if (k.endsWith("_cents")) { pool.add((v / 100).toFixed(2)); pool.add((v / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })); } }
      else if (typeof v === "string") { for (const m of v.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) pool.add(m.replace(/,/g, "")); }
      else if (v && typeof v === "object") for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
    };
    for (const r of results) walk(r);
    const offending = (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((m) => m.replace(/,/g, "")).filter((m) => (m.length > 2 || m.includes(".")) && !pool.has(m) && !/^\d{4}$/.test(m));
    return { ok: offending.length === 0, offending };
  },
}));

let db: Db;
let ids: FixtureIds;
let close: () => Promise<void>;
const bank = fakeBank();
let now = TS;
const clock: SimClock = { now: () => now, rate: () => 0, advance: async (to) => { now = to; }, set: async (to) => { now = to; } };

beforeAll(async () => {
  const t = await openTempDb();
  db = t.db; close = t.close;
  ids = await buildFixtureWorld(db);
  await seedPayHistory(db, { newId: idMinter(db), bank: bank.bank, credential: "vault:sim-bank-operating", approvedBy: "usr_theo", draftCreatedAt: TS }, { companyId: CO, payScheduleId: PS });
});
afterAll(async () => { await close(); });

function deps(): CommandDeps {
  return { tx: db, sims: { bank: bank.bank } as unknown as Simulators, clock, newId: idMinter(db), resolveCredential: async (ref) => `secret-for-${ref}` };
}
function ctx(principal: ExecContext["principal"] = { id: "usr_theo", kind: "human", role: "payroll_admin" }): ExecContext {
  return { companyId: CO, principal, onBehalfOf: null, surface: "human_ui", agentKind: null, run: null, tainted: false, routineRunId: null, approvedProposalId: null, now };
}
const cmd = (name: string) => payrollCommands.find((c) => c.name === name)!;
async function exec(name: string, args: unknown, c = ctx()) {
  const def = cmd(name);
  const input = def.input.parse(args);
  return def.run(input, c, deps());
}
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e) { if (isWeftError(e) && e._tag === "Refused") return { code: String(e.extra.code), message: e.message }; throw e; }
  throw new Error("expected a refusal");
}

describe("registry entries", () => {
  it("declares the SPEC 9.2 risk, approval, tiers and access", () => {
    const by = Object.fromEntries(payrollCommands.map((c) => [c.name, c]));
    expect(Object.keys(by).sort()).toEqual(["payroll.create_draft", "payroll.explain_flags", "payroll.get_run", "payroll.list_runs", "payroll.mark_failed", "payroll.mark_processed", "payroll.preview_run", "payroll.submit_run"]);
    const s = by["payroll.submit_run"]!;
    expect([s.risk({ run_id: "pay_x" }), s.approval, s.ceilingKey, s.autoAllow, s.reversible, s.effect]).toEqual(["R4", "always", "agent.payroll_run_cents", "never", false, "external"]);
    expect(s.errorHints.BLOCKED_LINES?.example).toEqual({ run_id: "pay_2026_10_30", exclude_blocked: true });
    expect(by["payroll.preview_run"]!.afterPending).toBe("skip");
    for (const n of ["payroll.mark_processed", "payroll.mark_failed"]) expect(by[n]).toMatchObject({ access: "system_only", tiers: { main: "unavailable", task: "unavailable" }, mcp: "hidden", approval: "never" });
    for (const c of payrollCommands) {
      expect(c.description.length, c.name).toBeLessThanOrEqual(400);
      if (c.approval !== "never") expect(c.preview, c.name).not.toBeNull();
      if (c.name !== "payroll.submit_run" && c.access === "all") expect(["R0", "R1"]).toContain(c.risk({} as never));
    }
  });
});

describe("reads", () => {
  it("list_runs shows the 3 processed runs and the draft", async () => {
    const out = await exec("payroll.list_runs", {});
    expect((out.data as { runs: { run_id: string; status: string }[] }).runs.map((r) => [r.run_id, r.status])).toEqual([["pay_2026_09_15", "processed"], ["pay_2026_09_30", "processed"], ["pay_2026_10_15", "processed"], ["pay_2026_10_30", "draft"]]);
  });
  it("get_run concise is under 8,000 chars and carries the raise action's result id", async () => {
    const out = await exec("payroll.get_run", { run_id: "pay_2026_10_30" });
    const text = JSON.stringify(out.data);
    expect(text.length).toBeLessThan(8000);
    const d = out.data as { counts: { needs_review: number; ready: number }; flagged: { worker: string; flags: { rule: string; evidence: Record<string, unknown> }[] }[] };
    expect(d.counts).toMatchObject({ needs_review: 4, ready: 44 });
    expect(d.flagged).toHaveLength(4);
    const raise = d.flagged.find((f) => f.worker.includes(ids.nyRaise))!;
    expect(raise.flags[0]!.evidence).toMatchObject({ pay_rate_id: ids.nyRaiseRate, created_action_seq: 1, action_result_id: ids.nyRaiseRate });
    const filtered = await exec("payroll.get_run", { run_id: "pay_2026_10_30", state: "TX" });
    expect((filtered.data as { flagged: unknown[]; ready: unknown[] }).flagged).toHaveLength(1);
    expect((filtered.data as { ready: unknown[] }).ready).toHaveLength(11);
    const one = await exec("payroll.get_run", { run_id: "pay_2026_10_30", worker_id: ids.caOct19, flagged_only: true });
    expect((one.data as { flagged: unknown[] }).flagged).toHaveLength(1);
  });
  it("get_run honors flagged_only in detailed mode: the flagged rows only, never the ready list (round 1 R7)", async () => {
    const all = await exec("payroll.get_run", { run_id: "pay_2026_10_30", response_format: "detailed" });
    expect((all.data as { ready?: unknown[] }).ready).toHaveLength(44);
    const flagged = await exec("payroll.get_run", { run_id: "pay_2026_10_30", response_format: "detailed", flagged_only: true });
    const d = flagged.data as { flagged: unknown[]; ready?: unknown[]; counts: { ready: number } };
    expect(d.flagged).toHaveLength(4);
    expect(d.ready).toBeUndefined();
    // The counts still say how many are ready, so the answer can name them without the rows.
    expect(d.counts.ready).toBe(44);
    const concise = await exec("payroll.get_run", { run_id: "pay_2026_10_30", flagged_only: true });
    expect(JSON.stringify(flagged.data).length).toBe(JSON.stringify(concise.data).length);
    const tx = await exec("payroll.get_run", { run_id: "pay_2026_10_30", response_format: "detailed", flagged_only: true, state: "TX" });
    expect((tx.data as { flagged: unknown[]; ready?: unknown[] }).flagged).toHaveLength(1);
    expect((tx.data as { ready?: unknown[] }).ready).toBeUndefined();
  });
});

describe("drafts and explanations", () => {
  it("create_draft for Nov 1 to 15 succeeds while pay_2026_10_30 is a draft", async () => {
    const out = await exec("payroll.create_draft", { pay_schedule_id: PS, period_end: "2026-11-15" });
    expect(out.data).toMatchObject({ run_id: "pay_2026_11_13", status: "draft", previous_run_id: "pay_2026_10_15" });
    expect(out.events).toEqual([{ type: "payroll.draft_created", subjectRef: "pay_2026_11_13", payload: { payroll_run_id: "pay_2026_11_13" } }]);
    expect((await refusal(exec("payroll.create_draft", { pay_schedule_id: PS, period_end: "2026-11-15" }))).code).toBe("DOMAIN_DRAFT_EXISTS");
    expect((await refusal(exec("payroll.create_draft", { pay_schedule_id: PS, period_end: "2026-11-20" }))).code).toBe("INVALID_INPUT");
  });
  it("preview_run recomputes in place and reports no change when nothing changed", async () => {
    const out = await exec("payroll.preview_run", { run_id: "pay_2026_10_30" });
    expect(out.data).toMatchObject({ run_id: "pay_2026_10_30", changed: 0, unchanged: 48 });
  });
  it("a CA SUI rate change shows in the next preview only for the 3 CA workers under the wage base (GP1)", async () => {
    await db.update(employerTaxRates).set({ supersededActionSeq: 9 }).where(eq(employerTaxRates.id, "etr_0001"));
    await db.insert(employerTaxRates).values({ id: "etr_0101", companyId: CO, jurisdiction: "CA", code: "sui", rate: "0.015", wageBaseCents: 700000, effectiveFrom: "2026-01-01", source: "notice:ntc_0001", createdActionSeq: 9 });
    const out = await exec("payroll.preview_run", { run_id: "pay_2026_10_30" });
    const d = out.data as { changed: number; changes: { worker_id: string; employer_taxes_before_cents: number; employer_taxes_after_cents: number }[] };
    expect(d.changes.map((c) => c.worker_id).sort()).toEqual([...ids.caOct1, ids.caOct19].sort());
    for (const c of d.changes) expect(c.employer_taxes_after_cents).toBeLessThan(c.employer_taxes_before_cents);
    // Undo restores the prior numbers.
    await db.delete(employerTaxRates).where(eq(employerTaxRates.id, "etr_0101"));
    await db.update(employerTaxRates).set({ supersededActionSeq: null }).where(eq(employerTaxRates.id, "etr_0001"));
    const back = await exec("payroll.preview_run", { run_id: "pay_2026_10_30" });
    expect((back.data as { changed: number }).changed).toBe(3);
    expect((await exec("payroll.preview_run", { run_id: "pay_2026_10_30" })).data).toMatchObject({ changed: 0 });
  });
  it("explain_flags saves grounded text, refuses ungrounded per item, then falls back to the labeled template", async () => {
    const rows = await db.select().from(paychecks).where(eq(paychecks.payrollRunId, "pay_2026_10_30"));
    const raise = rows.find((p) => p.workerId === ids.nyRaise)!;
    const spike = rows.find((p) => p.workerId === ids.txSpike)!;
    const first = await exec("payroll.explain_flags", { run_id: "pay_2026_10_30", items: [
      { paycheck_id: raise.id, explanation: "Gross pay rose 18.0% from $5,000.00 to $5,900.00 after the raise to $141,600.00 took effect." },
      { paycheck_id: spike.id, explanation: "Worked 140.00 hours, far above normal." },
    ] });
    const items = (first.data as { items: { paycheck_id: string; status: string; source: string | null; code: string | null; offending: string[] }[] }).items;
    expect(items[0]).toMatchObject({ status: "saved", source: "agent" });
    expect(items[1]).toMatchObject({ status: "refused", source: null, code: "UNGROUNDED" });
    expect(items[1]!.offending).toContain("140.00");
    const second = await exec("payroll.explain_flags", { run_id: "pay_2026_10_30", items: [{ paycheck_id: spike.id, explanation: "Worked 150.00 hours." }] });
    // After the one repair: the text is refused (UNGROUNDED) and the row is saved with the labeled template.
    expect(second.data).toMatchObject({ saved: 1, refused: 0, items: [{ status: "saved", source: "template", code: "UNGROUNDED" }] });
    expect(first.data).toMatchObject({ saved: 1, refused: 1 });
    const after = await db.select().from(paychecks).where(eq(paychecks.payrollRunId, "pay_2026_10_30"));
    expect(after.find((p) => p.id === raise.id)).toMatchObject({ explanationSource: "agent" });
    const s = after.find((p) => p.id === spike.id)!;
    expect(s.explanationSource).toBe("template");
    expect(s.explanation).toContain("120.00 hours");
    const rest = after.filter((p) => p.reviewGroup === "needs_review" && p.explanation === null);
    const third = await exec("payroll.explain_flags", { run_id: "pay_2026_10_30", items: rest.map((p) => ({ paycheck_id: p.id })) });
    expect((third.data as { unexplained_flagged: number }).unexplained_flagged).toBe(0);
  });
});

describe("submit_run", () => {
  it("refuses BLOCKED_LINES without exclude_blocked, from amountCents and preview", async () => {
    const i = submitRunCommand.input.parse({ run_id: "pay_2026_10_30" });
    const r = await refusal(submitRunCommand.amountCents!(i, ctx(), deps()));
    expect(r.code).toBe("BLOCKED_LINES");
    expect(r.message).toContain(ids.caOct19);
    expect((await refusal(submitRunCommand.preview!(i, ctx(), deps()))).code).toBe("BLOCKED_LINES");
  });

  it("gives a different subject hash after a direct-deposit change (STALE_SUBJECT)", async () => {
    const i = submitRunCommand.input.parse({ run_id: "pay_2026_10_30", exclude_blocked: true });
    const p1 = await submitRunCommand.preview!(i, ctx(), deps());
    const old = (await db.select().from(bankAccounts).where(eq(bankAccounts.workerId, ids.nyRaise)))[0]!;
    await db.update(bankAccounts).set({ status: "inactive" }).where(eq(bankAccounts.id, old.id));
    await db.insert(bankAccounts).values({ ...old, id: "bnk_9002", accountLast4: "4242" });
    const p2 = await submitRunCommand.preview!(i, ctx(), deps());
    expect(p2.subjectHash).not.toBe(p1.subjectHash);
    expect(p2.moneyCents).toBe(p1.moneyCents);
    await db.delete(bankAccounts).where(eq(bankAccounts.id, "bnk_9002"));
    await db.update(bankAccounts).set({ status: "active" }).where(eq(bankAccounts.id, old.id));
    expect((await submitRunCommand.preview!(i, ctx(), deps())).subjectHash).toBe(p1.subjectHash);
  });

  it("executes to processing with moneyCents equal to amountCents, then the settle handler processes it", async () => {
    const i = submitRunCommand.input.parse({ run_id: "pay_2026_10_30", exclude_blocked: true });
    const amount = await submitRunCommand.amountCents!(i, ctx(), deps());
    const preview = await submitRunCommand.preview!(i, ctx(), deps());
    expect(preview.moneyCents).toBe(amount);
    expect(preview.title).toContain("47 paychecks");
    const out = await submitRunCommand.run(i, ctx(), deps());
    expect(out.moneyCents).toBe(amount);
    expect(out.data).toMatchObject({ run_id: "pay_2026_10_30", status: "processing", included: 47, excluded_worker_ids: [ids.caOct19], settle_at: "2026-10-30T13:00:00.000Z" });
    expect(out.events).toEqual([{ type: "payroll.submitted", subjectRef: "pay_2026_10_30", payload: { payroll_run_id: "pay_2026_10_30" } }]);
    const batch = bank.batches.find((b) => b.payrollRunId === "pay_2026_10_30")!;
    expect(batch.entries).toHaveLength(47);
    expect(batch.total).toBe((out.data as { bank_total_cents: number }).bank_total_cents);

    // First tick at or after Fri Oct 30 06:00 PT settles; the handler records it as svc_events.
    const evts = await bank.bank.tick("2026-10-30T13:00:00.000Z");
    expect(evts).toHaveLength(1);
    const emitted: { type: string }[] = [];
    const sys = {
      async exec(principal: string, command: string, args: unknown) {
        expect(principal).toBe("svc_events");
        const def = cmd(command);
        const o = await def.run(def.input.parse(args), ctx({ id: principal, kind: "service", role: null }), deps());
        emitted.push(...(o.events ?? []));
        return { ok: true as const, status: "done" as const, resultId: "pay_2026_10_30", data: o.data, summary: o.summary, actionSeq: null, artifactRef: null, tainted: false, label: "synthetic" as const };
      },
    };
    const evt: WeftEvent = { id: "evt_0001", type: evts[0]!.type, ts: "2026-10-30T13:00:00.000Z", subjectRef: evts[0]!.subjectRef, payload: evts[0]!.payload, attended: false, requestedBy: null };
    const handler = payrollHandlers.find((h) => h.event === evt.type)!;
    await handler.handle(evt, sys, {} as never);
    expect(emitted).toEqual([{ type: "payroll.processed", subjectRef: "pay_2026_10_30", payload: { payroll_run_id: "pay_2026_10_30" } }]);
    const run = (await db.select().from(payrollRuns).where(eq(payrollRuns.id, "pay_2026_10_30")))[0]!;
    expect(run.status).toBe("processed");
    const final = await db.select().from(paychecks).where(eq(paychecks.payrollRunId, "pay_2026_10_30"));
    expect(final.filter((p) => p.status === "processed")).toHaveLength(47);
    expect(final.find((p) => p.workerId === ids.caOct19)!.status).toBe("excluded");
    const ytd = await db.select().from(ytdLedger).where(eq(ytdLedger.source, "payroll:pay_2026_10_30"));
    expect(new Set(ytd.map((r) => r.workerId)).size).toBe(47);
    expect(ytd.some((r) => r.workerId === ids.caOct19)).toBe(false);
    expect((await refusal(exec("payroll.submit_run", { run_id: "pay_2026_10_30", exclude_blocked: true }))).code).toBe("DOMAIN_NOT_DRAFT");
  });
});

describe("bank return (fault return in the simulator)", () => {
  it("a returned batch fails the run and its in-flight paychecks, writes no YTD, and is idempotent", async () => {
    const t = await openTempDb();
    const rbank = fakeBank({ returnFirst: true });
    try {
      const fx = await buildFixtureWorld(t.db);
      await seedPayHistory(t.db, { newId: idMinter(t.db), bank: fakeBank().bank, credential: "vault:sim-bank-operating", approvedBy: "usr_theo", draftCreatedAt: TS }, { companyId: CO, payScheduleId: PS });
      const rdeps = (): CommandDeps => ({ tx: t.db, sims: { bank: rbank.bank } as unknown as Simulators, clock, newId: idMinter(t.db), resolveCredential: async (ref) => `secret-for-${ref}` });
      const run = async (name: string, args: unknown, c = ctx()) => { const def = cmd(name); return def.run(def.input.parse(args), c, rdeps()); };
      await run("payroll.submit_run", { run_id: "pay_2026_10_30", exclude_blocked: true });
      const evts = await rbank.bank.tick("2026-10-30T13:00:00.000Z");
      expect(evts.map((e) => e.type)).toEqual(["sim.bank_batch_returned"]);
      const sys = {
        async exec(principal: string, command: string, args: unknown) {
          expect([principal, command]).toEqual(["svc_events", "payroll.mark_failed"]);
          const o = await run(command, args, ctx({ id: principal, kind: "service", role: null }));
          return { ok: true as const, status: "done" as const, resultId: "pay_2026_10_30", data: o.data, summary: o.summary, actionSeq: null, artifactRef: null, tainted: false, label: "synthetic" as const };
        },
      };
      const evt: WeftEvent = { id: "evt_0002", type: evts[0]!.type, ts: "2026-10-30T13:00:00.000Z", subjectRef: evts[0]!.subjectRef, payload: evts[0]!.payload, attended: false, requestedBy: null };
      await payrollHandlers.find((h) => h.event === evt.type)!.handle(evt, sys, {} as never);
      const after = (await t.db.select().from(payrollRuns).where(eq(payrollRuns.id, "pay_2026_10_30")))[0]!;
      expect(after.status).toBe("failed");
      const rows = await t.db.select().from(paychecks).where(eq(paychecks.payrollRunId, "pay_2026_10_30"));
      expect(rows.filter((p) => p.status === "failed")).toHaveLength(47);
      expect(rows.find((p) => p.workerId === fx.caOct19)!.status).toBe("excluded");
      expect(await t.db.select().from(ytdLedger).where(eq(ytdLedger.source, "payroll:pay_2026_10_30"))).toEqual([]);
      const again = await run("payroll.mark_failed", { run_id: "pay_2026_10_30", worker_id: evt.payload.worker_id! }, ctx({ id: "svc_events", kind: "service", role: null }));
      expect(again.data).toMatchObject({ status: "failed", failed: 0 });
      expect((await refusal(run("payroll.mark_processed", { run_id: "pay_2026_10_30" }, ctx({ id: "svc_events", kind: "service", role: null })))).code).toBe("DOMAIN_NOT_PROCESSING");
      expect((await refusal(run("payroll.submit_run", { run_id: "pay_2026_10_30", exclude_blocked: true }))).code).toBe("DOMAIN_NOT_DRAFT");
    } finally { await t.close(); }
  });
});
