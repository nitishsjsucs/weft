// Special pay runs (wave 2, w2-offboarding): the dismissal run that carries a final paycheck and the off-cycle run
// for missed pay. Both reuse the regular engine inputs (W-4, benefits, employer rates, YTD) but take their earning
// lines explicitly, then go through the same submitRun path to the bank simulator as a regular run.
// Integer cents throughout; decimal.js with one half-up rounding per earning line.
import { and, eq } from "drizzle-orm";
import type { Flag, IdPrefix } from "@weft/contracts";
import { paychecks, payrollRuns, workers, type DbTx } from "@weft/db";
import { calculatePaycheck, dec, roundCents, TAX_2026, TAX_DATA_VERSION, type EarningLine, type PaycheckInput, type TaxTables } from "@weft/payroll-tax";
import { addDays, isBusinessDay, lastDayOfMonth, ptToUtc, semimonthlyPeriod, workingDays, ymd } from "./calendar";
import {
  activeBank, benefitAmounts, employerRateOn, loadWorld, loadYtd, rateOn, SEMIMONTHLY_PERIODS, stateRegistered, w4Of,
  type BenefitJson, type ComputedPaycheck, type EarningJson, type PayRateRow, type WorkerRow, type WorldSnapshot,
} from "./compute";
import { flagsFor, isBlocked, loadFlagContext, reviewGroupOf } from "./anomalies";
import { writeRunSummary, type RunRow } from "./lifecycle";

export type SpecialSubtype = "dismissal" | "off_cycle";
/** Engine earning type for each stored earning line type. PTO payout is paid as regular wages (aggregate method). */
const ENGINE_TYPE: Record<string, EarningLine["type"]> = { salary: "salary", regular: "regular", overtime: "overtime", pto_payout: "regular", bonus: "supplemental" };

export interface SpecialEarning extends EarningJson { note: string }

/** Simulated PTO policy (Time Off is a stub in wave 2): 10 hours per completed month in the calendar year, cap 120. */
export const PTO_HOURS_PER_MONTH_X100 = 1_000;
export const PTO_CAP_X100 = 12_000;
export const HOURS_PER_YEAR = 2_080;

/** Unused PTO hours (x100) on `lastDay`: whole calendar months worked from max(Jan 1, start date) through last day. */
export function unusedPtoHoursX100(startDate: string, lastDay: string): number {
  const year = Number(lastDay.slice(0, 4));
  const from = startDate > `${year}-01-01` ? startDate : `${year}-01-01`;
  let months = 0;
  for (let m = 1; m <= Number(lastDay.slice(5, 7)); m++) {
    if (ymd(year, m, 1) >= from && ymd(year, m, lastDayOfMonth(year, m)) <= lastDay) months++;
  }
  return Math.min(PTO_CAP_X100, months * PTO_HOURS_PER_MONTH_X100);
}

/** The semi-monthly period end (15th or month end) of the period containing `date`. */
export function periodEndContaining(date: string): string {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  return Number(date.slice(8, 10)) <= 15 ? ymd(y, m, 15) : ymd(y, m, lastDayOfMonth(y, m));
}

/** Hourly equivalent of a pay rate, as an exact decimal (salary / 2,080). */
export function hourlyRateOf(rate: PayRateRow) {
  return rate.kind === "hourly" ? dec(rate.amountCents) : dec(rate.amountCents).dividedBy(HOURS_PER_YEAR);
}

/** The first business day on or after `date`. */
export function businessDayOnOrAfter(date: string): string {
  let d = date;
  while (!isBusinessDay(d)) d = addDays(d, 1);
  return d;
}

/** Final pay earning lines: wages from the period start through the last day, plus unused PTO when asked. */
export function finalPayEarnings(w: WorkerRow, rates: PayRateRow[], lastDay: string, payUnusedPto: boolean, hoursX100: number | null): { period: { periodStart: string; periodEnd: string }; earnings: SpecialEarning[]; ptoHoursX100: number } {
  const period = semimonthlyPeriod(periodEndContaining(lastDay));
  const rate = rateOn(rates, lastDay) ?? rateOn(rates, period.periodStart);
  const earnings: SpecialEarning[] = [];
  if (rate?.kind === "hourly") {
    const h = hoursX100 ?? 0;
    earnings.push({ type: "regular", amountCents: roundCents(dec(rate.amountCents).times(h).dividedBy(100)), hoursX100: h, note: `${(h / 100).toFixed(2)} h through ${lastDay}` });
  } else if (rate) {
    const from = w.startDate > period.periodStart ? w.startDate : period.periodStart;
    const worked = workingDays(from, lastDay);
    const total = workingDays(period.periodStart, period.periodEnd);
    const cents = roundCents(dec(rate.amountCents).dividedBy(SEMIMONTHLY_PERIODS).times(worked).dividedBy(total));
    earnings.push({ type: "salary", amountCents: cents, hoursX100: null, note: `${worked} of ${total} working days, ${period.periodStart} to ${lastDay}` });
  }
  const ptoHoursX100 = payUnusedPto ? unusedPtoHoursX100(w.startDate, lastDay) : 0;
  if (rate && ptoHoursX100 > 0) {
    earnings.push({ type: "pto_payout", amountCents: roundCents(hourlyRateOf(rate).times(ptoHoursX100).dividedBy(100)), hoursX100: ptoHoursX100, note: `${(ptoHoursX100 / 100).toFixed(2)} h unused PTO` });
  }
  return { period, earnings, ptoHoursX100 };
}

/** One worker's paycheck with explicit earning lines; benefits, W-4, employer rates and YTD as in a regular run. */
export function specialPaycheck(w: WorkerRow, spec: { periodStart: string; periodEnd: string; payday: string }, world: WorldSnapshot, ytd: Record<string, number>, earnings: SpecialEarning[], opts: { tables?: TaxTables; benefits: boolean }): ComputedPaycheck {
  const t = opts.tables ?? TAX_2026;
  const rates = world.rates.get(w.id) ?? [];
  const rate = rateOn(rates, spec.periodEnd) ?? rateOn(rates, spec.periodStart);
  const gross = earnings.reduce((s, e) => s + e.amountCents, 0);
  const benefits: BenefitJson[] = [];
  const pretax: { code: string; amount_cents: number }[] = [];
  if (opts.benefits) {
    const enrolls = (world.enrollments.get(w.id) ?? [])
      .filter((e) => e.status === "active" && e.effectiveFrom <= spec.periodEnd && (e.effectiveTo === null || e.effectiveTo >= spec.periodStart))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const e of enrolls) {
      const plan = world.plans.get(e.planId);
      if (!plan) continue;
      const b = benefitAmounts(plan, e, gross);
      benefits.push({ planId: b.planId, employeeCents: b.employeeCents, employerCents: b.employerCents });
      if (b.employeeCents > 0) pretax.push({ code: b.code, amount_cents: b.employeeCents });
    }
  }
  const profile = world.profiles.get(w.id);
  const state = w.workState ?? "CA";
  const input: PaycheckInput = {
    payDate: spec.payday, payPeriodsPerYear: SEMIMONTHLY_PERIODS, jurisdiction: state,
    earnings: earnings.map((e) => ({ type: ENGINE_TYPE[e.type] ?? "regular", amount_cents: e.amountCents, hours_x100: e.hoursX100 })),
    pretax, posttax: [], reimbursements_cents: 0, w4: w4Of(profile),
    state: { filingStatus: profile?.stateFilingStatus ?? null, allowances: profile?.stateAllowances ?? 0 },
    ytd, employerRates: { sui: employerRateOn(world.employerRates, state, "sui", spec.payday), ett: state === "CA" ? employerRateOn(world.employerRates, state, "ett", spec.payday) : null },
  };
  const supplementalCents = earnings.filter((e) => e.type === "bonus").reduce((s, e) => s + e.amountCents, 0);
  if (supplementalCents > 0) input.supplementalCents = supplementalCents;
  const calc = calculatePaycheck(input, t);
  return {
    workerId: w.id, worker: w, rate, hoursX100: earnings.find((e) => e.hoursX100 !== null && e.type !== "pto_payout")?.hoursX100 ?? null,
    earnings: earnings.map(({ type, amountCents, hoursX100 }) => ({ type, amountCents, hoursX100 })), benefits, calc, reimbursementsCents: 0,
    deductions: pretax.map((d) => ({ code: d.code, pretax: true, amountCents: d.amount_cents })),
    bank: activeBank(world, w.id), hasW4: profile !== undefined, stateRegistered: stateRegistered(world.accounts, state), prorated: null,
  };
}

export interface SpecialLine { workerId: string; earnings: SpecialEarning[] }
export interface SpecialRunSpec { companyId: string; subtype: SpecialSubtype; periodStart: string; periodEnd: string; payday: string; lines: SpecialLine[]; benefits: boolean; tables?: TaxTables }
export interface SpecialPlanLine { workerId: string; paycheck: ComputedPaycheck; earnings: SpecialEarning[]; flags: Flag[] }

/** Pure-read plan for a special run: one computed paycheck per line, YTD from the ledger. Used by previews and runs alike. */
export async function planSpecialRun(tx: DbTx, spec: SpecialRunSpec): Promise<{ lines: SpecialPlanLine[]; payScheduleId: string }> {
  const ids = spec.lines.map((l) => l.workerId);
  const ws = ids.length ? await tx.select().from(workers).where(eq(workers.companyId, spec.companyId)) : [];
  const byId = new Map(ws.filter((w) => ids.includes(w.id)).map((w) => [w.id, w]));
  const world = await loadWorld(tx, spec.companyId, ids);
  const ytd = await loadYtd(tx, ids, Number(spec.payday.slice(0, 4)));
  const first = byId.get(ids[0] ?? "");
  const payScheduleId = first?.payScheduleId ?? "ps_us_semimonthly";
  const ctx = await loadFlagContext(tx, { payScheduleId, periodStart: spec.periodStart, periodEnd: spec.periodEnd, previousRunId: null, workerIds: ids });
  const lines: SpecialPlanLine[] = [];
  for (const l of spec.lines) {
    const w = byId.get(l.workerId);
    if (!w) throw new Error(`special run: no worker ${l.workerId}`);
    const cp = specialPaycheck(w, spec, world, ytd.get(w.id) ?? {}, l.earnings, { tables: spec.tables, benefits: spec.benefits });
    // Only blocking flags matter on a special run (no prior run of the same subtype to compare with).
    const flags = flagsFor(cp, ctx).filter((f) => f.severity === "block");
    lines.push({ workerId: w.id, paycheck: cp, earnings: l.earnings, flags });
  }
  return { lines, payScheduleId };
}

/** Run id for a special run: pay_<payday>_<final|oc>_<n>, unique by the pay_ counter. */
export async function specialRunId(newId: (p: IdPrefix) => Promise<string>, subtype: SpecialSubtype, payday: string): Promise<string> {
  const n = (await newId("pay_")).slice(4);
  return `pay_${payday.replace(/-/g, "_")}_${subtype === "dismissal" ? "final" : "oc"}_${n}`;
}

/** Inserts the draft special run and its paychecks in the caller's transaction, then writes totals and the subject hash. */
export async function createSpecialRun(tx: DbTx, deps: { newId(p: IdPrefix): Promise<string>; now: string; tables?: TaxTables }, spec: SpecialRunSpec): Promise<RunRow> {
  const plan = await planSpecialRun(tx, spec);
  const id = await specialRunId(deps.newId, spec.subtype, spec.payday);
  await tx.insert(payrollRuns).values({
    id, companyId: spec.companyId, payScheduleId: plan.payScheduleId, type: "us", subtype: spec.subtype, status: "draft",
    periodStart: spec.periodStart, periodEnd: spec.periodEnd, payday: spec.payday, approvalDeadline: ptToUtc(spec.payday, 5), fundingMethod: "ach",
    taxDataVersion: deps.tables?.version ?? TAX_DATA_VERSION, previousRunId: null, excludedWorkerIdsJson: "[]", createdAt: deps.now, updatedAt: deps.now,
  });
  for (const l of plan.lines) {
    const cp = l.paycheck;
    await tx.insert(paychecks).values({
      id: await deps.newId("pyc_"), payrollRunId: id, workerId: cp.workerId, status: isBlocked(l.flags) ? "blocked" : "draft", reviewGroup: reviewGroupOf(l.flags),
      hoursX100: cp.hoursX100, grossCents: cp.calc.gross_cents, netCents: cp.calc.net_cents, reimbursementsCents: 0,
      earningsJson: JSON.stringify(cp.earnings), deductionsJson: JSON.stringify(cp.deductions), benefitsJson: JSON.stringify(cp.benefits),
      taxesJson: JSON.stringify(cp.calc.taxes), flagsJson: JSON.stringify(l.flags),
    });
  }
  await writeRunSummary(tx, deps, id, []);
  const [row] = await tx.select().from(payrollRuns).where(and(eq(payrollRuns.id, id), eq(payrollRuns.companyId, spec.companyId)));
  return row!;
}

// ------------------------------------------------------------------ off-cycle (GP10)

export type OffCycleReason = "missed_payroll" | "bonus" | "correction" | "final_pay";
export interface OffCycleInput { companyId: string; workerIds: string[]; periodStart: string; periodEnd: string; payday: string; reason: OffCycleReason; bonusCents: Record<string, number> }

/** Calendar days from `from` through `to`, inclusive. */
export function calendarDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * Salary for one period, split by calendar days when the rate changes inside it: each rate's line is
 * annual / 24 x (its days / period days), one half-up rounding per line. Days before the start date or after the
 * end date earn nothing. Returns one line per rate in effect.
 */
export function proratedSalaryLines(w: Pick<WorkerRow, "startDate" | "endDate">, rates: PayRateRow[], periodStart: string, periodEnd: string): SpecialEarning[] {
  const total = calendarDays(periodStart, periodEnd);
  const segs: { rate: PayRateRow; from: string; to: string; days: number }[] = [];
  for (let d = periodStart; d <= periodEnd; d = addDays(d, 1)) {
    if (d < w.startDate || (w.endDate !== null && d > w.endDate)) continue;
    const r = rateOn(rates, d);
    if (!r) continue;
    const last = segs.at(-1);
    if (last && last.rate.id === r.id && addDays(last.to, 1) === d) { last.to = d; last.days++; }
    else segs.push({ rate: r, from: d, to: d, days: 1 });
  }
  return segs.map((s) => ({
    type: "salary", hoursX100: null,
    amountCents: roundCents(dec(s.rate.amountCents).dividedBy(SEMIMONTHLY_PERIODS).times(s.days).dividedBy(total)),
    note: s.days === total ? `${total} of ${total} days at ${(s.rate.amountCents / 100).toFixed(2)} a year` : `${s.days} of ${total} days, ${s.from} to ${s.to}, at ${(s.rate.amountCents / 100).toFixed(2)} a year`,
  }));
}

/** The earning lines of an off-cycle run: prorated salary (unless reason is bonus only) plus the bonus as supplemental wages. */
export async function offCycleLines(tx: DbTx, req: OffCycleInput): Promise<SpecialLine[]> {
  const ids = [...new Set(req.workerIds)].sort();
  const world = await loadWorld(tx, req.companyId, ids);
  const ws = await tx.select().from(workers).where(eq(workers.companyId, req.companyId));
  const lines: SpecialLine[] = [];
  for (const id of ids) {
    const w = ws.find((x) => x.id === id);
    if (!w || w.type !== "employee") throw new OffCycleRefusal("DOMAIN_NOT_EMPLOYEE", `${id} is not an employee of this company`);
    const rates = world.rates.get(id) ?? [];
    const earnings: SpecialEarning[] = [];
    if (req.reason !== "bonus") {
      if (rates.some((r) => r.kind === "hourly" && r.effectiveFrom <= req.periodEnd)) throw new OffCycleRefusal("DOMAIN_UNSUPPORTED_HOURLY", `${id} is paid hourly; off-cycle runs prorate salaried pay only`);
      earnings.push(...proratedSalaryLines(w, rates, req.periodStart, req.periodEnd));
    }
    const bonus = req.bonusCents[id] ?? 0;
    if (bonus > 0) earnings.push({ type: "bonus", amountCents: bonus, hoursX100: null, note: "supplemental wages, federal flat 22 percent" });
    if (!earnings.length) throw new OffCycleRefusal("DOMAIN_EMPTY_RUN", `${id} has no earnings for ${req.periodStart} to ${req.periodEnd}`);
    lines.push({ workerId: id, earnings });
  }
  return lines;
}

export class OffCycleRefusal extends Error {
  constructor(readonly code: `DOMAIN_${string}`, message: string) { super(message); this.name = "OffCycleRefusal"; }
}

/** Settles at 06:00 PT on payday, or at the next tick when that has already passed. */
export function specialSettleAt(payday: string, now: string): string {
  const at = ptToUtc(payday, 6);
  return at > now ? at : now;
}
