// Open enrollment with a real open and close (wave 4 rank 3, T6). Owner: w4-parity-people.
// The company's open enrollment is one enrollment_windows row (kind open_enrollment, no worker) with its own open and
// close dates, in place of the wave 2 constant. The scheduler's date sweep (benefits.close_windows) opens it on its
// date and closes it after the close date; at the close, everyone who still had not chosen (the wave 2 rows that are
// not_started or in_progress) is closed out as waived, the active enrollment default, and listed by name.
// The plan year is the year after the close date (a November close is for the next January).
import { and, asc, eq, inArray } from "drizzle-orm";
import { enrollmentWindows, openEnrollment, type DbTx } from "@weft/db";
import { eligibleForOpenEnrollment, OPEN_ENROLLMENT_DEADLINE, OPEN_ENROLLMENT_PLAN_YEAR, openEnrollmentStragglers } from "../benefits/enrollment";

/** The longest open enrollment Weft will schedule; most employers run two to four weeks. */
export const OPEN_ENROLLMENT_MAX_DAYS = 60;
export const planYearOf = (closesOn: string) => Number(closesOn.slice(0, 4)) + 1;

export type WindowRow = typeof enrollmentWindows.$inferSelect;

/** The company's live (scheduled or open) open enrollment window, or null. */
export async function liveOpenEnrollment(tx: DbTx, companyId: string): Promise<WindowRow | null> {
  const rows = await tx.select().from(enrollmentWindows).where(and(eq(enrollmentWindows.companyId, companyId), eq(enrollmentWindows.kind, "open_enrollment"), inArray(enrollmentWindows.status, ["scheduled", "open"]))).orderBy(asc(enrollmentWindows.id));
  return rows[0] ?? null;
}

/**
 * The dates the wave 2 open enrollment chase should read: the live window when one exists, else the wave 2 constant.
 * (Contract request: packages/core/src/commands/benefits.ts reads this instead of OPEN_ENROLLMENT_DEADLINE.)
 */
export async function openEnrollmentDates(tx: DbTx, companyId: string): Promise<{ plan_year: number; opens_on: string | null; closes_on: string; window_id: string | null }> {
  const w = await liveOpenEnrollment(tx, companyId);
  return w ? { plan_year: planYearOf(w.closesOn), opens_on: w.opensOn, closes_on: w.closesOn, window_id: w.id } : { plan_year: OPEN_ENROLLMENT_PLAN_YEAR, opens_on: null, closes_on: OPEN_ENROLLMENT_DEADLINE, window_id: null };
}

/** Closes out the stragglers of a plan year as waived; returns who they were (names and ids only). */
export async function closeOutStragglers(tx: DbTx, companyId: string, planYear: number): Promise<{ worker_id: string; name: string; was: string }[]> {
  const rows = await openEnrollmentStragglers(tx, companyId, planYear);
  for (const r of rows) await tx.update(openEnrollment).set({ status: "waived" }).where(eq(openEnrollment.id, r.id));
  return rows.map((r) => ({ worker_id: r.workerId, name: r.name, was: r.status }));
}

/** Every eligible employee gets a not_started row for the plan year if they have none (the seed made 2027's). */
export async function ensureEnrollmentRows(tx: DbTx, companyId: string, planYear: number, newId: (prefix: "oen_") => Promise<string>): Promise<number> {
  const people = await eligibleForOpenEnrollment(tx, companyId);
  if (people.length === 0) return 0;
  const have = new Set((await tx.select({ w: openEnrollment.workerId }).from(openEnrollment).where(and(eq(openEnrollment.planYear, planYear), inArray(openEnrollment.workerId, people.map((p) => p.id))))).map((r) => r.w));
  let added = 0;
  for (const p of people) {
    if (have.has(p.id)) continue;
    await tx.insert(openEnrollment).values({ id: await newId("oen_"), workerId: p.id, planYear, status: "not_started", lastNudgedAt: null, nudges: 0, electedAt: null });
    added++;
  }
  return added;
}
