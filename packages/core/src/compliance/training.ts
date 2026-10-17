// Required training (wave 4 T11). Owner: w4-parity-compliance. The course rules carry their statute source; who must
// take which course is decided in code from the work state and whether anyone reports to the person.
//
// - California, Gov. Code 12950.1: employers with 5 or more employees train supervisors for 2 hours and everyone else
//   for 1 hour, within six months of hire or promotion and once every two years after that.
// - New York, Labor Law 201-g: every employee, every year. The statute sets no deadline for new hires; Weft uses 30 days.
// - Illinois, 775 ILCS 5/2-109: every employee, at least once a year. Weft uses 30 days for new hires.
// Status is recomputed from the date when read: an open assignment past its due date is overdue.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { TrainingCourseCode } from "@weft/contracts";
import { trainingAssignments, trainingCourses, workers, type DbTx } from "@weft/db";

export interface CourseRule {
  code: TrainingCourseCode; title: string; jurisdiction: string; audience: "supervisors" | "staff" | "all"; minutes: number;
  dueWithinDays: number; repeatMonths: number; sourceUrl: string; basis: string;
}

export const COURSE_RULES: readonly CourseRule[] = [
  { code: "ca_harassment_supervisor", title: "California harassment prevention for supervisors", jurisdiction: "CA", audience: "supervisors", minutes: 120, dueWithinDays: 183, repeatMonths: 24,
    sourceUrl: "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=GOV&sectionNum=12950.1", basis: "Gov. Code 12950.1: 2 hours within six months of hire or promotion, then every two years" },
  { code: "ca_harassment_staff", title: "California harassment prevention", jurisdiction: "CA", audience: "staff", minutes: 60, dueWithinDays: 183, repeatMonths: 24,
    sourceUrl: "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=GOV&sectionNum=12950.1", basis: "Gov. Code 12950.1: 1 hour within six months of hire, then every two years" },
  { code: "ny_harassment", title: "New York sexual harassment prevention", jurisdiction: "NY", audience: "all", minutes: 60, dueWithinDays: 30, repeatMonths: 12,
    sourceUrl: "https://www.nysenate.gov/legislation/laws/LAB/201-G", basis: "Labor Law 201-g: interactive training every year; 30 days for new hires is Weft's default" },
  { code: "il_harassment", title: "Illinois sexual harassment prevention", jurisdiction: "IL", audience: "all", minutes: 60, dueWithinDays: 30, repeatMonths: 12,
    sourceUrl: "https://www.ilga.gov/legislation/ilcs/fulltext.asp?DocName=077500050K2-109", basis: "775 ILCS 5/2-109: at least once a year; 30 days for new hires is Weft's default" },
];
export const RULE_BY_CODE: Readonly<Record<string, CourseRule>> = Object.fromEntries(COURSE_RULES.map((r) => [r.code, r]));

export function addDays(d: string, n: number): string {
  const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10);
}
export function addMonths(d: string, n: number): string {
  const t = new Date(`${d}T12:00:00Z`); t.setUTCMonth(t.getUTCMonth() + n); return t.toISOString().slice(0, 10);
}

/** Inserts the course rows a company is missing (idempotent). Returns the rows by code. */
export async function ensureCourses(tx: DbTx, companyId: string, newId: (p: "trc_") => Promise<string>): Promise<Map<string, typeof trainingCourses.$inferSelect>> {
  const have = new Map((await tx.select().from(trainingCourses).where(eq(trainingCourses.companyId, companyId))).map((c) => [c.code, c]));
  for (const r of COURSE_RULES) {
    if (have.has(r.code)) continue;
    const row = { id: await newId("trc_"), companyId, code: r.code, title: r.title, jurisdiction: r.jurisdiction, audience: r.audience, minutes: r.minutes, dueWithinDays: r.dueWithinDays, repeatMonths: r.repeatMonths, sourceUrl: r.sourceUrl };
    await tx.insert(trainingCourses).values(row);
    have.set(r.code, row);
  }
  return have;
}

type WorkerRow = typeof workers.$inferSelect;
export type AssignmentRow = typeof trainingAssignments.$inferSelect;

/** The courses a worker must take: by work state, and supervisor or staff in California. Employees only. */
export function requiredCourses(w: Pick<WorkerRow, "id" | "workState" | "type" | "status">, supervisors: ReadonlySet<string>): CourseRule[] {
  if (w.type !== "employee" || !["active", "onboarding"].includes(w.status)) return [];
  return COURSE_RULES.filter((r) => r.jurisdiction === w.workState && (r.audience === "all" || (r.audience === "supervisors") === supervisors.has(w.id)));
}

export function effectiveStatus(a: Pick<AssignmentRow, "status" | "dueOn">, today: string): string {
  if (a.status === "completed" || a.status === "waived") return a.status;
  return a.dueOn < today ? "overdue" : a.status;
}

export interface AssignmentView {
  id: string; workerId: string; workerName: string; courseId: string; courseCode: string; courseTitle: string; jurisdiction: string | null; minutes: number;
  dueOn: string; status: string; daysLeft: number; assignedAt: string; remindedAt: string | null; completedAt: string | null; certificateUploadId: string | null; sourceUrl: string;
}

const days = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

export async function listAssignments(tx: DbTx, companyId: string, today: string, f: { workerId?: string; status?: string; courseCode?: string } = {}): Promise<AssignmentView[]> {
  const courses = await tx.select().from(trainingCourses).where(eq(trainingCourses.companyId, companyId));
  if (!courses.length) return [];
  const byId = new Map(courses.map((c) => [c.id, c]));
  const rows = await tx.select().from(trainingAssignments).where(inArray(trainingAssignments.courseId, courses.map((c) => c.id))).orderBy(asc(trainingAssignments.id));
  const ws = new Map((await tx.select({ id: workers.id, first: workers.firstName, last: workers.lastName, preferred: workers.preferredName }).from(workers).where(eq(workers.companyId, companyId))).map((w) => [w.id, w]));
  return rows.map((a) => {
    const c = byId.get(a.courseId)!;
    const w = ws.get(a.workerId);
    return {
      id: a.id, workerId: a.workerId, workerName: w ? `${w.first} ${w.last}` : a.workerId, courseId: c.id, courseCode: c.code, courseTitle: c.title, jurisdiction: c.jurisdiction, minutes: c.minutes,
      dueOn: a.dueOn, status: effectiveStatus(a, today), daysLeft: days(today, a.dueOn), assignedAt: a.assignedAt, remindedAt: a.remindedAt, completedAt: a.completedAt,
      certificateUploadId: a.certificateUploadId, sourceUrl: c.sourceUrl,
    };
  }).filter((a) => (!f.workerId || a.workerId === f.workerId) && (!f.status || a.status === f.status) && (!f.courseCode || a.courseCode === f.courseCode));
}

export interface MissingAssignment { worker_id: string; worker_name: string; course_code: TrainingCourseCode; due_on: string; why: "new_hire" | "recurrence" }

/**
 * Who needs an assignment now: a required course with no open assignment, either never taken (due from the start
 * date, or 30 days from today when that is already past) or last completed long enough ago that the next cycle is
 * due within 30 days.
 */
export async function missingAssignments(tx: DbTx, companyId: string, today: string): Promise<MissingAssignment[]> {
  const ws = await tx.select().from(workers).where(eq(workers.companyId, companyId)).orderBy(asc(workers.id));
  const supervisors = new Set(ws.map((w) => w.managerId).filter((x): x is string => !!x));
  const views = await listAssignments(tx, companyId, today);
  const out: MissingAssignment[] = [];
  for (const w of ws) {
    for (const r of requiredCourses(w, supervisors)) {
      const mine = views.filter((a) => a.workerId === w.id && a.courseCode === r.code);
      if (mine.some((a) => a.status !== "completed" && a.status !== "waived")) continue;
      const last = mine.filter((a) => a.completedAt).map((a) => a.completedAt!.slice(0, 10)).sort().at(-1);
      if (!last) {
        const due = addDays(w.startDate, r.dueWithinDays);
        out.push({ worker_id: w.id, worker_name: `${w.firstName} ${w.lastName}`, course_code: r.code, due_on: due < today ? addDays(today, 30) : due, why: "new_hire" });
      } else {
        const next = addMonths(last, r.repeatMonths);
        if (next <= addDays(today, 30)) out.push({ worker_id: w.id, worker_name: `${w.firstName} ${w.lastName}`, course_code: r.code, due_on: next < today ? addDays(today, 30) : next, why: "recurrence" });
      }
    }
  }
  return out;
}

export async function getAssignment(tx: DbTx, id: string): Promise<AssignmentRow | null> {
  const [a] = await tx.select().from(trainingAssignments).where(and(eq(trainingAssignments.id, id))).limit(1);
  return a ?? null;
}
