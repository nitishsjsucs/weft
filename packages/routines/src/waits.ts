// Wait and resume (G6, R14; docs/wave4.md). Owner: w4-parity-agent.
// A checklist item may declare one wait (ChecklistItemW4.wait). The model never decides to wait: when a run segment
// ends with that item still failing, the engine opens a routine_waits row and parks the routine run in
// waiting_event. The engine resumes it once when the event arrives (or the time is reached), follows up on a
// schedule while it waits, and expires it after its timeout. Each resume or follow-up is a new agent run segment
// started from the checklist, so the agent loop and its telemetry are untouched.
import { randomBytes } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { RoutineWaitSpec, type ChecklistItemW4, type RoutineDef, type RoutineWait, type RoutineWaitKind, type RoutineWaitStatus, type WeftEvent } from "@weft/contracts";
import { routineWaits, type Db } from "@weft/db";
import { lockedWrite } from "./busy";
import { expand } from "./checks";

export const DAY_MS = 86_400_000;
export const addDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY_MS).toISOString();

/** The checklist items of a routine that declare a valid wait, with the spec parsed. */
export function waitItems(routine: Pick<RoutineDef, "checklist">): (ChecklistItemW4 & { wait: RoutineWaitSpec })[] {
  const out: (ChecklistItemW4 & { wait: RoutineWaitSpec })[] = [];
  for (const item of routine.checklist as ChecklistItemW4[]) {
    if (!item.wait) continue;
    const spec = RoutineWaitSpec.safeParse(item.wait);
    if (spec.success) out.push({ ...item, wait: spec.data });
  }
  return out;
}

/** The event a wait listens for: a decision wait listens for proposal.decided unless it names another event. */
export function waitEvent(spec: RoutineWaitSpec): string | null {
  if (spec.kind === "until") return null;
  return spec.event ?? (spec.kind === "proposal" ? "proposal.decided" : null);
}

type WaitRow = typeof routineWaits.$inferSelect;
export const toWait = (r: WaitRow): RoutineWait => ({
  id: r.id, routineRunId: r.routineRunId, checklistItemId: r.checklistItemId, kind: r.kind as RoutineWaitKind, event: r.event, subjectRef: r.subjectRef,
  untilAt: r.untilAt, status: r.status as RoutineWaitStatus, followUps: r.followUps, createdAt: r.createdAt, resumedAt: r.resumedAt,
});

export async function waitsOf(db: Db, routineRunId: string): Promise<WaitRow[]> {
  return db.select().from(routineWaits).where(eq(routineWaits.routineRunId, routineRunId)).orderBy(asc(routineWaits.createdAt), asc(routineWaits.id));
}

export async function openWaitsOf(db: Db, routineRunId: string): Promise<WaitRow[]> {
  return (await waitsOf(db, routineRunId)).filter((w) => w.status === "waiting");
}

/**
 * Opens a wait for a failing item, unless one is already open for that item (a follow-up segment ending with the item
 * still open keeps the first wait and its clock). untilAt is the timeout for event and decision waits, and the time to
 * resume for an until wait.
 */
export async function openWait(db: Db, now: string, input: { routineRunId: string; item: ChecklistItemW4 & { wait: RoutineWaitSpec }; scope: Record<string, unknown> }): Promise<WaitRow> {
  const open = (await openWaitsOf(db, input.routineRunId)).find((w) => w.checklistItemId === input.item.id);
  if (open) return open;
  const spec = input.item.wait;
  const row: WaitRow = {
    id: `rwt_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`, routineRunId: input.routineRunId, checklistItemId: input.item.id, kind: spec.kind,
    event: waitEvent(spec), subjectRef: spec.subjectRefTemplate ? expand(spec.subjectRefTemplate, input.scope) || null : null,
    untilAt: addDays(now, spec.timeoutDays), status: "waiting", followUps: 0,
    nextFollowUpAt: spec.followUpEveryDays && spec.kind !== "until" ? addDays(now, spec.followUpEveryDays) : null, createdAt: now, resumedAt: null,
  };
  await lockedWrite(() => db.insert(routineWaits).values(row));
  return row;
}

/** An event satisfies a wait when the type matches and the subject is the event's subject or one of its payload ids. */
export function matchesEvent(w: Pick<WaitRow, "status" | "kind" | "event" | "subjectRef">, evt: Pick<WeftEvent, "type" | "subjectRef" | "payload">): boolean {
  if (w.status !== "waiting" || w.kind === "until" || !w.event || w.event !== evt.type) return false;
  if (!w.subjectRef) return true;
  return evt.subjectRef === w.subjectRef || Object.values(evt.payload ?? {}).some((v) => v === w.subjectRef);
}

/** Moves a wait out of waiting exactly once (compare and set on status), so a second event never resumes it twice. */
export async function settleWait(db: Db, id: string, status: "resumed" | "expired" | "cancelled", now: string): Promise<boolean> {
  const res = await lockedWrite(() => db.run(sql`UPDATE routine_waits SET status = ${status}, resumed_at = ${status === "resumed" ? now : null}, next_follow_up_at = NULL WHERE id = ${id} AND status = 'waiting'`));
  return Number((res as { rowsAffected?: number }).rowsAffected ?? 0) > 0;
}

/** Counts one follow-up and schedules the next, guarded by the count read, so one slot never follows up twice. */
export async function bumpFollowUp(db: Db, w: WaitRow, everyDays: number, now: string): Promise<boolean> {
  const next = addDays(w.nextFollowUpAt ?? now, everyDays);
  const res = await lockedWrite(() => db.run(sql`UPDATE routine_waits SET follow_ups = follow_ups + 1, next_follow_up_at = ${next} WHERE id = ${w.id} AND status = 'waiting' AND follow_ups = ${w.followUps}`));
  return Number((res as { rowsAffected?: number }).rowsAffected ?? 0) > 0;
}

/** Waits whose time has come at `now`: timeouts (and until waits to resume) first, then follow-ups due. */
export async function dueWaits(db: Db, now: string): Promise<{ timedOut: WaitRow[]; followUps: WaitRow[] }> {
  const open = await db.select().from(routineWaits).where(eq(routineWaits.status, "waiting")).orderBy(asc(routineWaits.createdAt), asc(routineWaits.id));
  const timedOut = open.filter((w) => w.untilAt !== null && w.untilAt <= now);
  const gone = new Set(timedOut.map((w) => w.id));
  return { timedOut, followUps: open.filter((w) => !gone.has(w.id) && w.nextFollowUpAt !== null && w.nextFollowUpAt <= now) };
}

/** Open waits listening for an event type (the event loop's candidates). */
export async function waitsForEvent(db: Db, type: string): Promise<WaitRow[]> {
  return db.select().from(routineWaits).where(and(eq(routineWaits.status, "waiting"), eq(routineWaits.event, type))).orderBy(asc(routineWaits.createdAt), asc(routineWaits.id));
}

/** The derived text of a segment: `<reason>_text` from the precheck when it has one, with {follow_ups} filled in. */
export function segmentText(derived: Record<string, unknown>, reason: "resumed" | "follow_up", followUps: number): string | null {
  const t = derived[`${reason}_text`];
  return typeof t === "string" ? t.replaceAll("{follow_ups}", String(followUps)) : null;
}
