// Pay history for the seed (SPEC 5.5), built with the lifecycle functions, not the executor: opening YTD from the
// engine ("imported from previous provider", no paychecks), processed runs with settled bank batches, and the open draft.
import { and, eq } from "drizzle-orm";
import type { BankSim, IdPrefix } from "@weft/contracts";
import { workers, ytdLedger, type DbTx } from "@weft/db";
import type { TaxTables } from "@weft/payroll-tax";
import { businessDaysBefore, previousBusinessDayOnOrBefore, ptToUtc, semimonthlyPeriodsThrough, semimonthlyRunDates } from "./calendar";
import { computeWorkerPaycheck, loadWorld, type PeriodSpec } from "./compute";
import { createDraft, markProcessed, submitRun } from "./lifecycle";

/** Hours assumed for hourly workers in imported periods that have no time entry (86.67, the steady schedule). */
export const IMPORT_DEFAULT_HOURS_X100 = 8667;

/**
 * Opening YTD, Jan 1 to `through`: per employee, only the semi-monthly periods on or after the start date, computed
 * with the engine and a running YTD so wage bases cap correctly; written as ytd_ledger rows with source "import".
 */
export async function writeOpeningYtd(tx: DbTx, input: { companyId: string; payScheduleId: string; year: number; through: string; tables?: TaxTables }): Promise<{ workers: number; rows: number }> {
  const ws = (await tx.select().from(workers).where(and(eq(workers.companyId, input.companyId), eq(workers.payScheduleId, input.payScheduleId), eq(workers.type, "employee"))))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const world = await loadWorld(tx, input.companyId, ws.map((w) => w.id));
  const periods = semimonthlyPeriodsThrough(input.year, input.through);
  let rows = 0;
  let count = 0;
  for (const w of ws) {
    const ytd: Record<string, number> = {};
    for (const p of periods) {
      if (w.startDate > p.periodEnd || (w.endDate !== null && w.endDate < p.periodStart)) continue;
      const spec: PeriodSpec = { companyId: input.companyId, payScheduleId: input.payScheduleId, ...p, payday: previousBusinessDayOnOrBefore(p.periodEnd) };
      const cp = computeWorkerPaycheck(w, spec, world, { ...ytd }, { tables: input.tables, defaultHoursX100: IMPORT_DEFAULT_HOURS_X100 });
      for (const [k, v] of Object.entries(cp.calc.ytdDeltas)) ytd[k] = (ytd[k] ?? 0) + v;
    }
    const values = Object.entries(ytd).filter(([, v]) => v !== 0).sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([code, amountCents]) => ({ workerId: w.id, year: input.year, code, amountCents, source: "import" }));
    if (values.length) { await tx.insert(ytdLedger).values(values); count++; }
    rows += values.length;
  }
  return { workers: count, rows };
}

export interface HistoryDeps {
  newId(prefix: IdPrefix): Promise<string>;
  bank: Pick<BankSim, "submitBatch" | "tick">;
  credential: string;
  approvedBy: string;
  tables?: TaxTables;
}

/** One processed run through the lifecycle: draft, submit with a bank batch, settle, mark processed. */
export async function processHistoricRun(tx: DbTx, deps: HistoryDeps, input: { companyId: string; payScheduleId: string; periodEnd: string }): Promise<string> {
  const dates = semimonthlyRunDates(input.periodEnd);
  const run = await createDraft(tx, { newId: deps.newId, now: ptToUtc(dates.periodStart, 9), tables: deps.tables }, input);
  await submitRun(tx, { newId: deps.newId, now: ptToUtc(businessDaysBefore(dates.payday, 2), 15) }, {
    runId: run.id, excludeBlocked: false, approvedBy: deps.approvedBy, actionSeq: null, bank: deps.bank, credential: deps.credential, settleAt: dates.settleAt,
  });
  await deps.bank.tick(dates.settleAt);
  await markProcessed(tx, { now: dates.settleAt }, { runId: run.id });
  return run.id;
}

export const SEED_PROCESSED_PERIOD_ENDS = ["2026-09-15", "2026-09-30", "2026-10-15"] as const;
export const SEED_DRAFT_PERIOD_END = "2026-10-31";

/** SPEC 5.5 in order: opening YTD, pay_2026_09_15, pay_2026_09_30, pay_2026_10_15 (processed), pay_2026_10_30 (draft). */
export async function seedPayHistory(tx: DbTx, deps: HistoryDeps & { draftCreatedAt: string }, input: { companyId: string; payScheduleId: string }): Promise<{ processed: string[]; draft: string }> {
  await writeOpeningYtd(tx, { ...input, year: 2026, through: "2026-08-31", tables: deps.tables });
  const processed: string[] = [];
  for (const periodEnd of SEED_PROCESSED_PERIOD_ENDS) processed.push(await processHistoricRun(tx, deps, { ...input, periodEnd }));
  const draft = await createDraft(tx, { newId: deps.newId, now: deps.draftCreatedAt, tables: deps.tables }, { ...input, periodEnd: SEED_DRAFT_PERIOD_END });
  return { processed, draft: draft.id };
}
