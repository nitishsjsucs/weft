// Pre-payroll anomaly rules (SPEC 7.5): deterministic, compare the draft with the previous processed run of the
// schedule and with HR data. Rows with any review or block flag go to Needs Review; others to Ready for Approval.
import { and, desc, eq, inArray } from "drizzle-orm";
import { formatCents, type Flag } from "@weft/contracts";
import { actions, paychecks, payrollRuns, payRates, type DbTx } from "@weft/db";
import type { ComputedPaycheck } from "./compute";
import { loadW3FlagData, w3Flags, type W3FlagData } from "./w3-hooks";   // wave 3 rules

export const GROSS_CHANGE_THRESHOLD = 0.10;
export const HOURS_SPIKE_THRESHOLD = 0.25;
export const TOTAL_CHANGE_THRESHOLD = 0.05;

export interface PrevPaycheck { id: string; workerId: string; grossCents: number; hoursX100: number | null }
export interface RateChange { payRateId: string; createdActionSeq: number | null; actionResultId: string | null; effectiveFrom: string; amountCents: number; kind: string }
export interface FlagContext {
  periodStart: string; periodEnd: string;
  previousRunId: string | null;
  previous: Map<string, PrevPaycheck>;
  /** Hours on the worker's paychecks in the last 3 processed runs (most recent first). */
  recentHours: Map<string, number[]>;
  /** Rates that became effective after the previous run's period end, latest first. */
  rateChanges: Map<string, RateChange>;
  /** Wave 3 rule data (payroll/w3-hooks.ts); absent in contexts built by hand. */
  w3?: W3FlagData;
}

const pctString = (from: number, to: number) => (((to - from) / from) * 100).toFixed(1);
const money = (cents: number) => formatCents(cents);
const hours = (x100: number) => (x100 / 100).toFixed(2);

export function flagsFor(cp: ComputedPaycheck, ctx: FlagContext): Flag[] {
  const flags: Flag[] = [];
  const w = cp.worker;
  const gross = cp.calc.gross_cents;
  const prev = ctx.previous.get(cp.workerId) ?? null;
  if (ctx.previousRunId && !prev) {
    flags.push({
      rule: "NEW_IN_RUN", severity: cp.hasW4 ? "info" : "review",
      message: `Not in the previous run ${ctx.previousRunId}; start date ${w.startDate}${cp.hasW4 ? "" : "; no W-4 on file"}`,
      evidence: { worker_id: w.id, previous_run_id: ctx.previousRunId, start_date: w.startDate, has_w4: cp.hasW4 },
    });
  }
  if (prev && prev.grossCents > 0 && Math.abs(gross - prev.grossCents) > prev.grossCents * GROSS_CHANGE_THRESHOLD) {
    const change = ctx.rateChanges.get(cp.workerId) ?? null;
    const up = gross > prev.grossCents;
    const evidence: Record<string, unknown> = {
      worker_id: w.id, previous_paycheck_id: prev.id, previous_run_id: ctx.previousRunId,
      previous_gross_cents: prev.grossCents, previous_gross_display: money(prev.grossCents),
      gross_cents: gross, gross_display: money(gross), change_pct: pctString(prev.grossCents, gross),
      pay_rate_id: change?.payRateId ?? null, created_action_seq: change?.createdActionSeq ?? null, action_result_id: change?.actionResultId ?? null,
    };
    if (change) Object.assign(evidence, { pay_rate_effective_from: change.effectiveFrom, pay_rate_cents: change.amountCents, pay_rate_display: money(change.amountCents) });
    if (cp.hoursX100 !== null) Object.assign(evidence, { hours_x100: cp.hoursX100, hours_display: hours(cp.hoursX100), previous_hours_x100: prev.hoursX100 });
    if (cp.prorated) Object.assign(evidence, { worked_days: cp.prorated.workedDays, period_days: cp.prorated.periodDays });
    flags.push({
      rule: "GROSS_CHANGE", severity: "review",
      message: `Gross ${up ? "up" : "down"} ${pctString(prev.grossCents, gross).replace("-", "")}% from the previous paycheck (${money(prev.grossCents)} to ${money(gross)})${change ? `; pay rate ${change.payRateId} effective ${change.effectiveFrom}` : ""}`,
      evidence,
    });
  }
  const recent = ctx.recentHours.get(cp.workerId) ?? [];
  if (cp.hoursX100 !== null && recent.length > 0) {
    const avg = recent.reduce((s, h) => s + h, 0) / recent.length;
    if (cp.hoursX100 > avg * (1 + HOURS_SPIKE_THRESHOLD)) {
      const avgX100 = Math.round(avg);
      flags.push({
        rule: "HOURS_SPIKE", severity: "review",
        message: `${hours(cp.hoursX100)} hours vs an average of ${hours(avgX100)} over the last ${recent.length} runs`,
        evidence: { worker_id: w.id, hours_x100: cp.hoursX100, hours_display: hours(cp.hoursX100), average_hours_x100: avgX100, average_hours_display: hours(avgX100), runs_compared: recent.length, overtime_threshold_hours: "86.67" },
      });
    }
  }
  if (cp.prorated) {
    const ends = w.endDate !== null && w.endDate < ctx.periodEnd;
    flags.push({
      rule: "PRORATED", severity: "review",
      message: `Partial period: ${ends ? `end date ${w.endDate}` : `start date ${w.startDate}`}; ${cp.prorated.workedDays} of ${cp.prorated.periodDays} working days`,
      evidence: { worker_id: w.id, start_date: w.startDate, end_date: w.endDate, worked_days: cp.prorated.workedDays, period_days: cp.prorated.periodDays, gross_cents: gross, gross_display: money(gross) },
    });
  }
  if (!cp.bank) {
    flags.push({ rule: "MISSING_BANK_ACCOUNT", severity: "block", message: "No active bank account for direct deposit", evidence: { worker_id: w.id, bank_account_id: null } });
  }
  if (!cp.stateRegistered) {
    flags.push({ rule: "UNREGISTERED_STATE", severity: "block", message: `Work state ${w.workState} lacks an active withholding or UI account`, evidence: { worker_id: w.id, work_state: w.workState } });
  }
  if (cp.calc.net_cents <= 0) {
    flags.push({ rule: "NEGATIVE_NET", severity: "block", message: `Net pay ${money(cp.calc.net_cents)} is at or below zero`, evidence: { worker_id: w.id, net_cents: cp.calc.net_cents, net_display: money(cp.calc.net_cents) } });
  }
  flags.push(...w3Flags(cp, ctx.w3));   // wave 3
  return flags;
}

export function reviewGroupOf(flags: Flag[]): "needs_review" | "ready" {
  return flags.some((f) => f.severity === "review" || f.severity === "block") ? "needs_review" : "ready";
}
export const isBlocked = (flags: Flag[]) => flags.some((f) => f.severity === "block");

/** Run-level flags: MISSING_FROM_RUN (no paycheck row to hang it on) and TOTAL_CHANGE (info). */
export function runFlags(input: { included: ComputedPaycheck[]; ctx: FlagContext; previousRunGrossCents: number | null }): Flag[] {
  const out: Flag[] = [];
  const now = new Set(input.included.map((c) => c.workerId));
  for (const [workerId, prev] of input.ctx.previous) {
    if (!now.has(workerId)) out.push({ rule: "MISSING_FROM_RUN", severity: "review", message: `In the previous run ${input.ctx.previousRunId} but not in this one`, evidence: { worker_id: workerId, previous_paycheck_id: prev.id, previous_run_id: input.ctx.previousRunId } });
  }
  const gross = input.included.reduce((s, c) => s + c.calc.gross_cents, 0);
  const pg = input.previousRunGrossCents;
  if (pg !== null && pg > 0 && Math.abs(gross - pg) > pg * TOTAL_CHANGE_THRESHOLD) {
    out.push({ rule: "TOTAL_CHANGE", severity: "info", message: `Run gross ${money(gross)} vs ${money(pg)} in the previous run (${pctString(pg, gross)}%)`, evidence: { previous_run_id: input.ctx.previousRunId, gross_cents: gross, gross_display: money(gross), previous_gross_cents: pg, previous_gross_display: money(pg), change_pct: pctString(pg, gross) } });
  }
  return out;
}

/** Loads the comparison context: the previous processed run, the last 3 runs' hours, and new pay rates. */
export async function loadFlagContext(tx: DbTx, input: { payScheduleId: string; periodStart: string; periodEnd: string; previousRunId: string | null; workerIds: string[] }): Promise<FlagContext & { previousRunGrossCents: number | null }> {
  const previous = new Map<string, PrevPaycheck>();
  const recentHours = new Map<string, number[]>();
  const rateChanges = new Map<string, RateChange>();
  let previousRunGrossCents: number | null = null;
  let prevPeriodEnd: string | null = null;
  const processed = await tx.select().from(payrollRuns)
    .where(and(eq(payrollRuns.payScheduleId, input.payScheduleId), eq(payrollRuns.status, "processed")))
    .orderBy(desc(payrollRuns.periodEnd));
  const before = processed.filter((r) => r.periodEnd < input.periodStart && r.subtype === "regular");
  const last3 = before.slice(0, 3);
  if (last3.length) {
    const rows = await tx.select().from(paychecks).where(inArray(paychecks.payrollRunId, last3.map((r) => r.id)));
    for (const run of last3) {
      for (const p of rows.filter((x) => x.payrollRunId === run.id)) {
        if (p.hoursX100 !== null) { const a = recentHours.get(p.workerId) ?? []; a.push(p.hoursX100); recentHours.set(p.workerId, a); }
      }
    }
  }
  if (input.previousRunId) {
    const prevRun = processed.find((r) => r.id === input.previousRunId) ?? null;
    prevPeriodEnd = prevRun?.periodEnd ?? null;
    const rows = await tx.select().from(paychecks).where(eq(paychecks.payrollRunId, input.previousRunId));
    previousRunGrossCents = 0;
    for (const p of rows) {
      if (p.status === "excluded") continue;
      previous.set(p.workerId, { id: p.id, workerId: p.workerId, grossCents: p.grossCents, hoursX100: p.hoursX100 });
      previousRunGrossCents += p.grossCents;
    }
  }
  if (prevPeriodEnd && input.workerIds.length) {
    const rates = await tx.select().from(payRates).where(inArray(payRates.workerId, input.workerIds));
    const fresh = rates.filter((r) => r.effectiveFrom > prevPeriodEnd! && r.effectiveFrom <= input.periodEnd)
      .sort((a, b) => (a.effectiveFrom === b.effectiveFrom ? (a.id < b.id ? 1 : -1) : a.effectiveFrom < b.effectiveFrom ? 1 : -1));
    const seqs = fresh.map((r) => r.createdActionSeq).filter((s): s is number => s !== null);
    const acts = seqs.length ? await tx.select({ seq: actions.seq, resultId: actions.resultId }).from(actions).where(inArray(actions.seq, seqs)) : [];
    const resultBySeq = new Map(acts.map((a) => [a.seq, a.resultId]));
    for (const r of fresh) {
      if (rateChanges.has(r.workerId)) continue;
      rateChanges.set(r.workerId, {
        payRateId: r.id, createdActionSeq: r.createdActionSeq, actionResultId: r.createdActionSeq !== null ? (resultBySeq.get(r.createdActionSeq) ?? null) : null,
        effectiveFrom: r.effectiveFrom, amountCents: r.amountCents, kind: r.kind,
      });
    }
  }
  const w3 = await loadW3FlagData(tx, input);   // wave 3
  return { periodStart: input.periodStart, periodEnd: input.periodEnd, previousRunId: input.previousRunId, previous, recentHours, rateChanges, previousRunGrossCents, w3 };
}

export interface PrecheckSummary {
  runId: string; status: string; needsReview: number; ready: number; blocked: number; excluded: number;
  flagged: { paycheckId: string; workerId: string; rules: string[]; blocking: boolean; explained: boolean }[];
  runFlags: Flag[];
}

/** prePayrollPrecheck(runId): the stored draft's flag summary, read only. */
export async function prePayrollPrecheck(tx: DbTx, runId: string): Promise<PrecheckSummary | null> {
  const run = (await tx.select().from(payrollRuns).where(eq(payrollRuns.id, runId)))[0];
  if (!run) return null;
  const rows = await tx.select().from(paychecks).where(eq(paychecks.payrollRunId, runId));
  const summary = run.anomalySummaryJson ? (JSON.parse(run.anomalySummaryJson) as { runFlags?: Flag[] }) : {};
  const flagged = rows
    .filter((p) => p.reviewGroup === "needs_review" && p.status !== "excluded")
    .map((p) => { const f = JSON.parse(p.flagsJson) as Flag[]; return { paycheckId: p.id, workerId: p.workerId, rules: f.map((x) => x.rule), blocking: isBlocked(f), explained: p.explanation !== null }; })
    .sort((a, b) => (a.workerId < b.workerId ? -1 : 1));
  return {
    runId, status: run.status,
    needsReview: rows.filter((p) => p.reviewGroup === "needs_review" && p.status !== "excluded").length,
    ready: rows.filter((p) => p.reviewGroup === "ready" && p.status !== "excluded").length,
    blocked: rows.filter((p) => p.status === "blocked").length,
    excluded: rows.filter((p) => p.status === "excluded").length,
    flagged, runFlags: summary.runFlags ?? [],
  };
}
