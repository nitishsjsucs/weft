// payroll_cost_by_month carries its drivers (docs/evals/round1-analysis.md R4): a "why did payroll cost change" question
// needs who was paid and who joined or left in the same period. The rows now carry workers_paid, hires and departures,
// computed independently here from the paychecks and the worker dates of the fixture world.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Db } from "@weft/db";
import { idMinter } from "../../src/shared/ids";
import { seedPayHistory } from "../../src/payroll/index";
import { runReport } from "../../src/reports/query";
import { rangeTotals } from "../../src/commands/reports";
import { buildFixtureWorld, CO, fakeBank, openTempDb, PS, TS } from "../payroll/fixture-world";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  const t = await openTempDb();
  db = t.db; close = t.close;
  await buildFixtureWorld(db);
  await seedPayHistory(db, { newId: idMinter(db), bank: fakeBank().bank, credential: "vault:sim-bank-operating", approvedBy: "usr_theo", draftCreatedAt: TS }, { companyId: CO, payScheduleId: PS });
});
afterAll(async () => { await close(); });

const q = (from: string, to: string, groupBy: "month" | "quarter" = "month") => runReport(db, { companyId: CO, metric: "payroll_cost_by_month", from, to, groupBy });

describe("payroll_cost_by_month drivers", () => {
  it("each row carries workers_paid, hires and departures for its period", async () => {
    const r = await q("2026-01-01", "2026-10-31");
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      const m = String(row.period);
      const [paid] = await db.all<{ c: number }>(sql`SELECT count(DISTINCT pc.worker_id) AS c FROM paychecks pc JOIN payroll_runs r ON r.id = pc.payroll_run_id WHERE r.status IN ('processing', 'processed') AND pc.status <> 'excluded' AND substr(r.payday, 1, 7) = ${m}`);
      const [hires] = await db.all<{ c: number }>(sql`SELECT count(*) AS c FROM workers WHERE type = 'employee' AND status <> 'draft' AND substr(start_date, 1, 7) = ${m}`);
      const [left] = await db.all<{ c: number }>(sql`SELECT count(*) AS c FROM workers WHERE type = 'employee' AND status <> 'draft' AND substr(end_date, 1, 7) = ${m}`);
      expect(row, m).toMatchObject({ workers_paid: Number(paid!.c), hires: Number(hires!.c), departures: Number(left!.c) });
      expect(Number(row.workers_paid), m).toBeGreaterThan(0);
    }
  });

  it("agrees with hires_and_departures_by_month for the same periods, and the counts never enter range_totals", async () => {
    const cost = await q("2026-01-01", "2026-10-31");
    const moves = await runReport(db, { companyId: CO, metric: "hires_and_departures_by_month", from: "2026-01-01", to: "2026-10-31", groupBy: "month" });
    for (const row of cost.rows) {
      const m = moves.rows.find((x) => x.period === row.period)!;
      expect([row.hires, row.departures]).toEqual([m.hires, m.departures]);
    }
    const totals = rangeTotals(cost.rows);
    expect(Object.keys(totals).some((k) => /workers_paid|hires|departures/.test(k))).toBe(false);
  });

  it("a quarter counts each worker paid in it once, and sums its months' hires and departures", async () => {
    const months = await q("2026-07-01", "2026-12-31");
    const quarters = await q("2026-07-01", "2026-12-31", "quarter");
    for (const qr of quarters.rows) {
      const inQ = months.rows.filter((r) => String(r.period_start) >= String(qr.period_start) && String(r.period_end) <= String(qr.period_end));
      expect(qr.hires).toBe(inQ.reduce((a, r) => a + Number(r.hires), 0));
      expect(qr.departures).toBe(inQ.reduce((a, r) => a + Number(r.departures), 0));
      expect(Number(qr.workers_paid)).toBeLessThanOrEqual(inQ.reduce((a, r) => a + Number(r.workers_paid), 0));
      expect(Number(qr.workers_paid)).toBeGreaterThanOrEqual(Math.max(...inQ.map((r) => Number(r.workers_paid))));
    }
  });
});
