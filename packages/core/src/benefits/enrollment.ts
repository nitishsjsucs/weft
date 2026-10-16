// Open enrollment for the next plan year (wave 2, GP11). Owner: w2-benefits-contractors. One open_enrollment row per
// eligible employee (active or onboarding, no end date); the chase routine nudges the ones who have not elected.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { OpenEnrollmentStatus } from "@weft/contracts";
import { openEnrollment, workers, type DbTx } from "@weft/db";

export const OPEN_ENROLLMENT_PLAN_YEAR = 2027;
export const OPEN_ENROLLMENT_DEADLINE = "2026-11-13";
export type OpenEnrollmentRow = typeof openEnrollment.$inferSelect;
export interface OpenEnrollmentDto { id: string; workerId: string; name: string; planYear: number; status: OpenEnrollmentStatus; nudges: number; lastNudgedAt: string | null; electedAt: string | null }

/** Deterministic seed status from the worker number: most elected, some waived, a few in progress or not started. */
export function seedEnrollmentStatus(n: number): OpenEnrollmentStatus {
  if (n % 6 === 0) return "not_started";
  if (n % 9 === 0) return "in_progress";
  if (n % 10 === 0) return "waived";
  return "elected";
}

export async function eligibleForOpenEnrollment(tx: DbTx, companyId: string) {
  return (await tx.select().from(workers).where(and(eq(workers.companyId, companyId), eq(workers.type, "employee"))).orderBy(asc(workers.id)))
    .filter((w) => (w.status === "active" || w.status === "onboarding") && w.endDate === null);
}

export async function listOpenEnrollment(tx: DbTx, companyId: string, opts: { planYear?: number; status?: string } = {}): Promise<OpenEnrollmentDto[]> {
  const people = await tx.select({ id: workers.id, first: workers.firstName, last: workers.lastName }).from(workers).where(eq(workers.companyId, companyId));
  if (people.length === 0) return [];
  const names = new Map(people.map((p) => [p.id, `${p.first} ${p.last} (demo)`]));
  const conds = [inArray(openEnrollment.workerId, people.map((p) => p.id)), eq(openEnrollment.planYear, opts.planYear ?? OPEN_ENROLLMENT_PLAN_YEAR)];
  if (opts.status) conds.push(eq(openEnrollment.status, opts.status));
  const rows = await tx.select().from(openEnrollment).where(and(...conds)).orderBy(asc(openEnrollment.workerId));
  return rows.map((r) => ({ id: r.id, workerId: r.workerId, name: names.get(r.workerId) ?? r.workerId, planYear: r.planYear, status: r.status as OpenEnrollmentStatus, nudges: r.nudges, lastNudgedAt: r.lastNudgedAt, electedAt: r.electedAt }));
}

/** Rows of people who still have to choose (not_started or in_progress). */
export async function openEnrollmentStragglers(tx: DbTx, companyId: string, planYear = OPEN_ENROLLMENT_PLAN_YEAR): Promise<OpenEnrollmentDto[]> {
  return (await listOpenEnrollment(tx, companyId, { planYear })).filter((r) => r.status === "not_started" || r.status === "in_progress");
}

/** Records one nudge per row (sim clock time). */
export async function recordNudges(tx: DbTx, ids: string[], now: string): Promise<void> {
  for (const id of ids) {
    const row = (await tx.select().from(openEnrollment).where(eq(openEnrollment.id, id)))[0];
    if (row) await tx.update(openEnrollment).set({ nudges: row.nudges + 1, lastNudgedAt: now }).where(eq(openEnrollment.id, id));
  }
}
