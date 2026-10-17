// Life events and enrollment windows (wave 4, T6, T5, R9). Owner: w4-parity-people.
// A life event the employee reports opens one special enrollment window (rules.ts). Reminders follow the window's
// dates and stop the moment the employee elects; the date sweep closes windows past their close date, expiring the
// life event when nobody elected. The note the employee typed is their own words: it is stored and shown to people,
// never put in an email, a reminder or anything an agent reads.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { EnrollmentWindow, EnrollmentWindowKind, EnrollmentWindowStatus, LifeEventKind, LifeEventStatus } from "@weft/contracts";
import { carrierSubmissions, enrollmentWindows, lifeEvents, principals, workers, type DbTx } from "@weft/db";
import { displayName } from "../people/names";
import { lifeEventRule, reminderDates, type WindowBasis } from "./rules";

export type LifeEventRow = typeof lifeEvents.$inferSelect;
export type WindowRow = typeof enrollmentWindows.$inferSelect;

export interface LifeEventDto {
  id: string; workerId: string; name: string; kind: LifeEventKind; label: string; eventDate: string; status: LifeEventStatus;
  reportedAt: string; reportedBy: string; windowId: string | null; opensOn: string | null; closesOn: string | null;
  basis: WindowBasis; citation: string; source: string;
}
/** The note is kept out of the agent-facing DTO; people read it on the Benefits windows tab (noteFor). */
export interface WindowDto extends EnrollmentWindow { name: string | null; lifeEventKind: LifeEventKind | null; source: string | null; citation: string | null; nextReminderOn: string | null }

/** The worker a human principal acts as (the portal persona or a manager), or null. */
export async function workerOfPrincipal(tx: DbTx, companyId: string, principalId: string): Promise<string | null> {
  const [p] = await tx.select({ workerId: principals.workerId }).from(principals).where(and(eq(principals.id, principalId), eq(principals.companyId, companyId))).limit(1);
  return p?.workerId ?? null;
}

async function names(tx: DbTx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.select({ id: workers.id, first: workers.firstName, last: workers.lastName }).from(workers).where(inArray(workers.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, displayName(r.first, r.last)]));
}

export function toWindowDto(w: WindowRow, ev: LifeEventRow | undefined, name: string | null): WindowDto {
  const rule = ev ? lifeEventRule(ev.kind as LifeEventKind) : null;
  const reportedOn = ev ? ev.reportedAt.slice(0, 10) : w.createdAt.slice(0, 10);
  const next = w.status === "open" && w.kind !== "open_enrollment" && (!ev || ev.status === "window_open") ? reminderDates(w.closesOn, reportedOn)[w.remindersSent] ?? null : null;
  return {
    id: w.id, workerId: w.workerId, kind: w.kind as EnrollmentWindowKind, lifeEventId: w.lifeEventId, opensOn: w.opensOn, closesOn: w.closesOn,
    status: w.status as EnrollmentWindowStatus, remindersSent: w.remindersSent, createdAt: w.createdAt,
    name, lifeEventKind: (ev?.kind as LifeEventKind | undefined) ?? null, source: rule?.source ?? null, citation: rule?.citation ?? null, nextReminderOn: next,
  };
}

export async function listLifeEvents(tx: DbTx, companyId: string, f: { workerId?: string; status?: string } = {}): Promise<LifeEventDto[]> {
  const people = await tx.select({ id: workers.id }).from(workers).where(eq(workers.companyId, companyId));
  if (people.length === 0) return [];
  const conds = [inArray(lifeEvents.workerId, f.workerId ? [f.workerId] : people.map((p) => p.id))];
  if (f.status) conds.push(eq(lifeEvents.status, f.status));
  const rows = await tx.select().from(lifeEvents).where(and(...conds)).orderBy(asc(lifeEvents.id));
  const wins = rows.some((r) => r.windowId) ? await tx.select().from(enrollmentWindows).where(inArray(enrollmentWindows.id, rows.flatMap((r) => (r.windowId ? [r.windowId] : [])))) : [];
  const n = await names(tx, rows.map((r) => r.workerId));
  return rows.map((r) => {
    const rule = lifeEventRule(r.kind as LifeEventKind);
    const w = wins.find((x) => x.id === r.windowId);
    return {
      id: r.id, workerId: r.workerId, name: n.get(r.workerId) ?? r.workerId, kind: r.kind as LifeEventKind, label: rule.label, eventDate: r.eventDate,
      status: r.status as LifeEventStatus, reportedAt: r.reportedAt, reportedBy: r.reportedBy, windowId: r.windowId, opensOn: w?.opensOn ?? null, closesOn: w?.closesOn ?? null,
      basis: rule.basis, citation: rule.citation, source: rule.source,
    };
  });
}

export async function listWindows(tx: DbTx, companyId: string, f: { workerId?: string; kind?: string; status?: string } = {}): Promise<WindowDto[]> {
  const conds = [eq(enrollmentWindows.companyId, companyId)];
  if (f.workerId) conds.push(eq(enrollmentWindows.workerId, f.workerId));
  if (f.kind) conds.push(eq(enrollmentWindows.kind, f.kind));
  if (f.status) conds.push(eq(enrollmentWindows.status, f.status));
  const rows = await tx.select().from(enrollmentWindows).where(and(...conds)).orderBy(asc(enrollmentWindows.id));
  const evIds = rows.flatMap((r) => (r.lifeEventId ? [r.lifeEventId] : []));
  const evs = evIds.length ? await tx.select().from(lifeEvents).where(inArray(lifeEvents.id, evIds)) : [];
  const n = await names(tx, rows.flatMap((r) => (r.workerId ? [r.workerId] : [])));
  return rows.map((w) => toWindowDto(w, evs.find((e) => e.id === w.lifeEventId), w.workerId ? n.get(w.workerId) ?? w.workerId : null));
}

/** The employee's own note on a life event, for the people who read it in Weft (never an agent or an email). */
export async function noteFor(tx: DbTx, lifeEventId: string): Promise<string> {
  const [r] = await tx.select({ note: lifeEvents.note }).from(lifeEvents).where(eq(lifeEvents.id, lifeEventId)).limit(1);
  return r?.note ?? "";
}

export interface ReminderDue { window_id: string; worker_id: string; name: string; life_event_id: string; kind: LifeEventKind; closes_on: string; reminder_on: string; sets_sent_to: number }

/**
 * Reminders due on asOf: open life-event windows whose employee has not elected, where the next reminder date has
 * come and the window has not closed. sets_sent_to skips any dates a missed run passed, so one email goes out.
 */
export async function remindersDue(tx: DbTx, companyId: string, asOf: string): Promise<ReminderDue[]> {
  const wins = await tx.select().from(enrollmentWindows).where(and(eq(enrollmentWindows.companyId, companyId), eq(enrollmentWindows.kind, "life_event"), eq(enrollmentWindows.status, "open"))).orderBy(asc(enrollmentWindows.id));
  if (wins.length === 0) return [];
  const evs = await tx.select().from(lifeEvents).where(inArray(lifeEvents.id, wins.flatMap((w) => (w.lifeEventId ? [w.lifeEventId] : []))));
  const n = await names(tx, wins.flatMap((w) => (w.workerId ? [w.workerId] : [])));
  const out: ReminderDue[] = [];
  for (const w of wins) {
    const ev = evs.find((e) => e.id === w.lifeEventId);
    if (!ev || !w.workerId || ev.status !== "window_open" || asOf > w.closesOn) continue;
    const dates = reminderDates(w.closesOn, ev.reportedAt.slice(0, 10));
    const passed = dates.filter((d) => d <= asOf).length;
    if (passed <= w.remindersSent) continue;
    out.push({ window_id: w.id, worker_id: w.workerId, name: n.get(w.workerId) ?? w.workerId, life_event_id: ev.id, kind: ev.kind as LifeEventKind, closes_on: w.closesOn, reminder_on: dates[passed - 1]!, sets_sent_to: passed });
  }
  return out;
}

export interface SweepPlan { to_open: { window_id: string; kind: string; opens_on: string }[]; to_close: { window_id: string; kind: string; closes_on: string; worker_id: string | null; life_event_id: string | null }[] }

/** The date sweep: scheduled windows whose open date has come, and open windows past their close date. */
export async function sweepPlan(tx: DbTx, companyId: string, asOf: string): Promise<SweepPlan> {
  const rows = await tx.select().from(enrollmentWindows).where(and(eq(enrollmentWindows.companyId, companyId), inArray(enrollmentWindows.status, ["scheduled", "open"]))).orderBy(asc(enrollmentWindows.id));
  return {
    to_open: rows.filter((w) => w.status === "scheduled" && w.opensOn <= asOf && asOf <= w.closesOn).map((w) => ({ window_id: w.id, kind: w.kind, opens_on: w.opensOn })),
    to_close: rows.filter((w) => w.closesOn < asOf).map((w) => ({ window_id: w.id, kind: w.kind, closes_on: w.closesOn, worker_id: w.workerId, life_event_id: w.lifeEventId })),
  };
}

export const reminderEmail = (name: string, kind: LifeEventKind, eventDate: string, closesOn: string) => ({
  subject: `Your benefits window closes ${closesOn}`,
  body: `Hi ${name},\n\nYou reported a life event (${lifeEventRule(kind).label.toLowerCase()} on ${eventDate}), so you can change your benefits until ${closesOn}. Open the Weft portal to make your changes, or tell us you want no change.\n\nThank you,\nLarkspur Robotics people team (sent by the Weft agent)`,
});

export async function submissionsFor(tx: DbTx, f: { workerIds?: string[]; status?: string; windowId?: string }) {
  const conds = [];
  if (f.workerIds) conds.push(inArray(carrierSubmissions.workerId, f.workerIds.length ? f.workerIds : ["-"]));
  if (f.status) conds.push(eq(carrierSubmissions.status, f.status));
  if (f.windowId) conds.push(eq(carrierSubmissions.windowId, f.windowId));
  return tx.select().from(carrierSubmissions).where(conds.length ? and(...conds) : undefined).orderBy(asc(carrierSubmissions.id));
}
