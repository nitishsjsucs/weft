// Time-off reads and ledger writes over the wave 3 tables (research/wave3/expenses-timeoff.md 6). Owner: w3-timeoff.
// Pure rules live in ./engine; this module loads rows, derives balances, coverage and routing, and appends ledger rows.
import { and, eq, inArray, sql } from "drizzle-orm";
import { COVERAGE_DEFAULTS, type IdPrefix, type TimeOffBalance, type TimeOffTypeKind, type W3Check } from "@weft/contracts";
import {
  departments, holidays, holidayCalendars, offers, principals, timeOffAssignments, timeOffLedger, timeOffPolicies, timeOffRequests, timeOffTypes, workers, workplaces, type DbTx,
} from "@weft/db";
import { addDays, businessDaysBefore, isBusinessDay } from "../payroll/calendar";
import {
  balanceOf, coverageDays, paydayOf, perPeriodMinutes, periodEndsBetween, postedBalance, requestChecks, serviceMonths, unlockDate,
  type CoverageDay, type LedgerEntry, type RequestDay, type Tier,
} from "./engine";

export type PolicyRow = typeof timeOffPolicies.$inferSelect & { typeKind: TimeOffTypeKind; typeName: string; paid: boolean; countsAsVacation: boolean };
export type AssignmentRow = typeof timeOffAssignments.$inferSelect;
export type RequestRow = typeof timeOffRequests.$inferSelect;
export type LedgerRow = typeof timeOffLedger.$inferSelect;
type WorkerRow = typeof workers.$inferSelect;

export const OPEN_STATUSES = ["pending", "approved"] as const;

export async function loadPolicies(tx: DbTx, companyId: string): Promise<PolicyRow[]> {
  const rows = await tx.select({ p: timeOffPolicies, t: timeOffTypes }).from(timeOffPolicies).innerJoin(timeOffTypes, eq(timeOffTypes.id, timeOffPolicies.typeId)).where(eq(timeOffPolicies.companyId, companyId));
  return rows.map(({ p, t }) => ({ ...p, typeKind: t.kind as TimeOffTypeKind, typeName: t.name, paid: t.paid, countsAsVacation: t.countsAsVacation })).sort((a, b) => (a.id < b.id ? -1 : 1));
}

export async function policyById(tx: DbTx, companyId: string, id: string): Promise<PolicyRow | null> {
  return (await loadPolicies(tx, companyId)).find((p) => p.id === id) ?? null;
}

export const tiersOf = (p: PolicyRow): Tier[] => { try { return JSON.parse(p.tiersJson) as Tier[]; } catch { return []; } };

export async function assignmentsOf(tx: DbTx, workerIds: string[]): Promise<AssignmentRow[]> {
  if (!workerIds.length) return [];
  return (await tx.select().from(timeOffAssignments).where(inArray(timeOffAssignments.workerId, workerIds))).sort((a, b) => (a.id < b.id ? -1 : 1));
}

export async function ledgerOf(tx: DbTx, workerId: string, policyId?: string): Promise<LedgerRow[]> {
  const rows = await tx.select().from(timeOffLedger).where(policyId ? and(eq(timeOffLedger.workerId, workerId), eq(timeOffLedger.policyId, policyId)) : eq(timeOffLedger.workerId, workerId));
  return rows.sort((a, b) => (a.effectiveDate === b.effectiveDate ? (a.id < b.id ? -1 : 1) : a.effectiveDate < b.effectiveDate ? -1 : 1));
}

export async function holidayMap(tx: DbTx, companyId: string): Promise<Map<string, string>> {
  const rows = await tx.select({ date: holidays.date, name: holidays.name }).from(holidays).innerJoin(holidayCalendars, eq(holidayCalendars.id, holidays.calendarId)).where(eq(holidayCalendars.companyId, companyId));
  return new Map(rows.map((r) => [r.date, r.name]));
}

export async function workerOf(tx: DbTx, companyId: string, id: string): Promise<WorkerRow | null> {
  const [w] = await tx.select().from(workers).where(and(eq(workers.id, id), eq(workers.companyId, companyId))).limit(1);
  return w ?? null;
}

export const displayName = (w: Pick<WorkerRow, "firstName" | "lastName" | "preferredName">) => `${w.preferredName ?? w.firstName} ${w.lastName} (demo)`;

/** Whether the worker is employed on `date` (an employee whose start and end bracket it). */
export const employedOn = (w: Pick<WorkerRow, "startDate" | "endDate" | "type">, date: string) => w.type === "employee" && w.startDate <= date && (w.endDate === null || w.endDate >= date);

export async function balanceFor(tx: DbTx, w: WorkerRow, p: PolicyRow, asOf: string): Promise<TimeOffBalance> {
  const rows = await ledgerOf(tx, w.id, p.id);
  return balanceOf({ workerId: w.id, policyId: p.id, typeKind: p.typeKind, asOf, rows, startDate: w.startDate, waitingDays: p.waitingDaysBeforeUse });
}

/** Per-pay-period accrual on `periodEnd` for this worker, by completed months of service. */
export function periodAccrual(p: PolicyRow, w: Pick<WorkerRow, "startDate">, periodEnd: string): number {
  if (p.schedule !== "per_pay_period") return 0;
  return perPeriodMinutes(p.minutesPerPeriod, tiersOf(p), serviceMonths(w.startDate, periodEnd));
}

/** Available at the start date: today's available plus one per-period accrual for each run paid by then. */
export function projectAvailable(available: number, p: PolicyRow, w: Pick<WorkerRow, "startDate" | "endDate">, today: string, startDate: string): number {
  if (p.schedule !== "per_pay_period") return available;
  let out = available;
  for (const end of periodEndsBetween(addDays(today, -16), addDays(startDate, 16))) {
    const payday = paydayOf(end);
    if (payday > today && payday <= startDate && (w.endDate === null || w.endDate >= end)) out += periodAccrual(p, w, end);
  }
  return out;
}

/** Department headcount on a date: employees employed then, plus incoming hires from open offers starting by then. */
export async function headcountFn(tx: DbTx, companyId: string, departmentId: string): Promise<(date: string) => number> {
  const ws = await tx.select().from(workers).where(and(eq(workers.companyId, companyId), eq(workers.departmentId, departmentId)));
  const os = await tx.select().from(offers).where(and(eq(offers.companyId, companyId), eq(offers.departmentId, departmentId)));
  const incoming = os.filter((o) => ["sent", "viewed", "accepted"].includes(o.status) && !o.workerId);
  return (date) => ws.filter((w) => employedOn(w, date) && w.status !== "inactive").length + incoming.filter((o) => o.startDate <= date).length;
}

export const parseDays = (r: Pick<RequestRow, "daysJson">): RequestDay[] => { try { return JSON.parse(r.daysJson) as RequestDay[]; } catch { return []; } };

/** Pending and approved requests by the department's workers that touch [from, to]. */
export async function departmentOutRequests(tx: DbTx, companyId: string, departmentId: string, from: string, to: string): Promise<RequestRow[]> {
  const rows = await tx.select({ r: timeOffRequests }).from(timeOffRequests).innerJoin(workers, eq(workers.id, timeOffRequests.workerId))
    .where(and(eq(timeOffRequests.companyId, companyId), eq(workers.departmentId, departmentId), inArray(timeOffRequests.status, [...OPEN_STATUSES])));
  return rows.map((x) => x.r).filter((r) => r.startAt.slice(0, 10) <= to && r.endAt.slice(0, 10) >= from).sort((a, b) => (a.id < b.id ? -1 : 1));
}

export async function departmentOf(tx: DbTx, companyId: string, id: string) {
  const [d] = await tx.select().from(departments).where(and(eq(departments.id, id), eq(departments.companyId, companyId))).limit(1);
  return d ?? null;
}

export async function teamCoverage(tx: DbTx, companyId: string, departmentId: string, from: string, to: string): Promise<{ headcount: number; days: CoverageDay[] }> {
  const dept = await departmentOf(tx, companyId, departmentId);
  const hc = await headcountFn(tx, companyId, departmentId);
  const hol = await holidayMap(tx, companyId);
  const reqs = await departmentOutRequests(tx, companyId, departmentId, from, to);
  const dates: string[] = [];
  for (let d = from; d <= to && dates.length < 93; d = addDays(d, 1)) dates.push(d);
  const days = coverageDays({
    dates, headcountOn: hc, holidays: hol, out: reqs.map((r) => ({ workerId: r.workerId, requestId: r.id, status: r.status, days: parseDays(r) })),
    maxOutPct: dept?.coverageMaxOutPct ?? COVERAGE_DEFAULTS.maxOutPct, minPresent: dept?.coverageMinPresent ?? COVERAGE_DEFAULTS.minPresent,
  });
  return { headcount: hc(from), days };
}

// ------------------------------------------------------------------ routing

export interface RouteStep { principalId: string | null; why: string }
const ADMIN_FALLBACK = "usr_dana";

/** The approver: the manager's principal when that manager is an active worker with a Weft login, else the
 * department lead's, else the People admin. Every step is recorded with its reason. */
export async function routeRequest(tx: DbTx, companyId: string, w: WorkerRow): Promise<{ approver: string; chain: RouteStep[] }> {
  const chain: RouteStep[] = [];
  const humanFor = async (workerId: string) => {
    const [p] = await tx.select().from(principals).where(and(eq(principals.companyId, companyId), eq(principals.workerId, workerId), eq(principals.kind, "human"))).limit(1);
    return p ?? null;
  };
  const tryWorker = async (workerId: string | null, label: string): Promise<string | null> => {
    if (!workerId || workerId === w.id) return null;
    const m = await workerOf(tx, companyId, workerId);
    if (!m) { chain.push({ principalId: null, why: `${label} ${workerId} is not in this company` }); return null; }
    if (m.status !== "active") { chain.push({ principalId: null, why: `${label} ${displayName(m)} is ${m.status}, skipped` }); return null; }
    const p = await humanFor(m.id);
    if (!p) { chain.push({ principalId: null, why: `${label} ${displayName(m)} has no Weft login` }); return null; }
    chain.push({ principalId: p.id, why: `${label} ${displayName(m)} decides` });
    return p.id;
  };
  const viaManager = await tryWorker(w.managerId, "Manager");
  if (viaManager) return { approver: viaManager, chain };
  const dept = w.departmentId ? await departmentOf(tx, companyId, w.departmentId) : null;
  if (dept?.leadWorkerId && dept.leadWorkerId !== w.managerId) {
    const viaLead = await tryWorker(dept.leadWorkerId, `${dept.name} lead`);
    if (viaLead) return { approver: viaLead, chain };
  }
  chain.push({ principalId: ADMIN_FALLBACK, why: "People admin decides (no manager or lead with a login)" });
  return { approver: ADMIN_FALLBACK, chain };
}

// ------------------------------------------------------------------ checks for one request

export async function checksForRequest(tx: DbTx, companyId: string, r: RequestRow, today: string): Promise<W3Check[]> {
  const w = await workerOf(tx, companyId, r.workerId);
  const p = await policyById(tx, companyId, r.policyId);
  if (!w || !p) return [];
  const days = parseDays(r);
  const start = r.startAt.slice(0, 10), end = r.endAt.slice(0, 10);
  const rows = await ledgerOf(tx, w.id, p.id);
  // The request's own hold is not counted against itself.
  const own = rows.filter((x) => x.sourceRef !== r.id);
  const bal = balanceOf({ workerId: w.id, policyId: p.id, typeKind: p.typeKind, asOf: today, rows: own, startDate: w.startDate, waitingDays: p.waitingDaysBeforeUse });
  const unlock = unlockDate(w.startDate, p.waitingDaysBeforeUse);
  const year = start.slice(0, 4);
  const usedThisYear = -own.filter((x) => x.kind === "use" && x.effectiveDate.startsWith(year)).reduce((s, x) => s + x.minutes, 0);
  const coverage = w.departmentId ? (await teamCoverage(tx, companyId, w.departmentId, start, end)).days : null;
  const deadlineOverlap = await payrollDeadlineOverlap(tx, companyId, w, days);
  const partial = days.length === 1 && days[0]!.minutes > 0 && days[0]!.minutes < 480 ? days[0]!.minutes : null;
  return requestChecks({
    typeKind: p.typeKind, today, startDate: start, days, requestedMinutes: r.requestedMinutes,
    projectedAvailable: projectAvailable(bal.availableMinutes, p, w, today, start),
    locked: start < unlock ? { until: unlock } : null, usedThisYear, annualUseCap: p.annualUseCapMinutes, minIncrement: p.minIncrementMinutes,
    partialDayMinutes: partial, coverage, requestId: r.id, deadlineOverlap,
  });
}

/** Approval deadlines (two business days before payday) the requester is out on, when the requester approves payroll. */
async function payrollDeadlineOverlap(tx: DbTx, companyId: string, w: WorkerRow, days: RequestDay[]): Promise<string[]> {
  const [p] = await tx.select().from(principals).where(and(eq(principals.companyId, companyId), eq(principals.workerId, w.id))).limit(1);
  if (!p) return [];
  let grants: Record<string, string> = {};
  try { grants = JSON.parse(p.grantsJson) as Record<string, string>; } catch { /* none */ }
  if (grants.payroll !== "approve") return [];
  const out: string[] = [];
  for (const d of days) {
    if (d.minutes === 0) continue;
    for (const end of periodEndsBetween(addDays(d.date, -1), addDays(d.date, 20))) {
      const deadline = businessDaysBefore(paydayOf(end), 2);
      if (deadline === d.date && isBusinessDay(d.date)) out.push(d.date);
    }
  }
  return [...new Set(out)];
}

// ------------------------------------------------------------------ ledger writes

export async function appendLedger(tx: DbTx, newId: (p: "tol_") => Promise<string>, row: Omit<typeof timeOffLedger.$inferInsert, "id">): Promise<string | null> {
  if (row.runKey) {
    const [dup] = await tx.select({ id: timeOffLedger.id }).from(timeOffLedger).where(eq(timeOffLedger.runKey, row.runKey)).limit(1);
    if (dup) return null;
  }
  const id = await newId("tol_");
  await tx.insert(timeOffLedger).values({ id, ...row });
  return id;
}

const NYC_CITIES = new Set(["New York", "New York City", "Brooklyn", "Manhattan", "Queens", "Bronx", "The Bronx", "Staten Island"]);

/** Whether a policy's jurisdiction covers a worker: US for every employee, a state code for that work state, and
 * NY-NYC for a New York worker unless the workplace is a known city outside New York City. A remote New York worker
 * gets the NYC policies: they meet the state minimums too, and Larkspur has no separate New York State sick policy. */
export function policyApplies(jurisdiction: string, workState: string | null, workplaceCity: string | null): boolean {
  if (jurisdiction === "US") return true;
  if (!workState) return false;
  if (jurisdiction === workState) return true;
  if (jurisdiction === "NY-NYC") return workState === "NY" && (workplaceCity === null || NYC_CITIES.has(workplaceCity));
  return false;
}

/** An employee hired after the seed (Noor on offer acceptance) has no assignments yet: assign the policies their
 * work state and workplace call for, effective from the later of the start date and the policy's, and post the
 * on-hire front loads. Runs only for an employee with no assignment at all, so it never touches seeded workers. */
export async function ensureAssignments(tx: DbTx, newId: (p: IdPrefix) => Promise<string>, w: WorkerRow, now: string): Promise<number> {
  if (w.type !== "employee") return 0;
  if ((await assignmentsOf(tx, [w.id])).length) return 0;
  const [place] = w.workplaceId ? await tx.select({ city: workplaces.city }).from(workplaces).where(eq(workplaces.id, w.workplaceId)).limit(1) : [];
  let n = 0;
  for (const p of await loadPolicies(tx, w.companyId)) {
    if (!policyApplies(p.jurisdiction, w.workState, place?.city ?? null)) continue;
    if (p.effectiveTo !== null && p.effectiveTo < w.startDate) continue;
    const from = w.startDate > p.effectiveFrom ? w.startDate : p.effectiveFrom;
    const id = await newId("tasn_");
    await tx.insert(timeOffAssignments).values({ id, policyId: p.id, workerId: w.id, assignedAt: now, effectiveFrom: from, effectiveTo: w.endDate, accrualRemainderMinutes: 0 });
    n++;
    if (p.schedule === "front_load_annual" && p.frontLoadMinutes) {
      await appendLedger(tx, newId, { assignmentId: id, workerId: w.id, policyId: p.id, kind: "front_load", minutes: p.frontLoadMinutes, effectiveDate: from, sourceRef: null, runKey: `front:hire:${id}`, note: `front load on hire for ${from.slice(0, 4)}`, actionSeq: null, createdAt: now });
    }
  }
  return n;
}

export async function assignmentFor(tx: DbTx, workerId: string, policyId: string): Promise<AssignmentRow | null> {
  const [a] = await tx.select().from(timeOffAssignments).where(and(eq(timeOffAssignments.workerId, workerId), eq(timeOffAssignments.policyId, policyId))).limit(1);
  return a ?? null;
}

/** The vacation-kind policy assigned to a worker, with its posted balance on `asOf` (final pay). */
export async function vacationPosition(tx: DbTx, workerId: string, asOf: string): Promise<{ policy: PolicyRow; postedMinutes: number } | null> {
  const [w] = await tx.select().from(workers).where(eq(workers.id, workerId)).limit(1);
  if (!w) return null;
  const pols = (await loadPolicies(tx, w.companyId)).filter((p) => p.countsAsVacation && p.payOutAtSeparation);
  const assigned = new Set((await assignmentsOf(tx, [workerId])).map((a) => a.policyId));
  const p = pols.find((x) => assigned.has(x.id));
  if (!p) return null;
  return { policy: p, postedMinutes: postedBalance(await ledgerOf(tx, workerId, p.id), asOf) };
}

export async function maxSeq(tx: DbTx): Promise<number> {
  const rows = await tx.all<{ n: number | null }>(sql`SELECT MAX(seq) AS n FROM actions`);
  return rows[0]?.n ?? 0;
}
