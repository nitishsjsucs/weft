// Routines engine (SPEC 9.7, harness 4.1, 4.3 and 8). tick(now) fires cron slots since the cursor (croner, in the
// routine's time zone), then unconsumed events in order. Each trigger gets a run key; a repeated key is a no-op. The
// precheck runs in code first: skip is recorded with zero tokens, run starts an agent run with derived arguments.
// Decisions wake the run through the checklist first, so a run whose checklist holds ends with zero tokens.
import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { Cron } from "croner";
import { agentRuns, routineRuns, routines, runSteps, type Db } from "@weft/db";
import { lockedWrite } from "./busy";
import type { AgentRuntime, PrecheckResult, ProposalDecided, ReadOnlyExecutor, RoutineDef, RoutineRun, RoutineRunAuthority, RoutineRunStatus, RoutinesEngine, SimClock, ToolOutcome, WeftEvent } from "@weft/contracts";
import { checklistFor, evaluateChecklist, type RunCall, type RunFacts } from "./checks";
import { agencyNoticePlanTools } from "./agency-notice";
import { PREBUILT, TZ } from "./prebuilt";
import { runPrecheck } from "./prechecks";
import { bumpFollowUp, dueWaits, matchesEvent, openWait, openWaitsOf, segmentText, settleWait, waitItems, waitsForEvent } from "./waits";

/** settings.notify.quiet_hours default (harness 8): digest-severity cron posts wait; event posts and the weekly digest never do. */
export const QUIET_HOURS = { start: "19:00", end: "07:00", tz: TZ };

export function inQuietHours(iso: string, q = QUIET_HOURS): boolean {
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: q.tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  return q.start > q.end ? hm >= q.start || hm < q.end : hm >= q.start && hm < q.end;
}

export function surfaceHash(findings: unknown): string {
  const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canon(findings ?? null))).digest("hex");
}

export interface EventSource {
  /** Events not yet consumed by the routines engine, in id order. */
  unconsumed(): Promise<WeftEvent[]>;
  consume(eventId: string): Promise<void>;
}

export interface CreateRoutinesOptions {
  db: Db; clock: SimClock; agent: AgentRuntime; runs: RoutineRunAuthority; readOnly: ReadOnlyExecutor;
  companyId?: string;
  events?: EventSource;
}

export interface WeftRoutinesEngine extends RoutinesEngine {
  /** For createAgentRuntime's routinesView. */
  view: {
    get(routineId: string): Promise<RoutineDef | null>;
    checklist(input: { routine: RoutineDef; agentRunId: string; routineRunId: string | null; companyId: string; trigger: Record<string, unknown> }): Promise<{ id: string; label: string; passed: boolean }[]>;
  };
  list(): Promise<RoutineDef[]>;
  /** Wave 3: last run and next cron slot per routine (the sim clock is the "from"). */
  overview(): Promise<RoutineOverview[]>;
  runs(routineId: string, limit?: number): Promise<RoutineRun[]>;
  getRun(routineRunId: string): Promise<RoutineRun | null>;
  ensurePrebuilt(): Promise<void>;
  /** After POST /v1/sim/reset: the world and the clock went back to the seed, so cron slots count from `at` again. */
  resetCursor(at: string): void;
  /** Fire one trigger now (tests and the scheduler use tick; this is the shared path). */
  fire(routine: RoutineDef, input: { triggerRef: string; payload: Record<string, unknown>; attended: boolean; event: WeftEvent | null; at?: string }): Promise<RoutineRun>;
  settled(routineRunId: string): Promise<RoutineRun>;
  /**
   * Waits for routine finalizations already in flight (each started when an agent run wrote its terminal step), up to
   * `timeoutMs`. weft.close() calls it with `closing` before closing the database, after which a late finalization
   * failure is dropped quietly. Resolves true when nothing was left pending.
   */
  drain(timeoutMs?: number, closing?: boolean): Promise<boolean>;
  /** Number of finalizations in flight (tests and the close drain). */
  pendingFinalizations(): number;
}

/** The next cron slot after `from` for an enabled cron routine (croner, in its time zone); null otherwise. */
export function nextRunAt(r: Pick<RoutineDef, "enabled" | "trigger">, from: string): string | null {
  if (!r.enabled || r.trigger.type !== "cron") return null;
  const c = new Cron(r.trigger.cron, { timezone: r.trigger.tz, paused: true });
  try { return c.nextRun(new Date(from))?.toISOString() ?? null; } catch { return null; } finally { c.stop(); }
}

/** One routine's last run and next run, for the routines list and gallery (wave 3 rank 11). */
export interface RoutineOverview { routineId: string; lastRun: { id: string; status: RoutineRunStatus; startedAt: string | null; summary: string | null } | null; nextRunAt: string | null }

/** Per-plan tool subsets, by routine id: a run is offered only the tools its derived plan needs (frozen at run start). */
const PLAN_TOOLS: Record<string, (plan: unknown) => readonly string[] | null> = { rt_agency_notice: agencyNoticePlanTools };

/**
 * The routine as one run sees it (wave 4 round 1): checklist items gated to another plan are left out, and a routine
 * with per-plan tools offers only that plan's subset of its own list. The stored row is unchanged.
 */
export function routineForRun(routine: RoutineDef, pre: PrecheckResult): RoutineDef {
  if (pre.action !== "run") return routine;
  const derived = pre.derivedArgs ?? {};
  const scope = Object.fromEntries(Object.entries(derived).filter(([, v]) => typeof v !== "object"));
  const subset = PLAN_TOOLS[routine.id]?.(derived.plan) ?? null;
  return { ...routine, tools: subset ? routine.tools.filter((t) => subset.includes(t)) : routine.tools, checklist: checklistFor(routine.checklist, scope) };
}

/** What a routine run that never started an agent run exports as its own span (wave 4 round 1, FM11). */
export interface RoutineRunTrace {
  routineId: string; routineRunId: string; triggerRef: string; attended: boolean; status: RoutineRunStatus; reason: string;
  precheck: string | null; event: string | null; at: string;
}
type TracingAgent = AgentRuntime & { traceRoutineRun?: (t: RoutineRunTrace) => void };

/** The code-owned fields of a prebuilt routine; enabled, autonomy and the owner stay whatever the company set. */
function codeOwned(r: RoutineDef) {
  return {
    name: r.name, description: r.description, instructions: r.instructions, triggerJson: JSON.stringify(r.trigger), filterJson: r.filter ? JSON.stringify(r.filter) : null,
    toolsJson: JSON.stringify(r.tools), precheck: r.precheck, checklistJson: JSON.stringify(r.checklist), budgetJson: JSON.stringify(r.budget), surfaceJson: JSON.stringify(r.surface), taintedBy: r.taintedBy,
  };
}

export function runKey(routineId: string, triggerRef: string): string {
  return createHash("sha256").update(JSON.stringify({ routine_id: routineId, trigger_ref: triggerRef })).digest("hex");
}

type RoutineSelect = typeof routines.$inferSelect;
type RunSelect = typeof routineRuns.$inferSelect;
const parse = <T>(s: string | null | undefined, d: T): T => { if (!s) return d; try { return JSON.parse(s) as T; } catch { return d; } };

function toDef(r: RoutineSelect): RoutineDef {
  return {
    id: r.id, name: r.name, description: r.description, ownerPrincipalId: r.ownerPrincipalId, enabled: Boolean(r.enabled), autonomy: r.autonomy as RoutineDef["autonomy"],
    trigger: parse(r.triggerJson, { type: "manual" } as RoutineDef["trigger"]), filter: parse(r.filterJson, null), instructions: r.instructions, tools: parse(r.toolsJson, []),
    precheck: r.precheck, checklist: parse(r.checklistJson, []), budget: parse(r.budgetJson, { steps: 6, usd: 0.1, minutes: 10 }), surface: parse(r.surfaceJson, { worthSurfacing: true, channel: null }),
    source: r.source as RoutineDef["source"], taintedBy: r.taintedBy,
  };
}

function toRun(r: RunSelect): RoutineRun {
  return {
    id: r.id, routineId: r.routineId, runKey: r.runKey, triggerRef: r.triggerRef, status: r.status as RoutineRunStatus, agentRunId: r.agentRunId,
    precheck: parse(r.precheckJson, null), summary: r.summary, leftForHuman: parse(r.leftForHumanJson, []), surfaceHash: r.surfaceHash, overdue: Boolean(r.overdue),
    attended: Boolean(r.attended), startedAt: r.startedAt, endedAt: r.endedAt, costUsdMicros: r.costUsdMicros,
  };
}

const TERMINAL_AGENT = new Set(["done", "failed", "refused", "escalated", "expired", "cancelled", "waiting"]);

export function createRoutines(opts: CreateRoutinesOptions): WeftRoutinesEngine {
  const { db, clock, agent, runs, readOnly } = opts;
  const companyId = opts.companyId ?? "cmp_larkspur";
  let cursor: string = clock.now();
  let seeded = false;
  const decisions = new Map<string, string>();
  const waiters = new Map<string, ((r: RoutineRun) => void)[]>();

  const pending = new Set<Promise<void>>();
  const watched = new Set<string>();
  let closing = false;
  const report = (e: unknown) => {
    // A finalization that lands after close() gave up (or after the database closed) is dropped, never unhandled.
    if (closing) return;
    console.error(`routines: finalization failed: ${String(e).slice(0, 300)}`);
  };
  /** Runs one finalization in the background, tracked for drain() and never left as an unhandled rejection. */
  const track = (job: () => Promise<void>) => {
    const p: Promise<void> = Promise.resolve().then(job).catch(report).finally(() => { pending.delete(p); });
    pending.add(p);
    return p;
  };
  /**
   * Finalizes the routine run when its agent run writes a terminal step. Idempotent per pair, so a rehydrated run is
   * watched once. The key holds the routine run id too, because POST /v1/sim/reset rebuilds the world and agent run
   * ids start over at run_0001 while routine run ids never repeat.
   */
  const watch = (routineRunId: string, agentRunId: string) => {
    const key = `${routineRunId}:${agentRunId}`;
    if (watched.has(key)) return;
    watched.add(key);
    agent.subscribe(agentRunId, (step) => {
      if (step.stage === "terminal") void track(() => finalizeFromAgent(routineRunId, agentRunId));
    });
  };

  const newId = () => `rtr_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

  async function ensurePrebuilt() {
    // POST /v1/sim/reset drops and rebuilds every table under a live engine, so a cached "already seeded" flag is
    // only trusted while the prebuilt rows are still there.
    if (seeded && (await db.select({ id: routines.id }).from(routines).where(eq(routines.id, PREBUILT[0]!.id)).limit(1)).length) return;
    seeded = true;
    const rows = new Map((await db.select().from(routines)).map((r) => [r.id, r]));
    for (const r of PREBUILT) {
      const row = rows.get(r.id);
      if (row) {
        // A prebuilt routine's definition is code: a database seeded by an older build gets the current tools,
        // checklist and instructions (rt_agency_notice gained its notice plans in wave 4 round 1), never a new
        // enabled flag or autonomy level.
        const want = codeOwned(r);
        const stale = row.source === "prebuilt" && (Object.keys(want) as (keyof typeof want)[]).some((k) => (row[k] ?? null) !== (want[k] ?? null));
        if (stale) await lockedWrite(() => db.update(routines).set(want).where(eq(routines.id, r.id)));
        continue;
      }
      await lockedWrite(() => db.insert(routines).values({
        id: r.id, companyId, name: r.name, description: r.description, ownerPrincipalId: r.ownerPrincipalId, enabled: r.enabled, autonomy: r.autonomy,
        triggerJson: JSON.stringify(r.trigger), filterJson: r.filter ? JSON.stringify(r.filter) : null, instructions: r.instructions, toolsJson: JSON.stringify(r.tools),
        precheck: r.precheck, checklistJson: JSON.stringify(r.checklist), budgetJson: JSON.stringify(r.budget), surfaceJson: JSON.stringify(r.surface), source: r.source,
        taintedBy: r.taintedBy, createdAt: clock.now(),
      }).onConflictDoNothing());
    }
  }

  async function list(): Promise<RoutineDef[]> {
    await ensurePrebuilt();
    return (await db.select().from(routines).orderBy(asc(routines.id))).map(toDef);
  }
  async function get(id: string): Promise<RoutineDef | null> {
    await ensurePrebuilt();
    const r = await db.select().from(routines).where(eq(routines.id, id)).limit(1);
    return r[0] ? toDef(r[0]) : null;
  }
  async function getRun(id: string): Promise<RoutineRun | null> {
    const r = await db.select().from(routineRuns).where(eq(routineRuns.id, id)).limit(1);
    return r[0] ? toRun(r[0]) : null;
  }
  async function updateRun(id: string, p: Partial<typeof routineRuns.$inferInsert>) {
    await lockedWrite(() => db.update(routineRuns).set(p).where(eq(routineRuns.id, id)));
    const row = await getRun(id);
    if (row && !["queued", "running"].includes(row.status)) {
      const ws = waiters.get(id) ?? [];
      waiters.delete(id);
      for (const w of ws) w(row);
    }
  }

  /**
   * The observed facts of one agent run, or (wave 4, waits) of every segment of its routine run: a resumed run's
   * checklist counts what the earlier segments already did, so asking twice is never needed to pass an item.
   */
  async function factsFor(agentRunId: string, routineRunId: string | null = null): Promise<RunFacts> {
    const segments = routineRunId ? (await db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.routineRunId, routineRunId)).orderBy(asc(agentRuns.createdAt))).map((r) => r.id) : [];
    const ids = segments.length > 1 ? segments : [agentRunId];
    const rows = [];
    for (const id of ids) rows.push(...await db.select().from(runSteps).where(and(eq(runSteps.runId, id), eq(runSteps.kind, "tool_call"))).orderBy(asc(runSteps.n)));
    const calls: RunCall[] = [];
    for (const r of rows) {
      const res = parse<{ outcome?: ToolOutcome } | null>(r.resultJson, null);
      const o = res?.outcome;
      if (!o) continue;
      calls.push({
        command: r.toolName ?? "", args: parse(r.toolArgsJson, null),
        status: !o.ok ? "refused" : o.status === "done" ? "done" : "pending_approval",
        proposalId: o.ok && o.status === "pending_approval" ? o.proposalId : null,
        data: o.ok && o.status === "done" ? o.data : null,
      });
    }
    // Decisions are read through the ReadOnlyExecutor (actions.get_run lists the run's proposals with their status),
    // so a restart does not forget a denial or an expiry; the in-memory map only covers the moment between a
    // decision callback and this read.
    const stored = new Map<string, string>();
    if (readOnly && calls.some((c) => c.proposalId)) {
      for (const id of ids) {
        const out = await readOnly.exec(companyId, "actions.get_run", { run_id: id }).catch(() => null);
        const listed = out && out.ok && out.status === "done" ? ((out.data as { proposals?: { id: string; status: string }[] } | null)?.proposals ?? []) : [];
        for (const p of listed) if (p.status !== "pending") stored.set(p.id, p.status);
      }
    }
    return { calls, proposalStatus: (id) => stored.get(id) ?? decisions.get(id) ?? null };
  }

  async function scopeOf(rr: RunSelect | undefined, trigger: Record<string, unknown>): Promise<Record<string, unknown>> {
    const pre = parse<PrecheckResult | null>(rr?.precheckJson, null);
    const derived = pre && pre.action === "run" ? (pre.derivedArgs ?? {}) : {};
    return { ...Object.fromEntries(Object.entries(derived).filter(([, v]) => typeof v !== "object")), ...trigger };
  }

  /** The real checklist of a routine run: every segment's facts, wait items evaluated like any other item. */
  async function realChecklist(routine: RoutineDef, rr: RunSelect, agentRunId: string, trigger: Record<string, unknown>) {
    return evaluateChecklist(routine, await scopeOf(rr, trigger), await factsFor(agentRunId, rr.id), { companyId, agentRunId, read: readOnly });
  }

  async function checklist(input: { routine: RoutineDef; agentRunId: string; companyId: string; trigger: Record<string, unknown> }) {
    const rr = (await db.select().from(routineRuns).where(eq(routineRuns.agentRunId, input.agentRunId)).limit(1))[0];
    const waiting = waitItems(input.routine);
    const items = await evaluateChecklist(input.routine, await scopeOf(rr, input.trigger), await factsFor(input.agentRunId, waiting.length && rr ? rr.id : null), { companyId: input.companyId, agentRunId: input.agentRunId, read: readOnly });
    if (!waiting.length) return items;
    // Wave 4: an item with a wait is the engine's to watch, not the model's to finish in this segment. The agent sees it
    // as handed over, so it ends the segment instead of being told to keep working on something only time can do.
    const w = new Set(waiting.map((x) => x.id));
    return items.map((i) => (w.has(i.id) && !i.passed ? { ...i, passed: true, label: `${i.label} (Weft waits for this after the run; nothing to do now)` } : i));
  }

  async function finalizeFromAgent(routineRunId: string, agentRunId: string) {
    const a = (await db.select().from(agentRuns).where(eq(agentRuns.id, agentRunId)).limit(1))[0];
    if (!a || !TERMINAL_AGENT.has(a.status)) return;
    const facts = await factsFor(agentRunId);
    // Wave 3 autonomy: at recommend every pending write is an Inbox suggestion (policy() and the pipeline enforce the
    // level per call); the run log says so instead of asking for an approval.
    const rr = (await db.select({ routineId: routineRuns.routineId }).from(routineRuns).where(eq(routineRuns.id, routineRunId)).limit(1))[0];
    const level = rr ? (await db.select({ autonomy: routines.autonomy }).from(routines).where(eq(routines.id, rr.routineId)).limit(1))[0]?.autonomy : null;
    const verb = level === "recommend" ? "Review the suggestion" : "Approve";
    const left = facts.calls.filter((c) => c.status === "pending_approval" && c.proposalId && facts.proposalStatus(c.proposalId) === null).map((c) => `${verb} ${c.command.replace("__", ".")} (${c.proposalId})`);
    let status: RoutineRunStatus = a.status === "waiting" ? "waiting_approval" : a.status === "done" ? "done" : a.status === "cancelled" ? "cancelled" : "failed";
    let summary = a.summary ?? null;
    // Wave 4 waits: a segment that ends done with a wait item still open parks the routine run in waiting_event.
    const full = rr ? (await db.select().from(routineRuns).where(eq(routineRuns.id, routineRunId)).limit(1))[0] : undefined;
    const routine = rr ? await get(rr.routineId) : null;
    const waiting = routine ? waitItems(routine) : [];
    if (full && routine && waiting.length && status === "done") {
      const trigger = await triggerOfSegment(agentRunId);
      const items = await realChecklist(routine, full, agentRunId, trigger);
      const open = waiting.filter((w) => items.find((i) => i.id === w.id)?.passed === false);
      if (open.length) {
        const scope = await scopeOf(full, trigger);
        for (const item of open) await openWait(db, clock.now(), { routineRunId, item, scope });
        status = "waiting_event";
        summary = `${summary ?? "Checked."} Waiting: ${open.map((i) => i.label).join("; ")}.`;
      } else {
        for (const w of await openWaitsOf(db, routineRunId)) await settleWait(db, w.id, "resumed", clock.now());
      }
    }
    const parked = status === "waiting_approval" || status === "waiting_event";
    await updateRun(routineRunId, { status, summary, leftForHumanJson: JSON.stringify(left), costUsdMicros: a.costUsdMicros, endedAt: parked ? null : clock.now() });
  }

  /** The trigger a segment ran with, from its context step (the brain wrote it; the engine only reads it back). */
  async function triggerOfSegment(agentRunId: string): Promise<Record<string, unknown>> {
    const rows = await db.select().from(runSteps).where(and(eq(runSteps.runId, agentRunId), eq(runSteps.kind, "context"))).orderBy(asc(runSteps.n)).limit(1);
    return parse<{ trigger?: Record<string, unknown> } | null>(rows[0]?.resultJson, null)?.trigger ?? {};
  }

  /**
   * Starts one more agent run segment for a parked routine run (wave 4): after the awaited event or time, or to follow
   * up while it still waits. The precheck is the run's own, with the segment's text from `<reason>_text`.
   */
  async function startSegment(routineRunId: string, reason: "resumed" | "follow_up", w: { id: string; followUps: number }, event: WeftEvent | null) {
    const rr = (await db.select().from(routineRuns).where(eq(routineRuns.id, routineRunId)).limit(1))[0];
    if (!rr) return;
    const routine = await get(rr.routineId);
    const pre = parse<PrecheckResult | null>(rr.precheckJson, null);
    if (!routine || !pre || pre.action !== "run") return;
    const derived = { ...(pre.derivedArgs ?? {}) };
    const text = segmentText(derived, reason, w.followUps);
    const precheck: PrecheckResult = { ...pre, derivedArgs: { ...derived, ...(text ? { text } : {}), segment: reason, wait_id: w.id, follow_ups: w.followUps } };
    const handle = await runs.openRoutineRun({ routineId: routine.id, routineRunId, triggerRef: `${rr.triggerRef}#${w.id}:${reason}:${w.followUps}`, attended: false });
    await updateRun(routineRunId, { status: "running", agentRunId: handle.runId, endedAt: null });
    watch(routineRunId, handle.runId);
    const run = (await getRun(routineRunId))!;
    const trigger = event ? { ...event, payload: { ...event.payload } } : null;
    await agent.startRoutineRun(handle, { routine: routineForRun(routine, precheck), routineRun: run, trigger, precheck });
  }

  /** Expires a wait past its timeout: the routine run fails with what a person should check (until waits resume instead). */
  async function timeOut(w: { id: string; routineRunId: string; kind: string; checklistItemId: string; createdAt: string; untilAt: string | null }) {
    if (w.kind === "until") {
      if (await settleWait(db, w.id, "resumed", clock.now())) await startSegment(w.routineRunId, "resumed", { id: w.id, followUps: 0 }, null);
      return;
    }
    if (!(await settleWait(db, w.id, "expired", clock.now()))) return;
    const rr = await getRun(w.routineRunId);
    const routine = rr ? await get(rr.routineId) : null;
    const label = (routine?.checklist ?? []).find((i) => i.id === w.checklistItemId)?.label ?? w.checklistItemId;
    const days = w.untilAt ? Math.round((Date.parse(w.untilAt) - Date.parse(w.createdAt)) / 86_400_000) : 0;
    await updateRun(w.routineRunId, {
      status: "failed", summary: `Stopped waiting after ${days} days: ${label} did not happen.`,
      leftForHumanJson: JSON.stringify([...(rr?.leftForHuman ?? []), `Check by hand: ${label} (waited ${days} days)`]), endedAt: clock.now(),
    });
  }

  /** Wave 4: resume waits an event satisfies (once each), then time out and follow up on the waits that are due. */
  async function sweepWaits(now: string, evt: WeftEvent | null) {
    if (evt) {
      for (const w of await waitsForEvent(db, evt.type)) {
        if (!matchesEvent(w, evt)) continue;
        if (await settleWait(db, w.id, "resumed", now)) await startSegment(w.routineRunId, "resumed", { id: w.id, followUps: w.followUps }, evt);
      }
      return;
    }
    const due = await dueWaits(db, now);
    for (const w of due.timedOut) await timeOut(w);
    for (const w of due.followUps) {
      const rr = await getRun(w.routineRunId);
      const routine = rr ? await get(rr.routineId) : null;
      const every = routine ? waitItems(routine).find((i) => i.id === w.checklistItemId)?.wait.followUpEveryDays ?? null : null;
      // A follow-up waits for the previous segment to finish; the next sweep picks it up.
      if (!every || !rr || rr.status !== "waiting_event") continue;
      if (await bumpFollowUp(db, w, every, now)) await startSegment(w.routineRunId, "follow_up", { id: w.id, followUps: w.followUps + 1 }, null);
    }
  }

  async function fire(routine: RoutineDef, input: { triggerRef: string; payload: Record<string, unknown>; attended: boolean; event: WeftEvent | null; at?: string }): Promise<RoutineRun> {
    const key = runKey(routine.id, input.triggerRef);
    const existing = (await db.select().from(routineRuns).where(eq(routineRuns.runKey, key)).limit(1))[0];
    if (existing) return toRun(existing);
    const id = newId();
    const now = clock.now();
    await lockedWrite(() => db.insert(routineRuns).values({ id, routineId: routine.id, runKey: key, triggerRef: input.triggerRef, status: "running", attended: input.attended, startedAt: now }).onConflictDoNothing());
    // A cron slot is judged at its own time, so a catch-up tick on Wednesday still skips Monday's and Tuesday's slots.
    const pre = await runPrecheck(routine.precheck, { companyId, now: input.at ?? now, triggerRef: input.triggerRef, payload: input.payload }, readOnly);
    // Wave 4 round 1 (FM11): a routine run that ends without an agent run still leaves a span with its reason.
    const skipped = async (summary: string, extra: Partial<typeof routineRuns.$inferInsert> = {}) => {
      await updateRun(id, { status: "skipped", precheckJson: JSON.stringify(pre), summary, endedAt: now, ...extra });
      const row = (await getRun(id))!;
      try {
        (agent as TracingAgent).traceRoutineRun?.({ routineId: routine.id, routineRunId: id, triggerRef: input.triggerRef, attended: input.attended, status: row.status, reason: summary, precheck: routine.precheck, event: input.event?.type ?? null, at: input.at ?? now });
      } catch { /* tracing never breaks a routine run */ }
      return row;
    };
    if (pre.action === "skip") return skipped(pre.reason);
    const isCron = routine.trigger.type === "cron" && !input.attended;
    // Quiet hours defer only digest-severity cron posts; the weekly digest itself is never deferred.
    if (isCron && pre.severity === "digest" && routine.id !== "rt_people_digest" && inQuietHours(input.at ?? now)) return skipped("Deferred by quiet hours (19:00 to 07:00 PT).");
    // Worth surfacing: a background run posts only when its findings changed since the last surfaced run.
    const hash = surfaceHash(pre.findings);
    if (isCron && routine.surface.worthSurfacing) {
      const last = (await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id)).orderBy(desc(routineRuns.startedAt)))
        .find((r) => r.id !== id && r.surfaceHash !== null && r.status !== "skipped");
      if (last && last.surfaceHash === hash) return skipped("Nothing new since the last run.", { surfaceHash: hash });
    }
    await updateRun(id, { precheckJson: JSON.stringify(pre), surfaceHash: hash });
    const handle = await runs.openRoutineRun({ routineId: routine.id, routineRunId: id, triggerRef: input.triggerRef, attended: input.attended });
    await updateRun(id, { agentRunId: handle.runId });
    watch(id, handle.runId);
    const run = (await getRun(id))!;
    await agent.startRoutineRun(handle, { routine: routineForRun(routine, pre), routineRun: run, trigger: input.event ? { ...input.event, payload: { ...input.event.payload } } : null, precheck: pre });
    return (await getRun(id))!;
  }

  const engine: WeftRoutinesEngine = {
    view: { get, checklist },
    list,
    async overview() {
      const now = clock.now();
      const out: RoutineOverview[] = [];
      for (const r of await list()) {
        const last = (await db.select().from(routineRuns).where(eq(routineRuns.routineId, r.id)).orderBy(desc(routineRuns.startedAt)).limit(1))[0];
        out.push({ routineId: r.id, lastRun: last ? { id: last.id, status: last.status as RoutineRunStatus, startedAt: last.startedAt, summary: last.summary } : null, nextRunAt: nextRunAt(r, now) });
      }
      return out;
    },
    getRun,
    ensurePrebuilt,
    fire,
    async runs(routineId, limit = 50) {
      return (await db.select().from(routineRuns).where(eq(routineRuns.routineId, routineId)).orderBy(desc(routineRuns.startedAt)).limit(limit)).map(toRun);
    },
    resetCursor(at: string) { cursor = at; seeded = false; },
    async tick(now) {
      await ensurePrebuilt();
      if (cursor > now) cursor = now; // the sim clock was set back (reset): never backfill
      const start = cursor;
      for (const r of await list()) {
        if (!r.enabled || r.trigger.type !== "cron") continue;
        const cron = new Cron(r.trigger.cron, { timezone: r.trigger.tz, paused: true });
        let t = new Date(start);
        for (let guard = 0; guard < 500; guard++) {
          const next = cron.nextRun(t);
          if (!next || next.toISOString() > now) break;
          const slot = next.toISOString();
          await fire(r, { triggerRef: `cron:${slot}`, payload: { slot: `cron:${slot}` }, attended: false, event: null, at: slot });
          t = next;
        }
        cron.stop();
      }
      cursor = now;
      if (opts.events) {
        const all = await list();
        for (const evt of await opts.events.unconsumed()) {
          for (const r of all) {
            if (!r.enabled || r.trigger.type !== "event" || r.trigger.event !== evt.type) continue;
            await fire(r, { triggerRef: evt.id, payload: { ...evt.payload }, attended: evt.attended, event: evt });
          }
          await sweepWaits(now, evt);
          await opts.events.consume(evt.id);
        }
      }
      await sweepWaits(now, null);
    },
    async trigger(routineId, input) {
      const r = await get(routineId);
      if (!r) throw new Error(`no routine ${routineId}`);
      const now = clock.now();
      const run = await fire(r, { triggerRef: `manual:${now}:${randomBytes(3).toString("hex")}`, payload: { manual: true, requested_by: input.requestedBy }, attended: input.attended, event: null });
      return { routineRunId: run.id };
    },
    async onProposalDecided(p: ProposalDecided) {
      decisions.set(p.proposalId, p.status);
      const runId = p.runId;
      if (!runId) return;
      const rr = (await db.select().from(routineRuns).where(eq(routineRuns.agentRunId, runId)).limit(1))[0];
      // After an API restart the terminal-step subscription made by fire() is gone; watch again before waking the run.
      if (rr) watch(rr.id, runId);
      const notice = { kind: "decision" as const, attrs: { proposal_id: p.proposalId, status: p.status, decider_role: p.deciderRole, reason_code: p.reasonCode ?? "none" }, text: `Proposal ${p.proposalId} is ${p.status}.` };
      const wake = (agent as AgentRuntime & { wake?: (id: string, n: typeof notice) => Promise<string> }).wake;
      if (wake) await wake.call(agent, runId, notice);
      else await agent.requeue(runId, notice);
      if (rr) await track(() => finalizeFromAgent(rr.id, runId));
    },
    pendingFinalizations: () => pending.size,
    async drain(timeoutMs = 5_000, isClosing = false) {
      if (isClosing) closing = true;
      const deadline = Date.now() + timeoutMs;
      while (pending.size > 0) {
        const left = deadline - Date.now();
        if (left <= 0) return false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.allSettled([...pending]), new Promise((r) => { timer = setTimeout(r, left); })]);
        clearTimeout(timer);
      }
      return true;
    },
    async settled(routineRunId) {
      const r = await getRun(routineRunId);
      if (r && !["queued", "running"].includes(r.status)) return r;
      return new Promise((res) => waiters.set(routineRunId, [...(waiters.get(routineRunId) ?? []), res]));
    },
  };
  return engine;
}
