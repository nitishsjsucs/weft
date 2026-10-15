// Draft computation (SPEC 7.4): eligible workers, gross (salary / 24 prorated by working days; hourly with overtime
// above 86.67 h), benefit deductions from active enrollments, employer rates effective at payday, YTD from the
// ledger, then the pure engine. Reads only; lifecycle.ts writes.
import { and, eq, inArray } from "drizzle-orm";
import {
  bankAccounts, benefitEnrollments, benefitPlans, employerTaxRates, payRates, paySchedules, taxAccounts, taxProfiles,
  timeEntries, workers, ytdLedger, type DbTx,
} from "@weft/db";
import { calculatePaycheck, dec, roundCents, TAX_2026, type EmployerRateInput, type PaycheckCalc, type PaycheckInput, type TaxTables, type W4Input } from "@weft/payroll-tax";
import { workingDays } from "./calendar";

export const SEMIMONTHLY_PERIODS = 24;

export type WorkerRow = typeof workers.$inferSelect;
export type PayRateRow = typeof payRates.$inferSelect;
export type BankRow = typeof bankAccounts.$inferSelect;

export interface EarningJson { type: string; amountCents: number; hoursX100: number | null }
export interface DeductionJson { code: string; pretax: boolean; amountCents: number }
export interface BenefitJson { planId: string; employeeCents: number; employerCents: number }

export interface ComputedPaycheck {
  workerId: string;
  worker: WorkerRow;
  rate: PayRateRow | null;
  hoursX100: number | null;
  earnings: EarningJson[];
  deductions: DeductionJson[];
  benefits: BenefitJson[];
  calc: PaycheckCalc;
  reimbursementsCents: number;
  bank: BankRow | null;
  hasW4: boolean;
  stateRegistered: boolean;
  prorated: { workedDays: number; periodDays: number } | null;
}

export interface PeriodSpec { companyId: string; payScheduleId: string; periodStart: string; periodEnd: string; payday: string }

/** Active or onboarding employees on the schedule, started on or before period end, not ended before period start. */
export async function eligibleWorkers(tx: DbTx, p: PeriodSpec): Promise<WorkerRow[]> {
  const rows = await tx.select().from(workers).where(and(eq(workers.companyId, p.companyId), eq(workers.payScheduleId, p.payScheduleId), eq(workers.type, "employee")));
  return rows
    .filter((w) => ["active", "onboarding", "offboarding"].includes(w.status) || (w.status === "inactive" && w.endDate !== null && w.endDate >= p.periodStart))
    .filter((w) => w.startDate <= p.periodEnd && (w.endDate === null || w.endDate >= p.periodStart))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The pay rate effective on `date`: latest effective_from on or before it, not ended before it. */
export function rateOn(rates: PayRateRow[], date: string): PayRateRow | null {
  const live = rates.filter((r) => r.effectiveFrom <= date && (r.effectiveTo === null || r.effectiveTo >= date));
  live.sort((a, b) => (a.effectiveFrom === b.effectiveFrom ? (a.id < b.id ? 1 : -1) : a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return live[0] ?? null;
}

/** Employer rate (SUI, ETT) effective at payday; superseded rows are ignored (SPEC 7.1). */
export function employerRateOn(rows: (typeof employerTaxRates.$inferSelect)[], jurisdiction: string, code: string, payday: string): EmployerRateInput | null {
  const live = rows.filter((r) => r.jurisdiction === jurisdiction && r.code === code && r.supersededActionSeq === null && r.effectiveFrom <= payday && (r.effectiveTo === null || r.effectiveTo >= payday));
  live.sort((a, b) => {
    if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
    const sa = a.createdActionSeq ?? -1, sb = b.createdActionSeq ?? -1;
    if (sa !== sb) return sb - sa;
    return a.id < b.id ? 1 : -1;
  });
  const r = live[0];
  return r ? { rate: r.rate, wageBaseCents: r.wageBaseCents } : null;
}

const NEEDS_WITHHOLDING: Record<string, boolean> = { CA: true, NY: true, CO: true, TX: false };
/** A work state is registered when it has an active withholding (or combined) account where it taxes wages, and an active UI (or combined) account. */
export function stateRegistered(accounts: (typeof taxAccounts.$inferSelect)[], state: string): boolean {
  const mine = accounts.filter((a) => a.jurisdiction === state && a.status === "active");
  const ui = mine.some((a) => a.accountType === "unemployment" || a.accountType === "combined");
  const wh = !NEEDS_WITHHOLDING[state] || mine.some((a) => a.accountType === "withholding" || a.accountType === "combined");
  return ui && wh;
}

export function w4Of(p: typeof taxProfiles.$inferSelect | undefined): W4Input {
  if (!p) return { version: "2020", filingStatus: "single", step2Checkbox: false, step3Cents: 0, step4aCents: 0, step4bCents: 0, step4cCents: 0, allowances: 0, exempt: false };
  return {
    version: p.w4Version === "pre2020" ? "pre2020" : "2020", filingStatus: (["single", "mfj", "hoh"].includes(p.filingStatus) ? p.filingStatus : "single") as W4Input["filingStatus"],
    step2Checkbox: p.step2Checkbox, step3Cents: p.step3Cents, step4aCents: p.step4aCents, step4bCents: p.step4bCents, step4cCents: p.step4cCents,
    allowances: p.allowances, exempt: p.exempt,
  };
}

/** Salaried gross for one period, prorated by working days when the worker starts or ends inside it. */
export function salaryGross(annualCents: number, w: Pick<WorkerRow, "startDate" | "endDate">, p: Pick<PeriodSpec, "periodStart" | "periodEnd">): { cents: number; prorated: { workedDays: number; periodDays: number } | null } {
  const full = roundCents(dec(annualCents).dividedBy(SEMIMONTHLY_PERIODS));
  const from = w.startDate > p.periodStart ? w.startDate : p.periodStart;
  const to = w.endDate !== null && w.endDate < p.periodEnd ? w.endDate : p.periodEnd;
  if (from === p.periodStart && to === p.periodEnd) return { cents: full, prorated: null };
  const worked = workingDays(from, to);
  const total = workingDays(p.periodStart, p.periodEnd);
  return { cents: roundCents(dec(annualCents).dividedBy(SEMIMONTHLY_PERIODS).times(worked).dividedBy(total)), prorated: { workedDays: worked, periodDays: total } };
}

/** Hourly gross: 1.5x above 86.67 hours per semi-monthly period (SPEC 7.2, simplified). */
export function hourlyEarnings(rateCents: number, hoursX100: number, t: TaxTables = TAX_2026): EarningJson[] {
  const threshold = t.overtime.semimonthlyThresholdHoursX100;
  const ot = Math.max(0, hoursX100 - threshold);
  const reg = hoursX100 - ot;
  const out: EarningJson[] = [{ type: "regular", amountCents: roundCents(dec(rateCents).times(reg).dividedBy(100)), hoursX100: reg }];
  if (ot > 0) out.push({ type: "overtime", amountCents: roundCents(dec(rateCents).times(t.overtime.multiplier).times(ot).dividedBy(100)), hoursX100: ot });
  return out;
}

type PlanRow = typeof benefitPlans.$inferSelect;
type EnrollmentRow = typeof benefitEnrollments.$inferSelect;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Per-period benefit amounts. Shapes read (documented in docs/tracks/t1-payroll.md for the people seed):
 * prices_json `{ ee, ee_spouse, ee_children, family }` employee cents per period; match_json `{ employer_cents }` for
 * health plans, `{ match_bps, cap_bps }` for 401(k) (100% match up to 4% of gross is `{ match_bps: 10000, cap_bps: 400 }`).
 */
export function benefitAmounts(plan: PlanRow, e: EnrollmentRow, grossCents: number): BenefitJson & { code: string } {
  const prices = safeJson<Record<string, unknown>>(plan.pricesJson) ?? {};
  const match = safeJson<Record<string, unknown>>(plan.matchJson) ?? {};
  if (plan.type === "401k") {
    const bps = e.deferralBps ?? 0;
    const employee = roundCents(dec(grossCents).times(bps).dividedBy(10_000));
    const cap = num(match.cap_bps) ?? num(match.capBps) ?? 400;
    const pct = num(match.match_bps) ?? num(match.matchBps) ?? 10_000;
    const employer = roundCents(dec(grossCents).times(Math.min(bps, cap)).dividedBy(10_000).times(pct).dividedBy(10_000));
    return { code: plan.pretaxCode, planId: plan.id, employeeCents: employee, employerCents: employer };
  }
  const employee = e.employeeCents ?? num(prices[e.tier ?? "ee"]) ?? num(prices.ee) ?? 0;
  const employer = num(match.employer_cents) ?? num(match.employerCents) ?? num(match.employer) ?? 0;
  return { code: plan.pretaxCode, planId: plan.id, employeeCents: employee, employerCents: employer };
}
function safeJson<T>(s: string | null): T | null { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } }

export interface WorldSnapshot {
  rates: Map<string, PayRateRow[]>;
  profiles: Map<string, typeof taxProfiles.$inferSelect>;
  banks: Map<string, BankRow[]>;
  enrollments: Map<string, EnrollmentRow[]>;
  plans: Map<string, PlanRow>;
  employerRates: (typeof employerTaxRates.$inferSelect)[];
  accounts: (typeof taxAccounts.$inferSelect)[];
  time: Map<string, (typeof timeEntries.$inferSelect)[]>;
}

const group = <T, K>(rows: T[], key: (r: T) => K) => { const m = new Map<K, T[]>(); for (const r of rows) { const a = m.get(key(r)); if (a) a.push(r); else m.set(key(r), [r]); } return m; };

export async function loadWorld(tx: DbTx, companyId: string, workerIds: string[]): Promise<WorldSnapshot> {
  const ids = workerIds.length ? workerIds : ["__none__"];
  const [rates, profiles, banks, enrollments, plans, ers, accounts, time] = await Promise.all([
    tx.select().from(payRates).where(inArray(payRates.workerId, ids)),
    tx.select().from(taxProfiles).where(inArray(taxProfiles.workerId, ids)),
    tx.select().from(bankAccounts).where(inArray(bankAccounts.workerId, ids)),
    tx.select().from(benefitEnrollments).where(inArray(benefitEnrollments.workerId, ids)),
    tx.select().from(benefitPlans).where(eq(benefitPlans.companyId, companyId)),
    tx.select().from(employerTaxRates).where(eq(employerTaxRates.companyId, companyId)),
    tx.select().from(taxAccounts).where(eq(taxAccounts.companyId, companyId)),
    tx.select().from(timeEntries).where(inArray(timeEntries.workerId, ids)),
  ]);
  return {
    rates: group(rates, (r) => r.workerId), profiles: new Map(profiles.map((p) => [p.workerId, p])), banks: group(banks, (b) => b.workerId),
    enrollments: group(enrollments, (e) => e.workerId), plans: new Map(plans.map((p) => [p.id, p])), employerRates: ers, accounts, time: group(time, (t) => t.workerId),
  };
}

export function activeBank(world: WorldSnapshot, workerId: string): BankRow | null {
  const rows = (world.banks.get(workerId) ?? []).filter((b) => b.status === "active").sort((a, b) => (a.id < b.id ? 1 : -1));
  return rows[0] ?? null;
}

/** YTD per code for a worker and year, summed over every ledger source except `excludeSources`. */
export async function loadYtd(tx: DbTx, workerIds: string[], year: number, excludeSources: string[] = []): Promise<Map<string, Record<string, number>>> {
  const rows = workerIds.length ? await tx.select().from(ytdLedger).where(and(inArray(ytdLedger.workerId, workerIds), eq(ytdLedger.year, year))) : [];
  const out = new Map<string, Record<string, number>>();
  for (const r of rows) {
    if (excludeSources.includes(r.source)) continue;
    const m = out.get(r.workerId) ?? {};
    m[r.code] = (m[r.code] ?? 0) + r.amountCents;
    out.set(r.workerId, m);
  }
  return out;
}

export interface ComputeOptions { tables?: TaxTables; defaultHoursX100?: number | null; ytdOverride?: Map<string, Record<string, number>> }

/** Computes one worker's paycheck for the period from the snapshot. Pure given its inputs. */
export function computeWorkerPaycheck(w: WorkerRow, p: PeriodSpec, world: WorldSnapshot, ytd: Record<string, number>, opts: ComputeOptions = {}): ComputedPaycheck {
  const t = opts.tables ?? TAX_2026;
  const rates = world.rates.get(w.id) ?? [];
  const rate = rateOn(rates, p.periodEnd) ?? rateOn(rates, p.periodStart) ?? ([...rates].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))[0] ?? null);
  let earnings: EarningJson[] = [];
  let hoursX100: number | null = null;
  let prorated: ComputedPaycheck["prorated"] = null;
  if (rate?.kind === "hourly") {
    const entry = (world.time.get(w.id) ?? []).find((e) => e.periodStart === p.periodStart && e.periodEnd === p.periodEnd);
    hoursX100 = entry ? entry.regularHoursX100 + entry.overtimeHoursX100 : (opts.defaultHoursX100 ?? 0);
    earnings = hourlyEarnings(rate.amountCents, hoursX100, t);
  } else if (rate) {
    const g = salaryGross(rate.amountCents, w, p);
    prorated = g.prorated;
    earnings = [{ type: "salary", amountCents: g.cents, hoursX100: null }];
  }
  const gross = earnings.reduce((s, e) => s + e.amountCents, 0);
  const enrolls = (world.enrollments.get(w.id) ?? [])
    .filter((e) => e.status === "active" && e.effectiveFrom <= p.periodEnd && (e.effectiveTo === null || e.effectiveTo >= p.periodStart))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const benefits: BenefitJson[] = [];
  const pretax: { code: string; amount_cents: number }[] = [];
  for (const e of enrolls) {
    const plan = world.plans.get(e.planId);
    if (!plan) continue;
    const b = benefitAmounts(plan, e, gross);
    benefits.push({ planId: b.planId, employeeCents: b.employeeCents, employerCents: b.employerCents });
    if (b.employeeCents > 0) pretax.push({ code: b.code, amount_cents: b.employeeCents });
  }
  const profile = world.profiles.get(w.id);
  const state = w.workState ?? "CA";
  const input: PaycheckInput = {
    payDate: p.payday, payPeriodsPerYear: SEMIMONTHLY_PERIODS, jurisdiction: state, earnings: earnings.map((e) => ({ type: e.type as "salary", amount_cents: e.amountCents, hours_x100: e.hoursX100 })),
    pretax, posttax: [], reimbursements_cents: 0, w4: w4Of(profile),
    state: { filingStatus: profile?.stateFilingStatus ?? null, allowances: profile?.stateAllowances ?? 0 },
    ytd, employerRates: { sui: employerRateOn(world.employerRates, state, "sui", p.payday), ett: state === "CA" ? employerRateOn(world.employerRates, state, "ett", p.payday) : null },
  };
  const calc = calculatePaycheck(input, t);
  return {
    workerId: w.id, worker: w, rate, hoursX100, earnings, benefits, calc, reimbursementsCents: 0,
    deductions: pretax.map((d) => ({ code: d.code, pretax: true, amountCents: d.amount_cents })),
    bank: activeBank(world, w.id), hasW4: profile !== undefined, stateRegistered: stateRegistered(world.accounts, state), prorated,
  };
}

export async function computePeriod(tx: DbTx, p: PeriodSpec, opts: ComputeOptions & { excludeYtdSources?: string[] } = {}): Promise<ComputedPaycheck[]> {
  const ws = await eligibleWorkers(tx, p);
  const ids = ws.map((w) => w.id);
  const world = await loadWorld(tx, p.companyId, ids);
  const ytd = opts.ytdOverride ?? (await loadYtd(tx, ids, Number(p.payday.slice(0, 4)), opts.excludeYtdSources ?? []));
  return ws.map((w) => computeWorkerPaycheck(w, p, world, ytd.get(w.id) ?? {}, opts));
}

export async function scheduleFrequency(tx: DbTx, payScheduleId: string): Promise<string | null> {
  const r = await tx.select().from(paySchedules).where(eq(paySchedules.id, payScheduleId));
  return r[0]?.frequency ?? null;
}
