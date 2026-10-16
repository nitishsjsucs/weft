// Time-off rules as pure functions (research/wave3/expenses-timeoff.md 6.1 to 6.4). Owner: w3-timeoff.
// Every amount is integer minutes; paychecks convert to hours_x100 only at the payroll boundary. Balances are always
// derived from the append-only ledger and never stored.
import type { TimeOffBalance, TimeOffLedgerKind, TimeOffTypeKind, W3Check } from "@weft/contracts";
import { MINUTES_PER_DAY } from "@weft/contracts";
import { addDays, isBusinessDay, lastDayOfMonth, workingDays } from "../payroll/calendar";

export const DEEMED_MINUTES_PER_WEEK = 2_400;          // exempt workers are deemed to work 40 hours a week
export const FULL_PERIOD_DEEMED_MINUTES = 5_200;       // 2,400 * 52 / 24: one full semi-monthly period, 86.67 h
export const SHORT_NOTICE_DAYS = 7;

// ------------------------------------------------------------------ ledger rows and balances

export interface LedgerEntry { kind: TimeOffLedgerKind | string; minutes: number; effectiveDate: string }
const ACCRUED_KINDS = new Set(["import", "accrual", "front_load", "adjustment", "reinstatement", "carryover_forfeit", "payout"]);

export interface BalanceParts { accrued: number; used: number; holds: number }

/** Sums the ledger as of `asOf`: accrued (unlocked or locked), used (use rows on or before asOf) and holds
 * (pending holds plus approved use rows dated after asOf). */
export function sumLedger(rows: readonly LedgerEntry[], asOf: string): BalanceParts {
  let accrued = 0, used = 0, holds = 0;
  for (const r of rows) {
    if (ACCRUED_KINDS.has(r.kind)) { if (r.effectiveDate <= asOf) accrued += r.minutes; }
    else if (r.kind === "use") { if (r.effectiveDate <= asOf) used -= r.minutes; else holds -= r.minutes; }
    else if (r.kind === "hold" || r.kind === "hold_release") holds -= r.minutes;
  }
  return { accrued, used, holds };
}

/** The first date the policy's accruals may be used: start date plus the waiting period. */
export function unlockDate(startDate: string, waitingDays: number): string {
  return waitingDays > 0 ? addDays(startDate, waitingDays) : startDate;
}

export function balanceOf(input: { workerId: string; policyId: string; typeKind: TimeOffTypeKind; asOf: string; rows: readonly LedgerEntry[]; startDate: string; waitingDays: number }): TimeOffBalance {
  const p = sumLedger(input.rows, input.asOf);
  const locked = input.asOf < unlockDate(input.startDate, input.waitingDays);
  const accruedUnlocked = locked ? 0 : p.accrued;
  return {
    workerId: input.workerId, policyId: input.policyId, typeKind: input.typeKind, asOf: input.asOf,
    accruedUnlockedMinutes: accruedUnlocked, accruedLockedMinutes: locked ? p.accrued : 0, usedMinutes: p.used, holdsMinutes: p.holds,
    availableMinutes: accruedUnlocked - p.used - p.holds,
  };
}

/**
 * Available on a request's start date as far as the waiting period goes: minutes locked today count once the start
 * date is past the unlock date (spec 6.1), so a request filed inside the wait for a date after it is not starved.
 */
export function availableOn(b: TimeOffBalance, startDate: string, unlock: string): number {
  return startDate >= unlock ? b.accruedUnlockedMinutes + b.accruedLockedMinutes - b.usedMinutes - b.holdsMinutes : b.availableMinutes;
}

/** Accrued minus used, ignoring holds and the lock: what final pay and the caps see. */
export function postedBalance(rows: readonly LedgerEntry[], asOf: string): number {
  const p = sumLedger(rows, asOf);
  return p.accrued - p.used;
}

// ------------------------------------------------------------------ accrual engines

export interface Tier { min_service_months: number; minutes_per_period: number }

/** Completed calendar months of service from `startDate` through `onDate`. */
export function serviceMonths(startDate: string, onDate: string): number {
  const [sy, sm, sd] = startDate.split("-").map(Number) as [number, number, number];
  const [oy, om, od] = onDate.split("-").map(Number) as [number, number, number];
  let months = (oy - sy) * 12 + (om - sm);
  if (od < sd) months--;
  return Math.max(0, months);
}

/** Per pay period: the tier whose min_service_months is the largest one at or below the service months. */
export function perPeriodMinutes(base: number | null, tiers: readonly Tier[], months: number): number {
  const t = [...tiers].sort((a, b) => b.min_service_months - a.min_service_months).find((x) => months >= x.min_service_months);
  return t ? t.minutes_per_period : base ?? 0;
}

/** Per hour worked: floor((remainder + worked) / chunk) * perChunk; the rest carries as the new remainder. */
export function perHourWorked(remainder: number, workedMinutes: number, workedPerChunk = 30, minutesPerChunk = 1): { minutes: number; remainder: number } {
  const total = remainder + workedMinutes;
  return { minutes: Math.floor(total / workedPerChunk) * minutesPerChunk, remainder: total % workedPerChunk };
}

/** Deemed worked minutes for an exempt salaried worker: a full period is 5,200; a partial one is 2,400 per 5 weekdays employed. */
export function deemedWorkedMinutes(period: { periodStart: string; periodEnd: string }, startDate: string, endDate: string | null, perWeek = DEEMED_MINUTES_PER_WEEK): number {
  const from = startDate > period.periodStart ? startDate : period.periodStart;
  const to = endDate && endDate < period.periodEnd ? endDate : period.periodEnd;
  if (from > to) return 0;
  if (from === period.periodStart && to === period.periodEnd) return Math.round((perWeek * 52) / 24);
  return Math.floor((perWeek * workingDays(from, to)) / 5);
}

/** Caps: post min(accrual, cap - balance) and min(that, annualCap - accrued this year); the rest is capped (noted, 0 minutes). */
export function applyCaps(accrual: number, c: { balance: number; cap: number | null; accruedThisYear: number; annualCap: number | null }): { posted: number; capped: number } {
  let posted = accrual;
  if (c.cap !== null) posted = Math.min(posted, Math.max(0, c.cap - c.balance));
  if (c.annualCap !== null) posted = Math.min(posted, Math.max(0, c.annualCap - c.accruedThisYear));
  posted = Math.max(0, posted);
  return { posted, capped: accrual - posted };
}

/** Year end: carry min(balance, cap) (null cap carries everything); the rest is forfeited. */
export function yearEndCarry(balance: number, carryoverCap: number | null): { carry: number; forfeit: number } {
  if (balance <= 0 || carryoverCap === null) return { carry: balance, forfeit: 0 };
  const carry = Math.min(balance, carryoverCap);
  return { carry, forfeit: balance - carry };
}

export interface PolicyShape { jurisdiction: string; typeKind: TimeOffTypeKind; accrualCapMinutes: number | null; carryoverCapMinutes: number | null }
/** CA and CO vested-vacation rule: a vacation policy may cap accrual but may not forfeit below its accrual cap. */
export function forfeitureProblem(p: PolicyShape): string | null {
  if (p.typeKind !== "vacation" || !["CA", "CA-Oakland", "CO"].includes(p.jurisdiction) || p.carryoverCapMinutes === null) return null;
  if (p.accrualCapMinutes === null || p.carryoverCapMinutes < p.accrualCapMinutes) {
    return `A ${p.jurisdiction} vacation policy cannot forfeit earned vacation at year end (carryover cap ${p.carryoverCapMinutes} is below the accrual cap ${p.accrualCapMinutes ?? "none"})`;
  }
  return null;
}

// ------------------------------------------------------------------ requests

export interface RequestDay { date: string; minutes: number; holiday: boolean }

/** Minutes per day from the dates: weekdays are 480 (or the partial-day minutes on a one-day request), company
 * holidays and weekends are 0. The employee never types an amount. */
export function requestDays(startDate: string, endDate: string, holidays: ReadonlyMap<string, string>, partialDayMinutes: number | null = null): { days: RequestDay[]; minutes: number } {
  const days: RequestDay[] = [];
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
    if (!isBusinessDay(d)) continue;
    const holiday = holidays.has(d);
    const minutes = holiday ? 0 : partialDayMinutes !== null && startDate === endDate ? partialDayMinutes : MINUTES_PER_DAY;
    days.push({ date: d, minutes, holiday });
  }
  return { days, minutes: days.reduce((s, x) => s + x.minutes, 0) };
}

/** The semi-monthly period ends strictly after `from` and on or before `through` (one per-period accrual each). */
export function periodEndsBetween(from: string, through: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  for (let i = 0; i < 40; i++) {
    for (const d of [15, lastDayOfMonth(y, m)]) {
      const end = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (end > from && end <= through) out.push(end);
    }
    m++; if (m > 12) { m = 1; y++; }
    if (`${y}-${String(m).padStart(2, "0")}-01` > through) break;
  }
  return out;
}

/** Payday of the run whose period ends on `periodEnd`: the period end moved back to a business day. */
export function paydayOf(periodEnd: string): string {
  let d = periodEnd;
  while (!isBusinessDay(d)) d = addDays(d, -1);
  return d;
}

export interface CoverageDay { date: string; out: { workerId: string; requestId: string; status: string }[]; headcount: number; outPct: number; overLimit: boolean; holiday: string | null }

/** Share of the department out on each working day: over the percent limit, or fewer than minPresent left. */
export function coverageDays(input: {
  dates: readonly string[]; headcountOn: (date: string) => number; holidays: ReadonlyMap<string, string>;
  out: readonly { workerId: string; requestId: string; status: string; days: readonly RequestDay[] }[]; maxOutPct: number; minPresent: number;
}): CoverageDay[] {
  return input.dates.map((date) => {
    const holiday = input.holidays.get(date) ?? null;
    const outOn = holiday || !isBusinessDay(date) ? [] : input.out.filter((r) => r.days.some((d) => d.date === date && d.minutes > 0)).map((r) => ({ workerId: r.workerId, requestId: r.requestId, status: r.status }));
    const unique = [...new Map(outOn.map((o) => [o.workerId, o])).values()];
    const headcount = input.headcountOn(date);
    const outPct = headcount > 0 ? Math.round((unique.length * 1000) / headcount) / 10 : 0;
    const overLimit = unique.length > 0 && (unique.length * 100 > input.maxOutPct * headcount || headcount - unique.length < input.minPresent);
    return { date, out: unique, headcount, outPct, overLimit, holiday };
  });
}

export interface CheckInput {
  typeKind: TimeOffTypeKind; today: string; startDate: string; days: readonly RequestDay[]; requestedMinutes: number;
  projectedAvailable: number; locked: { until: string } | null; usedThisYear: number; annualUseCap: number | null; minIncrement: number;
  partialDayMinutes: number | null; coverage: readonly CoverageDay[] | null; requestId: string; deadlineOverlap: string[];
}

const ev = (label: string, ref: string) => ({ label, ref });
const h = (m: number) => `${(m / 60).toFixed(2)} h`;

/** The eight deterministic checks, in the paycheck flag shape (block, review, info). */
export function requestChecks(c: CheckInput): W3Check[] {
  const out: W3Check[] = [];
  if (c.locked) {
    out.push({ rule: "WAITING_PERIOD", severity: "block", message: `This leave is usable from ${c.locked.until}, after the waiting period; ${c.startDate} is inside it`, evidence: [ev("usable from", c.locked.until)] });
  }
  if (!c.locked && c.requestedMinutes > c.projectedAvailable) {
    out.push({ rule: "INSUFFICIENT_BALANCE", severity: "block", message: `Requests ${h(c.requestedMinutes)} but the projected balance on ${c.startDate} is ${h(c.projectedAvailable)}`, evidence: [ev("projected available", h(c.projectedAvailable))] });
  }
  if (c.annualUseCap !== null && c.usedThisYear + c.requestedMinutes > c.annualUseCap) {
    out.push({ rule: "USE_CAP", severity: "block", message: `Would use ${h(c.usedThisYear + c.requestedMinutes)} this year, over the ${h(c.annualUseCap)} cap`, evidence: [ev("used this year", h(c.usedThisYear))] });
  }
  if (c.partialDayMinutes !== null && c.partialDayMinutes < c.minIncrement) {
    out.push({ rule: "INCREMENT", severity: "block", message: `A partial day must be at least ${h(c.minIncrement)}`, evidence: [] });
  }
  const conflicts = (c.coverage ?? []).filter((d) => d.overLimit && d.out.some((o) => o.requestId === c.requestId));
  if (conflicts.length) {
    const others = [...new Set(conflicts.flatMap((d) => d.out.filter((o) => o.requestId !== c.requestId).map((o) => o.requestId)))].sort();
    const worst = conflicts[0]!;
    out.push({
      rule: "COVERAGE_CONFLICT", severity: "review",
      message: `${worst.out.length} of ${worst.headcount} out (${worst.outPct.toFixed(1)}%) on ${conflicts.map((d) => d.date).join(", ")}`,
      evidence: [...conflicts.map((d) => ev(d.date, `${d.out.length} of ${d.headcount}`)), ...others.map((r) => ev("also out", r))],
    });
  }
  if (c.deadlineOverlap.length) {
    out.push({ rule: "OVERLAPS_PAYROLL_DEADLINE", severity: "review", message: `Out on a payroll approval deadline: ${c.deadlineOverlap.join(", ")}`, evidence: c.deadlineOverlap.map((d) => ev("deadline", d)) });
  }
  const hol = c.days.filter((d) => d.holiday);
  if (hol.length) out.push({ rule: "INCLUDES_HOLIDAY", severity: "info", message: `Includes company holidays ${hol.map((d) => d.date).join(", ")}, charged 0 h`, evidence: hol.map((d) => ev("holiday", d.date)) });
  const sickish = c.typeKind === "sick" || c.typeKind === "unpaid_sick" || c.typeKind === "prenatal";
  if (!sickish && c.startDate >= c.today && daysBetween(c.today, c.startDate) < SHORT_NOTICE_DAYS) {
    out.push({ rule: "SHORT_NOTICE", severity: "info", message: `Starts ${c.startDate}, under ${SHORT_NOTICE_DAYS} days ahead`, evidence: [] });
  }
  return out;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

// ------------------------------------------------------------------ final pay

/** Vacation paid at separation: the posted balance plus the final period's accrual prorated by calendar days
 * (floor(minutes_per_period * days employed / days in period)). A negative balance pays nothing. */
export function finalVacationMinutes(postedMinutes: number, minutesPerPeriod: number, period: { periodStart: string; periodEnd: string }, lastDay: string): { minutes: number; prorated: number; advanceNotRecovered: boolean } {
  const days = daysBetween(period.periodStart, period.periodEnd) + 1;
  const employed = Math.max(0, Math.min(days, daysBetween(period.periodStart, lastDay) + 1));
  const prorated = Math.floor((minutesPerPeriod * employed) / days);
  const total = postedMinutes + prorated;
  return total > 0 ? { minutes: total, prorated, advanceNotRecovered: false } : { minutes: 0, prorated, advanceNotRecovered: postedMinutes < 0 };
}

/** hours_x100 for a minute amount, at the payroll boundary. */
export const minutesToHoursX100 = (m: number) => Math.round((m * 100) / 60);
