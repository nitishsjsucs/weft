// The seed profiles: base is exactly seedWorld() (its digest is what tests, e2e and the eval worlds pin), rich is a
// deterministic layer on top whose action chain still verifies.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closeDb, migrate, openDb, type Db } from "@weft/db";
import { commands, createSimClock, expenses as policy, payroll } from "@weft/core";
import { createExecutor } from "@weft/executor";
import { createSimulators } from "@weft/sim";
import { digestDb, SEED_CLOCK, seedWorld } from "../src/index";
import { parseSeedProfile, seedWorldProfile, type SeedProfile } from "../src/profile";
import { cronSlot } from "../src/rich/index";
import { readShowcaseFixture } from "../src/rich/showcase";
import { PREBUILT } from "@weft/routines";

async function seeded<T>(profile: SeedProfile | "world", read: (db: Db, verify: () => Promise<{ ok: boolean; gitLag: number }>, dir: string) => Promise<T>): Promise<T> {
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
      return await read(db, () => executor.verifyChain(), dir);
    } finally { await executor.close(); }
  } finally { await closeDb(db); rmSync(dir, { recursive: true, force: true }); }
}
/** The planted rows the rich layer must leave alone: the four Weft pay runs and their paychecks, YTD, the base
 * expenses, time-off requests and ledger, offers, notices, filings, compliance items and the first action. The one
 * thing the rich layer adds to a planted paycheck is the recorded pre-payroll review's flag explanation (asserted
 * apart). */
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
    // The two planted workers the rich layer offboards, as offboarding.start does: Owen Mercer (status and updated_at)
    // and Jonah Pell, whose open resignation also sets his end date to his last day.
    workers: (await q(`SELECT * FROM workers WHERE id <= 'wrk_0051' ORDER BY id`)).map((w) => (w.first_name === "Owen" && w.last_name === "Mercer" ? { ...w, status: null, updated_at: null }
      : w.id === "wrk_0016" ? { ...w, status: null, end_date: null, updated_at: null } : w)),
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
    const a = await seeded("rich", async (db, verify, dir) => {
      const chain = await verify();
      expect(chain.ok).toBe(true);
      expect(chain.gitLag).toBe(0);
      expect(await count(db, "agent_runs")).toBeGreaterThanOrEqual(20);
      expect(await count(db, "actions")).toBeGreaterThanOrEqual(100);
      expect(await count(db, "routine_runs")).toBeGreaterThanOrEqual(10);
      expect(await count(db, "time_off_requests")).toBeGreaterThanOrEqual(120);
      expect(await count(db, "offboarding_cases")).toBe(9);
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
      // The four flagged paychecks on the Oct 30 draft carry the recorded pre-payroll review's own explanation: written by
      // the model (never the template), saved by that run, and covering every flag on the paycheck.
      const notes = await db.all<{ w: string; e: string | null; s: string | null; f: string; rid: string | null; provider: string | null }>(sql`SELECT p.worker_id AS w, p.explanation AS e,
        p.explanation_source AS s, p.flags_json AS f, a.routine_run_id AS rid, a.provider AS provider
        FROM paychecks p LEFT JOIN agent_runs a ON a.id = p.explanation_run_id WHERE p.payroll_run_id = 'pay_2026_10_30' AND p.review_group = 'needs_review'`);
      expect(notes.length).toBe(4);
      for (const n of notes) {
        expect(n.s, n.w).toBe("agent");
        expect(n.e, n.w).toBeTruthy();
        expect(payroll.uncoveredFlags(n.e!, JSON.parse(n.f) as never), n.w).toEqual([]);
        expect(n.provider, n.w).toBe("openai");
        const [rr] = await db.all<{ r: string }>(sql`SELECT routine_id AS r FROM routine_runs WHERE id = ${n.rid}`);
        expect(rr?.r, n.w).toBe("rt_pre_payroll");
      }
      const submit = await db.all<{ h: string; d: string; m: number | null }>(sql`SELECT headline AS h, diff_json AS d, money_cents AS m FROM proposals WHERE command = 'payroll.submit_run' AND status = 'pending'`);
      expect(submit.map((x) => x.h)).toEqual(["Submit the Oct 16 to Oct 31 payroll (payday Oct 30): 47 paychecks, total cost $267,919.36"]);
      expect(submit[0]!.m).toBe(26_791_936);
      expect(submit[0]!.d).not.toMatch(/wrk_\d{4}/);
      // Every planted proposal carries its command's own risk class, and every submit moves the run's own total.
      const props = await db.all<{ id: string; command: string; args: string; risk: string; m: number | null; h: string; status: string; run: string | null }>(sql`SELECT id, command, args_json AS args, risk, money_cents AS m, headline AS h, status,
        json_extract(args_json, '$.run_id') AS run FROM proposals`);
      for (const p of props) {
        const cmd = commands.find((c) => c.name === p.command)!;
        expect(cmd.risk(cmd.input.parse(JSON.parse(p.args))), `${p.id} ${p.command}`).toBe(p.risk);
      }
      for (const p of props.filter((x) => x.command === "payroll.submit_run" && x.status === "executed")) {
        const [r] = await db.all<{ t: number }>(sql`SELECT json_extract(totals_json, '$.totalCost.amount') AS t FROM payroll_runs WHERE id = ${p.run}`);
        expect(p.m, p.id).toBe(r!.t);
      }
      for (const p of props.filter((x) => x.command === "it.order_device")) expect(p.m, p.id).toBe(189_900);
      // Colorado is not planted: accepting Noor's offer files the registrations, per tax account.
      expect(props.filter((p) => p.command === "tax.register_state_account")).toEqual([]);
      // A subject named in a headline is the worker the arguments point at.
      const names = new Map((await db.all<{ id: string; n: string }>(sql`SELECT id, first_name || ' ' || last_name AS n FROM workers`)).map((x) => [x.id, x.n]));
      for (const p of props) {
        const a = JSON.parse(p.args) as { worker_id?: string; request_id?: string };
        const wid = a.worker_id ?? (a.request_id ? (await db.all<{ w: string }>(sql`SELECT worker_id AS w FROM time_off_requests WHERE id = ${a.request_id}`))[0]?.w : undefined);
        if (a.request_id) expect(wid, p.id).toBeTruthy();
        if (wid) expect(p.h, p.id).toContain(names.get(wid)!);
      }
      // The recorded runs: real ones, on the live model, before the seed time, each finished or waiting for a person.
      const runs = await db.all<{ id: string; trigger: string; provider: string; model: string; status: string; created: string; thread: string | null; summary: string | null; tainted: number }>(sql`SELECT id, trigger,
        provider, model, status, created_at AS created, thread_id AS thread, summary, tainted FROM agent_runs ORDER BY created_at, id`);
      for (const r of runs) {
        expect(r.provider, r.id).toBe("openai");
        expect(r.model, r.id).not.toBe("template");
        expect(["done", "waiting", "refused"], r.id).toContain(r.status);
        expect(r.created <= SEED_CLOCK, r.id).toBe(true);
      }
      // Conversations: every chat run belongs to a thread and stored the person's question, which titles it.
      const chats = runs.filter((r) => r.trigger === "chat");
      expect(chats.length).toBeGreaterThanOrEqual(12);
      expect(new Set(chats.map((r) => r.thread)).size).toBeGreaterThanOrEqual(6);
      for (const c of chats) {
        expect(c.thread, c.id).toMatch(/^thr_[0-9a-f]{20}$/);
        const [ctx] = await db.all<{ t: string }>(sql`SELECT json_extract(result_json, '$.text') AS t FROM run_steps WHERE run_id = ${c.id} AND kind = 'context' ORDER BY n LIMIT 1`);
        expect(ctx?.t, c.id).toMatch(/<request>[^<]+<\/request>/);
      }
      // Grounding refs resolve: every result id an answer cites is a result of that run's own tool calls, or the result
      // of an action on the log that one of them read (the raise's res_0001).
      for (const c of chats) {
        for (const ref of new Set((c.summary ?? "").match(/\bres_\d{4}\b/g) ?? [])) {
          const [own] = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM run_steps WHERE run_id = ${c.id} AND kind = 'tool_call' AND instr(result_json, ${`"resultId":"${ref}"`}) > 0`);
          const [read] = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM actions WHERE result_id = ${ref}
            AND EXISTS (SELECT 1 FROM run_steps WHERE run_id = ${c.id} AND kind = 'tool_call' AND instr(result_json, ${ref}) > 0)`);
          expect(own!.n + read!.n, `${c.id} cites ${ref}`).toBeGreaterThan(0);
        }
      }
      // A tainted run is tainted in the executor's own table too, so no follow-up reads its answer.
      for (const r of runs.filter((x) => x.tainted)) {
        expect((await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM run_taint WHERE run_id = ${r.id} AND tainted = 1`))[0]!.n, r.id).toBe(1);
      }
      // Offloaded artifacts (the charts) have their bodies in the run workspace.
      for (const art of await db.all<{ id: string; path: string; sha: string }>(sql`SELECT id, path, sha256 AS sha FROM run_artifacts`)) {
        const body = readFileSync(join(dir, art.path), "utf8");
        expect(createHash("sha256").update(body).digest("hex"), art.id).toBe(art.sha);
      }
      // The approval cards waiting from the runs: the review's Submit and the chat's off-cycle bonus, each linked to its run.
      const cards = await db.all<{ c: string; run: string | null; t: string | null }>(sql`SELECT p.command AS c, p.proposer_run_id AS run, a.trigger AS t FROM proposals p LEFT JOIN agent_runs a ON a.id = p.proposer_run_id WHERE p.status = 'pending' AND p.kind = 'action'`);
      expect(cards.find((x) => x.c === "payroll.submit_run")?.t).toMatch(/^routine:/);
      expect(cards.find((x) => x.c === "payroll.propose_off_cycle")?.t).toBe("chat");
      for (const x of cards) expect(x.run, x.c).toBeTruthy();
      // The fixture holds no key material.
      expect(JSON.stringify(readShowcaseFixture())).not.toMatch(/\bsk-[A-Za-z0-9_-]{16,}/);
      // Paid claims above the receipt threshold, and lodging, carry their receipt.
      const noReceipt = await db.all<{ id: string }>(sql`SELECT id FROM expenses WHERE status IN ('paid', 'approved') AND category != 'mileage' AND receipt_upload_id IS NULL AND (amount_cents >= 7500 OR category = 'lodging')`);
      expect(noReceipt).toEqual([]);
      // Employee numbers continue the live counter with no gaps or repeats.
      const nums = (await db.all<{ e: string }>(sql`SELECT employee_number AS e FROM workers WHERE employee_number IS NOT NULL ORDER BY employee_number`)).map((x) => x.e);
      expect(nums).toEqual(nums.map((_, i) => `EMP-${String(i + 1).padStart(4, "0")}`));
      // Approved and taken time off has one use row per requested day, as time_off.decide writes them.
      const gaps = await db.all<{ id: string }>(sql`SELECT r.id FROM time_off_requests r WHERE r.status IN ('approved', 'taken') AND r.id > 'tor_0006'
        AND (SELECT COUNT(*) FROM time_off_ledger l WHERE l.source_ref = r.id AND l.kind = 'use') != json_array_length(r.days_json)`);
      expect(gaps).toEqual([]);
      // The routines the rich crawl opens, and the ones the world needs, have run history.
      for (const id of ["rt_new_hire_ready", "rt_monthly_exec_report", "rt_people_digest", "rt_pre_payroll", "rt_time_off_requests", "rt_compliance_reminders", "rt_onboarding_nudge"]) {
        const n = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM routine_runs WHERE routine_id = ${id}`);
        expect(n[0]!.n, id).toBeGreaterThan(0);
      }
      // Round 2 (demo-perfect): the rows a demo reads agree with each other.
      // The open Greenhouse conflict has the engine's detail shape, with both dates, on Marisol's offer.
      const conflict = await db.all<{ s: string; d: string }>(sql`SELECT subject_ref AS s, detail_json AS d FROM sync_items WHERE status = 'open'`);
      expect(conflict).toHaveLength(1);
      expect(JSON.parse(conflict[0]!.d)).toMatchObject({ field: "start_date", label: "Start date", weft_value: "2026-11-16", vendor_value: "2026-11-23", offer_version: "2" });
      expect((await db.all<{ n: string }>(sql`SELECT candidate_first AS n FROM offers WHERE id = ${conflict[0]!.s}`))[0]!.n).toBe("Marisol");
      // A sent offer's letter is the app's own template (no three-line stub), and only accepted offers have a check.
      const letters = await db.all<{ b: string; st: string }>(sql`SELECT d.body_text AS b, o.status AS st FROM documents d JOIN offers o ON o.id = d.offer_id WHERE d.kind = 'offer_letter' AND o.id != 'offr_0001'`);
      expect(letters.length).toBeGreaterThanOrEqual(5);
      for (const l of letters) { expect(l.b, l.st).toMatch(/We are delighted to offer you/); expect(l.b).not.toMatch(/Start date \d{4}/); }
      const checks = await db.all<{ st: string }>(sql`SELECT o.status AS st FROM screening_orders s JOIN offers o ON o.id = s.offer_id`);
      for (const c of checks) expect(c.st).toBe("accepted");
      // Every recorded routine run is either its own cron slot, fired unattended, or a person's Run now, attended.
      const rruns = await db.all<{ r: string; at: string; ref: string; attended: number }>(sql`SELECT routine_id AS r, started_at AS at, trigger_ref AS ref, attended FROM routine_runs`);
      for (const x of rruns) {
        const def = PREBUILT.find((d) => d.id === x.r)!;
        expect(x.at <= SEED_CLOCK, `${x.r} ${x.at}`).toBe(true);
        if (x.ref.startsWith("manual:")) { expect(x.attended, x.r).toBe(1); expect(x.ref.slice(7, 31), x.r).toBe(x.at); continue; }
        expect(def.trigger.type, x.r).toBe("cron");
        const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(x.at));
        expect(x.at, `${x.r} ${x.at}`).toBe(cronSlot(x.r, day, Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" }).format(new Date(x.at)))));
        expect(x.ref, x.r).toBe(`cron:${x.at}`);
        expect(x.attended, x.r).toBe(0);
      }
      // Leavers' enrollments ride their imported paychecks until the end date, then end; employer benefits move with them.
      const rafael = await db.all<{ b: string; d: string }>(sql`SELECT p.benefits_json AS b, r.payday AS d FROM paychecks p JOIN payroll_runs r ON r.id = p.payroll_run_id JOIN workers w ON w.id = p.worker_id WHERE w.first_name = 'Rafael' ORDER BY r.payday`);
      expect(rafael.length).toBeGreaterThan(10);
      for (const r of rafael) expect(JSON.parse(r.b), r.d).toHaveLength(4);
      const ended = await db.all<{ s: string; t: string | null }>(sql`SELECT e.status AS s, e.effective_to AS t FROM benefit_enrollments e JOIN workers w ON w.id = e.worker_id WHERE w.first_name = 'Rafael'`);
      expect(ended).toEqual(Array.from({ length: 4 }, () => ({ s: "terminated", t: "2026-07-31" })));
      const erByMonth = new Set(months.filter((m) => m.m <= "2026-09").map((m) => m.b));
      expect(erByMonth.size).toBeGreaterThan(3);
      // No claim predates its worker's start date unless it is the pre-start equipment stipend.
      const early2 = await db.all<{ id: string; p: string }>(sql`SELECT e.id, e.business_purpose AS p FROM expenses e JOIN workers w ON w.id = e.worker_id WHERE e.transaction_date < w.start_date`);
      for (const e of early2) expect(e.p, e.id).toMatch(/^Pre-start equipment stipend/);
      // Owen Mercer's last day has passed: he is offboarding with an open case whose one open step is final pay.
      const owen = await db.all<{ st: string; c: string; open: number }>(sql`SELECT w.status AS st, c.status AS c, (SELECT COUNT(*) FROM offboarding_steps s WHERE s.case_id = c.id AND s.status != 'done') AS open
        FROM workers w JOIN offboarding_cases c ON c.worker_id = w.id WHERE w.first_name = 'Owen' AND w.last_name = 'Mercer'`);
      expect(owen).toEqual([{ st: "offboarding", c: "open", open: 1 }]);
      // Jonah Pell's open resignation reads the same way everywhere: he is offboarding, with his last day as his end date.
      const jonah = await db.all<{ st: string; end: string | null; c: string }>(sql`SELECT w.status AS st, w.end_date AS end, c.status AS c FROM workers w JOIN offboarding_cases c ON c.worker_id = w.id WHERE w.id = 'wrk_0016'`);
      expect(jonah).toEqual([{ st: "offboarding", end: "2026-11-13", c: "open" }]);
      // Every open offboarding case belongs to a worker whose status says so, so the agent's people reads agree with the
      // Offboarding page.
      const mismatched = await db.all<{ id: string }>(sql`SELECT c.id FROM offboarding_cases c JOIN workers w ON w.id = c.worker_id WHERE c.status = 'open' AND w.status != 'offboarding'`);
      expect(mismatched).toEqual([]);
      // Base channel posts carry the day they talk about, and no two people share a surname and a near first name.
      const welcome = await db.all<{ ts: string }>(sql`SELECT ts FROM sim_chat_messages WHERE text = 'Welcome Ana and Ben to Larkspur!'`);
      expect(welcome[0]!.ts.slice(0, 10)).toBe("2026-10-01");
      expect((await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM workers WHERE last_name = 'Calloway'`))[0]!.n).toBe(1);
      // Step details read as days, never ISO dates.
      const isoSteps = await db.all<{ d: string }>(sql`SELECT detail AS d FROM offboarding_steps WHERE detail GLOB '*[0-9][0-9][0-9][0-9]-[0-9][0-9]*'`);
      expect(isoSteps).toEqual([]);
      return { digest: await digestDb(db), planted: await planted(db) };
    });
    // Planted rows stay exactly as the base seed wrote them.
    expect(a.planted).toBe(await seeded("base", (db) => planted(db)));
    expect(await seeded("rich", (db) => digestDb(db))).toBe(a.digest);
  }, 120_000);
});
