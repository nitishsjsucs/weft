// DUPLICATE_SUPPLEMENTAL, RAISE_NOT_APPLIED and WITHHOLDING_CHANGED (wave 3, docs/wave3.md). Owner: w3-parity-routines.
// Called by payroll/w3-hooks.ts. loadParityFlagData reads once per draft; parityFlags is pure over one computed paycheck.
//
// - DUPLICATE_SUPPLEMENTAL (block): a supplemental line (bonus, commission, supplemental, taxable reimbursement) with
//   the same type and amount as another line on this paycheck, or as a line on the worker's paycheck in either of the
//   two most recent runs on the schedule that left draft. Block, because special runs keep only blocking flags and a
//   doubled bonus is money out twice; a person removes the line or re-proposes the run.
// - RAISE_NOT_APPLIED (review): a pay rate of the same kind and a higher amount that became effective after the
//   previous run's period end and on or before this period's end, which the paycheck did not use (for example a new
//   rate row closed on its first day, so compute fell back to the old one).
// - WITHHOLDING_CHANGED (review): a federal W-4 or state withholding form submitted after the previous run was
//   processed and on or before this period's end, for a worker who was paid in that run. New hires are NEW_IN_RUN.
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { formatCents, type Flag } from "@weft/contracts";
import { onboardingSubmissions, paychecks, payrollRuns, payRates, type DbTx } from "@weft/db";
import type { ComputedPaycheck } from "./compute";
import type { W3FlagInput } from "./w3-hooks";

export const SUPPLEMENTAL_TYPES: ReadonlySet<string> = new Set(["bonus", "commission", "supplemental", "taxable_reimbursement"]);
export const WITHHOLDING_KINDS: ReadonlySet<string> = new Set(["federal_w4", "state_withholding"]);
/** Runs that left draft (pending, processing, processed); draft, failed and voided runs are not compared. */
const COMPARED_STATUSES = ["pending", "processing", "processed"];

export interface PriorSupplemental { runId: string; payday: string; type: string; amountCents: number }
export interface ParityRate { id: string; kind: string; amountCents: number; effectiveFrom: string; effectiveTo: string | null }
export interface WithholdingChange { submissionId: string; kind: string; submittedAt: string }
export interface ParityFlagData {
  periodStart: string; periodEnd: string;
  /** The previous processed run's period end; rates newer than this are "new since the last run". */
  previousPeriodEnd: string | null;
  priorSupplemental: Map<string, PriorSupplemental[]>;
  rates: Map<string, ParityRate[]>;
  withholding: Map<string, WithholdingChange[]>;
}

const push = <T>(m: Map<string, T[]>, k: string, v: T) => { const a = m.get(k) ?? []; a.push(v); m.set(k, a); };

export async function loadParityFlagData(tx: DbTx, input: W3FlagInput): Promise<ParityFlagData | null> {
  if (input.workerIds.length === 0) return null;
  const ids = input.workerIds;
  const priorSupplemental = new Map<string, PriorSupplemental[]>();
  const runs = (await tx.select({ id: payrollRuns.id, payday: payrollRuns.payday, status: payrollRuns.status, createdAt: payrollRuns.createdAt })
    .from(payrollRuns).where(and(eq(payrollRuns.payScheduleId, input.payScheduleId), inArray(payrollRuns.status, COMPARED_STATUSES)))
    .orderBy(desc(payrollRuns.payday), desc(payrollRuns.createdAt))).slice(0, 2);
  if (runs.length) {
    const rows = await tx.select({ runId: paychecks.payrollRunId, workerId: paychecks.workerId, earningsJson: paychecks.earningsJson, status: paychecks.status })
      .from(paychecks).where(and(inArray(paychecks.payrollRunId, runs.map((r) => r.id)), inArray(paychecks.workerId, ids), ne(paychecks.status, "excluded")));
    for (const p of rows) {
      const payday = runs.find((r) => r.id === p.runId)?.payday ?? "";
      let lines: { type?: string; amountCents?: number }[] = [];
      try { lines = JSON.parse(p.earningsJson) as typeof lines; } catch { lines = []; }
      for (const l of lines) if (l.type && SUPPLEMENTAL_TYPES.has(l.type) && typeof l.amountCents === "number" && l.amountCents > 0) {
        push(priorSupplemental, p.workerId, { runId: p.runId, payday, type: l.type, amountCents: l.amountCents });
      }
    }
  }

  const rates = new Map<string, ParityRate[]>();
  for (const r of await tx.select().from(payRates).where(inArray(payRates.workerId, ids))) {
    push(rates, r.workerId, { id: r.id, kind: r.kind, amountCents: r.amountCents, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo });
  }

  let previousPeriodEnd: string | null = null;
  const withholding = new Map<string, WithholdingChange[]>();
  if (input.previousRunId) {
    const [prev] = await tx.select({ periodEnd: payrollRuns.periodEnd, processedAt: payrollRuns.processedAt }).from(payrollRuns).where(eq(payrollRuns.id, input.previousRunId)).limit(1);
    previousPeriodEnd = prev?.periodEnd ?? null;
    const since = prev?.processedAt ?? null;
    if (since) {
      const paid = new Set((await tx.select({ workerId: paychecks.workerId }).from(paychecks)
        .where(and(eq(paychecks.payrollRunId, input.previousRunId), ne(paychecks.status, "excluded")))).map((r) => r.workerId));
      const subs = await tx.select({ id: onboardingSubmissions.id, workerId: onboardingSubmissions.workerId, kind: onboardingSubmissions.kind, submittedAt: onboardingSubmissions.submittedAt })
        .from(onboardingSubmissions).where(and(inArray(onboardingSubmissions.workerId, ids), inArray(onboardingSubmissions.kind, [...WITHHOLDING_KINDS])));
      for (const s of subs) {
        if (!paid.has(s.workerId) || s.submittedAt <= since || s.submittedAt.slice(0, 10) > input.periodEnd) continue;
        push(withholding, s.workerId, { submissionId: s.id, kind: s.kind, submittedAt: s.submittedAt });
      }
    }
  }
  return { periodStart: input.periodStart, periodEnd: input.periodEnd, previousPeriodEnd, priorSupplemental, rates, withholding };
}

const money = (c: number) => formatCents(c);
const FORM: Record<string, string> = { federal_w4: "federal W-4", state_withholding: "state withholding form" };

export function parityFlags(cp: ComputedPaycheck, data: unknown): Flag[] {
  const d = data as ParityFlagData | null | undefined;
  if (!d || !(d.rates instanceof Map)) return [];
  const flags: Flag[] = [];
  const wid = cp.workerId;

  // DUPLICATE_SUPPLEMENTAL: one flag per paycheck, naming the first repeated line.
  const lines = cp.earnings.filter((e) => SUPPLEMENTAL_TYPES.has(e.type) && e.amountCents > 0);
  const prior = d.priorSupplemental.get(wid) ?? [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const twin = lines.findIndex((x, j) => j !== i && x.type === l.type && x.amountCents === l.amountCents);
    const earlier = prior.find((p) => p.type === l.type && p.amountCents === l.amountCents) ?? null;
    if (twin < 0 && !earlier) continue;
    flags.push({
      rule: "DUPLICATE_SUPPLEMENTAL", severity: "block",
      message: earlier
        ? `A ${l.type} line of ${money(l.amountCents)} was already paid in ${earlier.runId} (payday ${earlier.payday})`
        : `Two ${l.type} lines of ${money(l.amountCents)} on this paycheck`,
      evidence: { worker_id: wid, earning_type: l.type, amount_cents: l.amountCents, amount_display: money(l.amountCents), previous_run_id: earlier?.runId ?? null, previous_payday: earlier?.payday ?? null, same_paycheck: twin >= 0 },
    });
    break;
  }

  // RAISE_NOT_APPLIED: the newest qualifying rate the paycheck did not use.
  const used = cp.rate;
  if (used) {
    const floor = d.previousPeriodEnd ?? d.periodStart;
    const missed = (d.rates.get(wid) ?? [])
      .filter((r) => r.id !== used.id && r.kind === used.kind && r.amountCents > used.amountCents && r.effectiveFrom > floor && r.effectiveFrom <= d.periodEnd && r.effectiveFrom > used.effectiveFrom)
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : a.id < b.id ? 1 : -1))[0];
    if (missed) {
      flags.push({
        rule: "RAISE_NOT_APPLIED", severity: "review",
        message: `Pay rate ${missed.id} (${money(missed.amountCents)}) is effective ${missed.effectiveFrom}${missed.effectiveTo ? ` and ends ${missed.effectiveTo}` : ""}, but this paycheck uses ${used.id} (${money(used.amountCents)})`,
        evidence: { worker_id: wid, pay_rate_id: missed.id, pay_rate_cents: missed.amountCents, pay_rate_display: money(missed.amountCents), pay_rate_effective_from: missed.effectiveFrom, pay_rate_effective_to: missed.effectiveTo, used_pay_rate_id: used.id, used_pay_rate_cents: used.amountCents, used_pay_rate_display: money(used.amountCents) },
      });
    }
  }

  // WITHHOLDING_CHANGED: the latest form since the previous run.
  const change = [...(d.withholding.get(wid) ?? [])].sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1))[0];
  if (change) {
    flags.push({
      rule: "WITHHOLDING_CHANGED", severity: "review",
      message: `New ${FORM[change.kind] ?? change.kind} submitted ${change.submittedAt.slice(0, 10)}, after the previous run was processed; withholding on this paycheck uses it`,
      evidence: { worker_id: wid, submission_id: change.submissionId, form_kind: change.kind, submitted_at: change.submittedAt },
    });
  }
  return flags;
}
