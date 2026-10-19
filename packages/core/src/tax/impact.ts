// Rate change impact from the YTD ledger and the open draft (harness 5.6): rate_delta, affected and unaffected
// counts, per-worker cents with displays. Pure reads; also used by update_rate's preview.
import { and, eq, inArray, sql } from "drizzle-orm";
import { formatCents } from "@weft/contracts";
import { paychecks, payrollRuns, workers, ytdLedger, type DbTx } from "@weft/db";
import { mulRateCents, rateDisplay, rateSub } from "../demo/define";
import { nameRef } from "../people/names";

export interface ImpactInput { companyId: string; jurisdiction: string; code: "sui" | "ett"; oldRate: string; newRate: string; year: number; wageBaseCents: number }

export async function rateChangeImpact(tx: DbTx, i: ImpactInput) {
  const emps = await tx.select().from(workers).where(and(eq(workers.companyId, i.companyId), eq(workers.workState, i.jurisdiction), eq(workers.type, "employee")));
  emps.sort((a, b) => (a.id < b.id ? -1 : 1));
  const ids = emps.map((w) => w.id);
  const wageCode = i.code === "ett" ? `sui_wages:${i.jurisdiction}` : `sui_wages:${i.jurisdiction}`;
  const ledger = ids.length
    ? await tx.select({ workerId: ytdLedger.workerId, cents: sql<number>`SUM(${ytdLedger.amountCents})` }).from(ytdLedger)
      .where(and(inArray(ytdLedger.workerId, ids), eq(ytdLedger.year, i.year), eq(ytdLedger.code, wageCode))).groupBy(ytdLedger.workerId)
    : [];
  const ytd = new Map(ledger.map((r) => [r.workerId, Number(r.cents)]));

  // Next run: the open draft's taxable wages for this code (T1 paychecks.taxes_json).
  const [draft] = await tx.select().from(payrollRuns).where(and(eq(payrollRuns.companyId, i.companyId), eq(payrollRuns.status, "draft"))).orderBy(payrollRuns.payday).limit(1);
  const nextTaxable = new Map<string, number>();
  if (draft) {
    for (const p of await tx.select().from(paychecks).where(eq(paychecks.payrollRunId, draft.id))) {
      try {
        for (const t of JSON.parse(p.taxesJson) as { code: string; jurisdiction: string; payer?: string; taxable_wages_cents?: number; taxableWagesCents?: number }[]) {
          if (t.code === i.code && t.jurisdiction === i.jurisdiction && (t.payer ?? "employer") === "employer") nextTaxable.set(p.workerId, Number(t.taxable_wages_cents ?? t.taxableWagesCents ?? 0));
        }
      } catch { /* malformed taxes_json: skip */ }
    }
  }

  // The people a rate change reaches: employees with wages for this code in the year, or on the open draft. A hire who
  // has not started yet has neither, and a leaver paid earlier in the year still counts (their wages carry the credit).
  const paid = emps.filter((w) => (ytd.get(w.id) ?? 0) > 0 || (nextTaxable.get(w.id) ?? 0) > 0);
  const perWorker = paid.map((w) => {
    const wages = Math.min(ytd.get(w.id) ?? 0, i.wageBaseCents);
    const before = mulRateCents(wages, i.oldRate), after = mulRateCents(wages, i.newRate);
    const next = nextTaxable.get(w.id) ?? 0;
    const nb = mulRateCents(next, i.oldRate), na = mulRateCents(next, i.newRate);
    return {
      worker_id: w.id, name: nameRef(w.firstName, w.lastName, w.id), ytd_wages_cents: wages, ytd_wages_display: formatCents(wages),
      before_cents: before, before_display: formatCents(before), after_cents: after, after_display: formatCents(after),
      credit_cents: before - after, credit_display: formatCents(before - after),
      under_wage_base: (ytd.get(w.id) ?? 0) < i.wageBaseCents,
      next_run_taxable_cents: next, next_run_before_cents: nb, next_run_after_cents: na, next_run_change_cents: na - nb, next_run_change_display: formatCents(na - nb),
    };
  });
  const affected = perWorker.filter((p) => p.credit_cents !== 0);
  const nextAffected = perWorker.filter((p) => p.next_run_change_cents !== 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const delta = rateSub(i.oldRate, i.newRate);
  return {
    jurisdiction: i.jurisdiction, code: i.code, old_rate: i.oldRate, new_rate: i.newRate, rate_delta: delta, rate_delta_display: rateDisplay(delta.replace(/^-/, "")),
    employees_in_state: paid.length, affected_count: affected.length, unaffected_count: paid.length - affected.length,
    ytd_before_cents: sum(perWorker.map((p) => p.before_cents)), ytd_before_display: formatCents(sum(perWorker.map((p) => p.before_cents))),
    ytd_after_cents: sum(perWorker.map((p) => p.after_cents)), ytd_after_display: formatCents(sum(perWorker.map((p) => p.after_cents))),
    credit_total_cents: sum(affected.map((p) => p.credit_cents)), credit_total_display: formatCents(sum(affected.map((p) => p.credit_cents))),
    under_wage_base_count: perWorker.filter((p) => p.under_wage_base).length,
    next_run: draft ? { run_id: draft.id, payday: draft.payday, before_cents: sum(nextAffected.map((p) => p.next_run_before_cents)), before_display: formatCents(sum(nextAffected.map((p) => p.next_run_before_cents))), after_cents: sum(nextAffected.map((p) => p.next_run_after_cents)), after_display: formatCents(sum(nextAffected.map((p) => p.next_run_after_cents))), affected_count: nextAffected.length, unaffected_count: paid.length - nextAffected.length, change_cents: sum(nextAffected.map((p) => p.next_run_change_cents)), change_display: formatCents(sum(nextAffected.map((p) => p.next_run_change_cents))) } : null,
    workers: perWorker,
  };
}
