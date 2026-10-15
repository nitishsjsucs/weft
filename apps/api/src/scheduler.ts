// Scaffold (frozen): scheduler tick order (SPEC 9.0). 5 s live, synchronous in tests via tick() and kick().
// (1) sims.tick(now), persisting SimEvents as events rows; (2) executor.expireProposals(now);
// (3) core event handlers in event order as their svc_ principals; (4) routines.tick(now).
import { sql } from "drizzle-orm";
import { isWeftError, type EventBody, type EventHandler, type ExecutorBundle, type RoutinesEngine, type Scheduler, type SimClock, type Simulators, type WeftEvent } from "@weft/contracts";
import { settings, withWriteLock, type Db } from "@weft/db";
import { emitEvent } from "@weft/core";

export const HANDLER_CURSOR_KEY = "scheduler.handlers_cursor";
const MAX_HANDLER_PASSES = 5;

export interface CreateSchedulerOptions {
  db: Db; clock: SimClock; sims: Simulators; executor: ExecutorBundle; handlers: EventHandler[]; routines: RoutinesEngine;
  intervalMs?: number; log?: (line: string) => void;
}

const isStub = (e: unknown) => isWeftError(e) && e._tag === "NotImplemented";

export function createScheduler(o: CreateSchedulerOptions): Scheduler {
  const log = o.log ?? ((l: string) => console.error(l));
  const stubbed = new Set<string>();
  const redact = (t: string) => { try { return o.executor.redact(t); } catch { return t.slice(0, 300); } };
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) {
      if (isStub(e)) { if (!stubbed.has(name)) { stubbed.add(name); log(`scheduler: ${name} is a stub, skipped`); } return; }
      log(`scheduler: ${name} failed: ${redact(String(e))}`);
    }
  };

  const readCursor = async (): Promise<number> => {
    const rows = await o.db.all<{ v: string }>(sql`SELECT value_json AS v FROM settings WHERE key = ${HANDLER_CURSOR_KEY}`);
    return rows[0] ? Number(JSON.parse(rows[0].v)) : 0;
  };
  const writeCursor = (n: number) => o.db.insert(settings).values({ key: HANDLER_CURSOR_KEY, valueJson: JSON.stringify(n) })
    .onConflictDoUpdate({ target: settings.key, set: { valueJson: JSON.stringify(n) } });

  async function runHandlers(): Promise<void> {
    for (let pass = 0; pass < MAX_HANDLER_PASSES; pass++) {
      const cursor = await readCursor();
      const rows = await o.db.all<{ rid: number; id: string; type: string; ts: string; subject_ref: string; payload_json: string; attended: number; requested_by: string | null }>(
        sql`SELECT rowid AS rid, id, type, ts, subject_ref, payload_json, attended, requested_by FROM events WHERE rowid > ${cursor} ORDER BY rowid`);
      if (rows.length === 0) return;
      for (const r of rows) {
        const evt: WeftEvent = { id: r.id, type: r.type, ts: r.ts, subjectRef: r.subject_ref, payload: JSON.parse(r.payload_json), attended: !!r.attended, requestedBy: r.requested_by };
        for (const h of o.handlers.filter((x) => x.event === evt.type)) {
          await step(`handler ${h.event}`, () => h.handle(evt, o.executor.system, o.executor.readOnly));
        }
        await writeCursor(r.rid);
      }
    }
  }

  async function tickOnce(): Promise<void> {
    const now = o.clock.now();
    await step("sims.tick", async () => {
      const simEvents = await o.sims.tick(now);
      if (simEvents.length === 0) return;
      await withWriteLock(() => o.db.transaction(async (tx) => {
        for (const e of simEvents) {
          await emitEvent(tx, o.clock, { body: { type: e.type, payload: e.payload } as EventBody, subjectRef: e.subjectRef, attended: false, requestedBy: null });
        }
      }));
    });
    await step("executor.expireProposals", () => o.executor.expireProposals(now));
    await step("handlers", runHandlers);
    await step("routines.tick", () => o.routines.tick(now));
  }

  let inflight: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | null = null;
  const tick = () => { inflight = inflight.then(tickOnce, tickOnce); return inflight; };
  return {
    tick,
    kick: tick,
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, o.intervalMs ?? 5_000);
      timer.unref?.();
    },
    async stop() { if (timer) clearInterval(timer); timer = null; await inflight.catch(() => undefined); },
  };
}
