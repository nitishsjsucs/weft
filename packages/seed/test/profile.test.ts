// The seed profiles: base is exactly seedWorld() (its digest is what tests, e2e and the eval worlds pin), rich is a
// deterministic layer on top whose action chain still verifies.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closeDb, migrate, openDb, type Db } from "@weft/db";
import { commands, createSimClock, expenses as policy } from "@weft/core";
import { createExecutor } from "@weft/executor";
import { createSimulators } from "@weft/sim";
import { digestDb, SEED_CLOCK, seedWorld } from "../src/index";
import { parseSeedProfile, seedWorldProfile, type SeedProfile } from "../src/profile";

async function seeded<T>(profile: SeedProfile | "world", read: (db: Db, verify: () => Promise<{ ok: boolean; gitLag: number }>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "weft-profile-"));
  const db = openDb({ dataDir: dir });
  try {
    await migrate(db);
    const clock = await createSimClock({ db, initial: { at: SEED_CLOCK, rate: 0 } });
    const executor = await createExecutor({ db, clock, dataDir: dir, commands, simulators: createSimulators, testMode: true });
    try {
      const target = { db, clock, executor, sims: createSimulators({ db, clock }), dataDir: dir };
      if (profile === "world") await seedWorld(target); else await seedWorldProfile(target, profile);
      expect(clock.now()).toBe(SEED_CLOCK);
      return await read(db, () => executor.verifyChain());
    } finally { await executor.close(); }
  } finally { await closeDb(db); rmSync(dir, { recursive: true, force: true }); }
}
/** The planted rows the rich layer must leave alone: the four Weft pay runs and their paychecks, YTD, the base
 * expenses, time-off requests and ledger, offers, notices, filings, compliance items and the first action. The one
 * thing the rich layer adds to a planted paycheck is the pre-payroll review's flag explanation (asserted apart). */
async function planted(db: Db): Promise<string> {
  const q = (s: string) => db.all<Record<string, unknown>>(sql.raw(s));
  const own = (rows: Record<string, unknown>[]) => rows.map(({ explanation: _e, explanation_source: _s, explanation_run_id: _r, ...rest }) => rest);
  return JSON.stringify({
    runs: await q(`SELECT * FROM payroll_runs WHERE tax_data_version != 'imported' ORDER BY id`),
    checks: own(await q(`SELECT p.* FROM paychecks p JOIN payroll_runs r ON r.id = p.payroll_run_id WHERE r.tax_data_version != 'imported' ORDER BY p.id`)),
    ytd: await q(`SELECT * FROM ytd_ledger WHERE worker_id <= 'wrk_0051' ORDER BY worker_id, year, code, source`),
    expenses: await q(`SELECT * FROM expenses WHERE id <= 'exp_0014' ORDER BY id`),
    requests: await q(`SELECT * FROM time_off_requests WHERE id <= 'tor_0006' ORDER BY id`),
    ledger: await q(`SELECT * FROM time_off_ledger WHERE id <= 'tol_0138' ORDER BY id`),
    offers: await q(`SELECT * FROM offers WHERE id = 'offr_0001'`),
    notices: await q(`SELECT * FROM notices WHERE id = 'ntc_0001'`),
    filings: await q(`SELECT * FROM filings WHERE id <= 'fil_0013' ORDER BY id`),
    items: await q(`SELECT * FROM compliance_items WHERE id <= 'cal_0052' ORDER BY id`),
    action1: await q(`SELECT * FROM actions WHERE seq = 1`),
    workers: await q(`SELECT * FROM workers WHERE id <= 'wrk_0051' ORDER BY id`),
    recon: await q(`SELECT * FROM benefit_recon_findings WHERE month = '2026-10'`),
  });
}
const count = async (db: Db, table: string) => (await db.all<{ n: number }>(sql.raw(`SELECT COUNT(*) AS n FROM "${table}"`)))[0]!.n;

describe("seed profiles", () => {
  it("parses the profile name and defaults to base", () => {
    expect(parseSeedProfile(undefined)).toBe("base");
    expect(parseSeedProfile("rich")).toBe("rich");
    expect(() => parseSeedProfile("huge")).toThrow(/base, rich/);
  });

  it("base is exactly seedWorld()", async () => {
    expect(await seeded("base", (db) => digestDb(db))).toBe(await seeded("world", (db) => digestDb(db)));
  }, 60_000);

  it("rich is deterministic, fills history and keeps the action chain valid", async () => {
    const a = await seeded("rich", async (db, verify) => {
      const chain = await verify();
      expect(chain.ok).toBe(true);
      expect(chain.gitLag).toBe(0);
      expect(await count(db, "agent_runs")).toBeGreaterThanOrEqual(20);
      expect(await count(db, "actions")).toBeGreaterThanOrEqual(100);
      expect(await count(db, "routine_runs")).toBeGreaterThanOrEqual(15);
      expect(await count(db, "time_off_requests")).toBeGreaterThanOrEqual(120);
      expect(await count(db, "offboarding_cases")).toBe(8);
      // Every 2026 departure the reports count is an inactive worker with a completed offboarding case and imported pay.
      const leavers = await db.all<{ id: string; end_date: string; cases: number; checks: number; ytd: number }>(sql`SELECT w.id, w.end_date,
          (SELECT COUNT(*) FROM offboarding_cases c WHERE c.worker_id = w.id AND c.status = 'complete') AS cases,
          (SELECT COUNT(*) FROM paychecks p JOIN payroll_runs r ON r.id = p.payroll_run_id WHERE p.worker_id = w.id AND r.tax_data_version = 'imported') AS checks,
          (SELECT COUNT(*) FROM ytd_ledger y WHERE y.worker_id = w.id AND y.source = 'import') AS ytd
        FROM workers w WHERE w.type = 'employee' AND w.end_date BETWEEN '2026-01-01' AND '2026-08-31' ORDER BY w.id`);
      expect(leavers.length).toBe(7);
      for (const l of leavers) { expect(l.cases).toBe(1); expect(l.checks).toBeGreaterThan(0); expect(l.ytd).toBeGreaterThan(0); }
      // 2026 hires before October exist, so the hiring chart is not flat.
      const hires = await db.all<{ m: string }>(sql`SELECT DISTINCT substr(start_date, 1, 7) AS m FROM workers WHERE type = 'employee' AND start_date BETWEEN '2026-01-01' AND '2026-09-30'`);
      expect(hires.length).toBeGreaterThanOrEqual(4);
      // Paid claims ride the imported runs: outside gross and net, inside the run totals.
      const reimb = await db.all<{ run: string; total: number; checks: number }>(sql`SELECT r.id AS run, json_extract(r.totals_json, '$.reimbursements.amount') AS total,
          (SELECT COALESCE(SUM(p.reimbursements_cents), 0) FROM paychecks p WHERE p.payroll_run_id = r.id) AS checks FROM payroll_runs r WHERE r.tax_data_version = 'imported'`);
      expect(reimb.reduce((a, r) => a + r.total, 0)).toBeGreaterThan(0);
      for (const r of reimb) expect(r.total).toBe(r.checks);
      const totals = await db.all<{ t: string }>(sql`SELECT totals_json AS t FROM payroll_runs WHERE tax_data_version = 'imported'`);
      for (const { t } of totals) {
        const x = JSON.parse(t) as Record<string, { amount: number }>;
        expect(x.totalCost!.amount).toBe(x.grossPay!.amount + x.reimbursements!.amount + x.employerTaxes!.amount + x.employerBenefitContributions!.amount + x.transactionFees!.amount);
        expect(x.netPay!.amount).toBe(x.grossPay!.amount - x.workerTaxes!.amount - x.preTaxDeductions!.amount - x.postTaxDeductions!.amount);
        expect(x.cashRequirement!.amount).toBe(x.totalCost!.amount);
      }
      const unlinked = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM expenses WHERE status = 'paid' AND payroll_run_id IS NULL`);
      expect(unlinked[0]!.n).toBe(0);
      expect(await count(db, "contractor_payments")).toBeGreaterThanOrEqual(25);   // monthly from January, with the pay history
      expect(await count(db, "payroll_runs")).toBe(20);
      expect((await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM time_off_requests WHERE status = 'pending'`))[0]!.n).toBe(3);
      expect((await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM expenses WHERE status = 'needs_review'`))[0]!.n).toBe(8);
      // The imported pay history adds up to the imported year-to-date gross, worker by worker.
      const off = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM ytd_ledger y WHERE y.code = 'gross' AND y.source = 'import' AND y.amount_cents !=
        (SELECT COALESCE(SUM(p.gross_cents), 0) FROM paychecks p JOIN payroll_runs r ON r.id = p.payroll_run_id WHERE r.tax_data_version = 'imported' AND p.worker_id = y.worker_id)`);
      expect(off[0]!.n).toBe(0);
      // Every month with pay runs carries employer benefits, and contractor payouts never start before the pay history.
      const months = await db.all<{ m: string; b: number }>(sql`SELECT substr(payday, 1, 7) AS m, SUM(json_extract(totals_json, '$.employerBenefitContributions.amount')) AS b
        FROM payroll_runs WHERE status IN ('processing', 'processed') GROUP BY m`);
      expect(months.length).toBeGreaterThanOrEqual(9);
      for (const m of months) expect(m.b, m.m).toBeGreaterThan(0);
      const early = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM contractor_payments WHERE scheduled_for < '2026-01-01'`);
      expect(early[0]!.n).toBe(0);
      // Paid mileage is the IRS rate on the drive's date, and stored checks are the policy engine's own codes.
      const miles = await db.all<{ id: string; d: string; m: number; c: number }>(sql`SELECT id, transaction_date AS d, miles_x10 AS m, amount_cents AS c FROM expenses WHERE category = 'mileage' AND status = 'paid'`);
      expect(miles.length).toBeGreaterThan(0);
      for (const x of miles) expect(x.c, x.id).toBe(policy.mileageCents(x.m, policy.mileageRateX10(x.d)!));
      const codes = await db.all<{ rule: string }>(sql`SELECT DISTINCT json_extract(j.value, '$.rule') AS rule FROM expenses e, json_each(e.checks_json) j`);
      for (const c of codes) expect(c.rule).not.toBe("OVER_ACCOUNTABLE_WINDOW");
      // The four flagged paychecks on the Oct 30 draft carry the review's explanation.
      const flagged = await db.all<{ e: string | null }>(sql`SELECT explanation AS e FROM paychecks WHERE payroll_run_id = 'pay_2026_10_30' AND flags_json != '[]'`);
      expect(flagged.length).toBeGreaterThanOrEqual(4);
      for (const f of flagged) expect(f.e).toBeTruthy();
      // Each explanation is the agent's, one line per flag, with no row ids or ISO dates, and it never contradicts the
      // worker's rows: no "complete" onboarding while a task is open, no raise without a new pay rate, and the blocked
      // paycheck is left out by the pending submit, not already excluded.
      const notes = await db.all<{ w: string; e: string; s: string; f: string; open: number }>(sql`SELECT p.worker_id AS w, p.explanation AS e, p.explanation_source AS s, p.flags_json AS f,
        (SELECT COUNT(*) FROM onboarding_tasks t WHERE t.worker_id = p.worker_id AND t.status != 'done') AS open FROM paychecks p WHERE p.payroll_run_id = 'pay_2026_10_30' AND p.flags_json != '[]'`);
      for (const n of notes) {
        const flags = JSON.parse(n.f) as { rule: string; evidence: Record<string, unknown> }[];
        expect(n.s, n.w).toBe("agent");
        expect(n.e.split("\n"), n.w).toHaveLength(flags.length);
        expect(n.e, n.w).not.toMatch(/\b[a-z]{2,4}_\d{4}\b|\d{4}-\d{2}-\d{2}|\b[A-Z]+_[A-Z_]+\b/);
        if (n.open > 0) expect(n.e, n.w).not.toMatch(/complete/i);
        if (!flags.some((f) => f.evidence.pay_rate_id)) expect(n.e, n.w).not.toMatch(/raise/i);
        expect(n.e, n.w).not.toMatch(/\bis excluded\b/i);
        expect(new Set(n.e.split(/(?<=\.)\s+/)).size, n.w).toBe(n.e.split(/(?<=\.)\s+/).length);
      }
      expect(notes.find((n) => n.w === "wrk_0022")?.e).toMatch(/direct deposit, the I-9 and benefits selection are still open/);
      const submit = await db.all<{ h: string; d: string }>(sql`SELECT headline AS h, diff_json AS d FROM proposals WHERE command = 'payroll.submit_run' AND status = 'pending'`);
      expect(submit.map((x) => x.h)).toEqual(["Submit the Oct 16 to Oct 31 payroll (payday Oct 30)"]);
      expect(submit[0]!.d).not.toMatch(/wrk_\d{4}/);
      // Approved and taken time off has one use row per requested day, as time_off.decide writes them.
      const gaps = await db.all<{ id: string }>(sql`SELECT r.id FROM time_off_requests r WHERE r.status IN ('approved', 'taken') AND r.id > 'tor_0006'
        AND (SELECT COUNT(*) FROM time_off_ledger l WHERE l.source_ref = r.id AND l.kind = 'use') != json_array_length(r.days_json)`);
      expect(gaps).toEqual([]);
      // The favorites in the routine gallery have run history.
      for (const id of ["rt_new_hire_ready", "rt_monthly_exec_report", "rt_people_digest", "rt_pre_payroll", "rt_milestones"]) {
        const n = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM routine_runs WHERE routine_id = ${id}`);
        expect(n[0]!.n, id).toBeGreaterThan(0);
      }
      return { digest: await digestDb(db), planted: await planted(db) };
    });
    // Planted rows stay exactly as the base seed wrote them.
    expect(a.planted).toBe(await seeded("base", (db) => planted(db)));
    expect(await seeded("rich", (db) => digestDb(db))).toBe(a.digest);
  }, 120_000);
});
