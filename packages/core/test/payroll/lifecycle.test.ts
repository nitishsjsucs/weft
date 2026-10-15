// Pay run lifecycle, anomalies, totals and subject hash over the local fixture world (SPEC 5.5, 7.4, 7.5).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { TOTALS_FIELDS, type BankSim, type Flag } from "@weft/contracts";
import { bankAccounts, paychecks, payrollRuns, ytdLedger, type Db } from "@weft/db";
import { idMinter } from "../../src/shared/ids";
import {
  assertTotalsIdentities, computeTotals, createDraft, markProcessed, prePayrollPrecheck, previewRun, rowAmounts, runSubjectHash,
  seedPayHistory, submitRun, totalsFromDto, PayrollRefusal,
} from "../../src/payroll/index";
import { buildFixtureWorld, CO, openTempDb, PS, TS, type FixtureIds } from "./fixture-world";

export function fakeBank() {
  const batches: { id: string; payrollRunId: string; total: number; entries: { workerId: string; amountCents: number; accountRef: string }[]; settleAt: string; status: string }[] = [];
  const bank: Pick<BankSim, "submitBatch" | "tick"> = {
    async submitBatch(req) {
      const id = `simb_${String(batches.length + 1).padStart(4, "0")}`;
      batches.push({ id, payrollRunId: req.payrollRunId, total: req.entries.reduce((s, e) => s + e.amountCents, 0), entries: req.entries, settleAt: req.settleAt, status: "submitted" });
      return { batchId: id, settleAt: req.settleAt };
    },
    async tick(now) {
      const out = [];
      for (const b of batches) if (b.status === "submitted" && b.settleAt <= now) { b.status = "settled"; out.push({ type: "sim.bank_batch_settled" as const, subjectRef: b.payrollRunId, payload: { batch_id: b.id, payroll_run_id: b.payrollRunId } }); }
      return out;
    },
  };
  return { bank, batches };
}

async function seeded(): Promise<{ db: Db; ids: FixtureIds; bank: ReturnType<typeof fakeBank>; close(): Promise<void> }> {
  const t = await openTempDb();
  const ids = await buildFixtureWorld(t.db);
  const bank = fakeBank();
  await seedPayHistory(t.db, { newId: idMinter(t.db), bank: bank.bank, credential: "test", approvedBy: "usr_theo", draftCreatedAt: TS }, { companyId: CO, payScheduleId: PS });
  return { db: t.db, ids, bank, close: t.close };
}

let w: Awaited<ReturnType<typeof seeded>>;
beforeAll(async () => { w = await seeded(); });
afterAll(async () => { await w.close(); });

const runRows = async (id: string) => w.db.select().from(paychecks).where(eq(paychecks.payrollRunId, id));
const flagsOf = (p: { flagsJson: string }) => JSON.parse(p.flagsJson) as Flag[];

describe("seeded pay history (SPEC 5.5)", () => {
  it("has processed runs of 45, 45 and 47 paychecks with settled batches", async () => {
    for (const [id, n] of [["pay_2026_09_15", 45], ["pay_2026_09_30", 45], ["pay_2026_10_15", 47]] as const) {
      const run = (await w.db.select().from(payrollRuns).where(eq(payrollRuns.id, id)))[0]!;
      expect(run.status, id).toBe("processed");
      expect(run.bankBatchId).toMatch(/^simb_/);
      const rows = await runRows(id);
      expect(rows).toHaveLength(n);
      expect(rows.every((p) => p.status === "processed")).toBe(true);
    }
    expect(w.bank.batches.map((b) => b.status)).toEqual(["settled", "settled", "settled"]);
    const prev = (await w.db.select().from(payrollRuns).where(eq(payrollRuns.id, "pay_2026_09_30")))[0]!;
    expect(prev.previousRunId).toBe("pay_2026_09_15");
  });

  it("opens the draft pay_2026_10_30 with exactly 4 Needs Review rows (the planted workers) and 44 Ready", async () => {
    const run = (await w.db.select().from(payrollRuns).where(eq(payrollRuns.id, "pay_2026_10_30")))[0]!;
    expect(run).toMatchObject({ status: "draft", periodStart: "2026-10-16", periodEnd: "2026-10-31", payday: "2026-10-30", approvalDeadline: "2026-10-29T00:00:00.000Z", previousRunId: "pay_2026_10_15", taxDataVersion: "2026.1" });
    const rows = await runRows("pay_2026_10_30");
    expect(rows).toHaveLength(48);
    const review = rows.filter((p) => p.reviewGroup === "needs_review").map((p) => p.workerId).sort();
    expect(review).toEqual([w.ids.nyRaise, w.ids.txSpike, w.ids.caOct19, w.ids.nyOffboard].sort());
    expect(rows.filter((p) => p.reviewGroup === "ready")).toHaveLength(44);
    const rules = (id: string) => flagsOf(rows.find((p) => p.workerId === id)!).map((f) => f.rule).sort();
    expect(rules(w.ids.nyRaise)).toEqual(["GROSS_CHANGE"]);
    expect(rules(w.ids.txSpike)).toEqual(["GROSS_CHANGE", "HOURS_SPIKE"]);
    expect(rules(w.ids.caOct19)).toEqual(["MISSING_BANK_ACCOUNT", "NEW_IN_RUN", "PRORATED"]);
    expect(rules(w.ids.nyOffboard)).toEqual(["GROSS_CHANGE", "PRORATED"]);
    expect(rows.find((p) => p.workerId === w.ids.caOct19)!.status).toBe("blocked");
    expect(rows.filter((p) => p.status === "blocked")).toHaveLength(1);
    for (const id of w.ids.caOct1) expect(flagsOf(rows.find((p) => p.workerId === id)!)).toEqual([]);
    expect(JSON.parse(run.anomalySummaryJson!)).toMatchObject({ needsReview: 4, ready: 44, blocked: 1, excluded: 0 });
  });

  it("GROSS_CHANGE evidence for the NY raise carries the prt_ id, the action seq and the action's result id", async () => {
    const rows = await runRows("pay_2026_10_30");
    const f = flagsOf(rows.find((p) => p.workerId === w.ids.nyRaise)!).find((x) => x.rule === "GROSS_CHANGE")!;
    expect(f.evidence).toMatchObject({ pay_rate_id: "prt_0049", created_action_seq: 1, action_result_id: "prt_0049", previous_run_id: "pay_2026_10_15", change_pct: "18.0" });
    expect(f.evidence.previous_gross_cents).toBe(500000);
    expect(f.evidence.gross_cents).toBe(590000);
    const off = flagsOf(rows.find((p) => p.workerId === w.ids.nyOffboard)!).find((x) => x.rule === "GROSS_CHANGE")!;
    expect(off.evidence).toMatchObject({ pay_rate_id: null, created_action_seq: null, action_result_id: null, worked_days: 6, period_days: 11 });
    const spike = flagsOf(rows.find((p) => p.workerId === w.ids.txSpike)!);
    expect(spike.find((x) => x.rule === "HOURS_SPIKE")!.evidence).toMatchObject({ hours_x100: 12000, average_hours_x100: 8667, runs_compared: 3 });
  });

  it("holds the totals identities on every seeded run, stored and recomputed", async () => {
    for (const id of ["pay_2026_09_15", "pay_2026_09_30", "pay_2026_10_15", "pay_2026_10_30"]) {
      const run = (await w.db.select().from(payrollRuns).where(eq(payrollRuns.id, id)))[0]!;
      const stored = totalsFromDto(run.totalsJson)!;
      const recomputed = computeTotals((await runRows(id)).map(rowAmounts));
      expect(stored, id).toEqual(recomputed);
      assertTotalsIdentities(stored);
      expect(stored.netPay).toBe(stored.grossPay - stored.workerTaxes - stored.preTaxDeductions - stored.postTaxDeductions);
      expect(stored.totalCost).toBe(stored.grossPay + stored.reimbursements + stored.employerTaxes + stored.employerBenefitContributions + stored.transactionFees);
      expect(stored.cashRequirement).toBe(stored.totalCost);
      expect(Object.keys(JSON.parse(run.totalsJson!)).sort()).toEqual([...TOTALS_FIELDS].sort());
      expect(stored.grossPay).toBeGreaterThan(0);
    }
    for (const b of w.bank.batches) {
      const t = totalsFromDto((await w.db.select().from(payrollRuns).where(eq(payrollRuns.id, b.payrollRunId)))[0]!.totalsJson)!;
      expect(b.total).toBe(t.netPay + t.reimbursements);
    }
  });

  it("writes opening YTD from the start date only and YTD rows per processed run", async () => {
    const imp = await w.db.select().from(ytdLedger).where(eq(ytdLedger.source, "import"));
    const hasImport = new Set(imp.map((r) => r.workerId));
    for (const id of [...w.ids.caOct1, w.ids.caOct19]) expect(hasImport.has(id)).toBe(false);
    expect(hasImport.size).toBe(45);
    const sep15 = await w.db.select().from(ytdLedger).where(eq(ytdLedger.source, "payroll:pay_2026_09_15"));
    expect(new Set(sep15.map((r) => r.workerId)).size).toBe(45);
    // CA SUI wages never exceed the $7,000 base across sources.
    const sui = [...imp, ...sep15].filter((r) => r.code === "sui_wages:CA");
    const perWorker = new Map<string, number>();
    for (const r of sui) perWorker.set(r.workerId, (perWorker.get(r.workerId) ?? 0) + r.amountCents);
    for (const v of perWorker.values()) expect(v).toBeLessThanOrEqual(700000);
  });
});

describe("draft, preview, submit and processed", () => {
  it("creates the Nov 1 to 15 draft while pay_2026_10_30 is still a draft", async () => {
    const run = await createDraft(w.db, { newId: idMinter(w.db), now: TS }, { companyId: CO, payScheduleId: PS, periodEnd: "2026-11-15" });
    expect(run).toMatchObject({ id: "pay_2026_11_13", status: "draft", previousRunId: "pay_2026_10_15", payday: "2026-11-13" });
    expect(await runRows(run.id)).toHaveLength(47);   // the NY offboarder ended Oct 23
    await expect(createDraft(w.db, { newId: idMinter(w.db), now: TS }, { companyId: CO, payScheduleId: PS, periodEnd: "2026-11-15" })).rejects.toThrow(/already exists/);
  });

  it("preview keeps paycheck ids and the subject hash when nothing changed", async () => {
    const before = (await runRows("pay_2026_10_30")).map((p) => p.id).sort();
    const h1 = (await runSubjectHash(w.db, "pay_2026_10_30", true)).hash;
    await previewRun(w.db, { newId: idMinter(w.db), now: TS }, "pay_2026_10_30");
    expect((await runRows("pay_2026_10_30")).map((p) => p.id).sort()).toEqual(before);
    expect((await runSubjectHash(w.db, "pay_2026_10_30", true)).hash).toBe(h1);
    const pre = await prePayrollPrecheck(w.db, "pay_2026_10_30");
    expect(pre).toMatchObject({ needsReview: 4, ready: 44, blocked: 1 });
  });

  it("a direct-deposit change changes the subject hash (STALE_SUBJECT material)", async () => {
    const h1 = (await runSubjectHash(w.db, "pay_2026_10_30", true)).hash;
    const victim = w.ids.nyRaise;
    const old = (await w.db.select().from(bankAccounts).where(eq(bankAccounts.workerId, victim)))[0]!;
    await w.db.update(bankAccounts).set({ status: "inactive" }).where(eq(bankAccounts.id, old.id));
    await w.db.insert(bankAccounts).values({ ...old, id: "bnk_9001", accountLast4: "7777" });
    const h2 = (await runSubjectHash(w.db, "pay_2026_10_30", true)).hash;
    expect(h2).not.toBe(h1);
    await w.db.delete(bankAccounts).where(eq(bankAccounts.id, "bnk_9001"));
    await w.db.update(bankAccounts).set({ status: "active" }).where(eq(bankAccounts.id, old.id));
    expect((await runSubjectHash(w.db, "pay_2026_10_30", true)).hash).toBe(h1);
  });

  it("refuses BLOCKED_LINES without exclude_blocked, then submits 47 and settles to processed", async () => {
    const deps = { newId: idMinter(w.db), now: "2026-10-28T16:05:00.000Z" };
    const base = { runId: "pay_2026_10_30", approvedBy: "usr_theo", actionSeq: 2, bank: w.bank.bank, credential: "test" };
    const err = await submitRun(w.db, deps, { ...base, excludeBlocked: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayrollRefusal);
    expect((err as PayrollRefusal).code).toBe("BLOCKED_LINES");
    expect((err as PayrollRefusal).details).toMatchObject({ blockedWorkerIds: [w.ids.caOct19] });
    const { material } = await runSubjectHash(w.db, "pay_2026_10_30", true);
    const res = await submitRun(w.db, deps, { ...base, excludeBlocked: true });
    expect(res).toMatchObject({ includedCount: 47, excludedWorkerIds: [w.ids.caOct19], settleAt: "2026-10-30T13:00:00.000Z" });
    expect(res.moneyCents).toBe(material.totals.totalCost);
    expect(res.bankTotalCents).toBe(res.totals.netPay + res.totals.reimbursements);
    const run = (await w.db.select().from(payrollRuns).where(eq(payrollRuns.id, "pay_2026_10_30")))[0]!;
    expect(run).toMatchObject({ status: "processing", approvedBy: "usr_theo", submittedActionSeq: 2, bankBatchId: res.batchId });
    expect(JSON.parse(run.excludedWorkerIdsJson)).toEqual([w.ids.caOct19]);
    expect(totalsFromDto(run.totalsJson)).toEqual(res.totals);
    const rows = await runRows("pay_2026_10_30");
    expect(rows.filter((p) => p.status === "processing")).toHaveLength(47);
    expect(rows.find((p) => p.workerId === w.ids.caOct19)!.status).toBe("excluded");

    expect(await w.bank.bank.tick("2026-10-30T12:59:59.000Z")).toEqual([]);
    const settled = await w.bank.bank.tick("2026-10-30T13:00:00.000Z");
    expect(settled).toHaveLength(1);
    const done = await markProcessed(w.db, { now: "2026-10-30T13:00:00.000Z" }, { runId: "pay_2026_10_30", batchId: res.batchId });
    expect(done.paychecks).toBe(47);
    const after = (await w.db.select().from(payrollRuns).where(eq(payrollRuns.id, "pay_2026_10_30")))[0]!;
    expect(after.status).toBe("processed");
    const ytd = await w.db.select().from(ytdLedger).where(eq(ytdLedger.source, "payroll:pay_2026_10_30"));
    expect(new Set(ytd.map((r) => r.workerId)).size).toBe(47);
    expect((await markProcessed(w.db, { now: TS }, { runId: "pay_2026_10_30" })).paychecks).toBe(0);   // idempotent
  });

  it.todo("mark_failed on a returned batch entry marks that paycheck failed (cut line: fault path)");
});

describe("determinism", () => {
  it("two seeds give identical payroll rows", async () => {
    const dump = async (db: Db) => JSON.stringify({
      runs: await db.select().from(payrollRuns).orderBy(payrollRuns.id),
      checks: await db.select().from(paychecks).orderBy(paychecks.id),
      ytd: (await db.select().from(ytdLedger)).sort((a, b) => `${a.workerId}${a.code}${a.source}`.localeCompare(`${b.workerId}${b.code}${b.source}`)),
    });
    const a = await seeded();
    const b = await seeded();
    try { expect(await dump(a.db)).toBe(await dump(b.db)); } finally { await a.close(); await b.close(); }
  });
});
