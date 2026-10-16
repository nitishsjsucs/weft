// Scaffold (frozen): scheduler tick order (SPEC 9.0). 5 s live, synchronous in tests via tick() and kick().
// (1) sims.tick(now), persisting SimEvents as events rows; (2) executor.expireProposals(now);
// (3) core event handlers in event order as their svc_ principals; (4) routines.tick(now).
// Wave 2: after (1), the payment rail simulator ticks and contractor payouts mirror its state (pending, sent,
// delivered, returned), appending sim.rail_delivered events that step (3) then sees in the same tick. Sent or viewed
// offers past their expiry date are expired by svc_scheduler (documents.expire_offers, R1), only when one is due.
import { sql } from "drizzle-orm";
import { isWeftError, type EventBody, type EventHandler, type ExecutorBundle, type RoutinesEngine, type Scheduler, type SimClock, type Simulators, type WeftEvent } from "@weft/contracts";
import { settings, withWriteLock, type Db } from "@weft/db";
import { emitEvent, ptDateOf } from "@weft/core";
import { syncContractorRail } from "./routes/contractors";

export const HANDLER_CURSOR_KEY = "scheduler.handlers_cursor";
const MAX_HANDLER_PASSES = 5;

export interface CreateSchedulerOptions {
  db: Db; clock: SimClock; sims: Simulators; executor: ExecutorBundle; handlers: EventHandler[]; routines: RoutinesEngine;
  intervalMs?: number; log?: (line: string) => void;
}

const isStub = (e: unknown) => isWeftError(e) && e._tag === "NotImplemented";

/** The scheduler plus exclusive(), which the sim reset uses to keep ticks out while it rebuilds the world. */
export interface WeftScheduler extends Scheduler { exclusive<T>(fn: () => Promise<T>): Promise<T> }

export function createScheduler(o: CreateSchedulerOptions): WeftScheduler {
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
    await step("rail.sync", () => syncContractorRail({ db: o.db, clock: o.clock }));
    await step("offers.expire", async () => {
      const due = await o.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM offers WHERE status IN ('sent', 'viewed') AND expires_on IS NOT NULL AND expires_on < ${ptDateOf(now)}`);
      if (!due[0]?.n) return;
      await o.executor.system.exec("svc_scheduler", "documents.expire_offers", {}, { eventId: null, attended: false, requestedBy: null });
    });
    await step("executor.expireProposals", () => o.executor.expireProposals(now));
    await step("handlers", runHandlers);
    await step("routines.tick", () => o.routines.tick(now));
  }

  let inflight: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | null = null;
  const tick = () => { inflight = inflight.then(tickOnce, tickOnce); return inflight; };
  /**
   * Runs `fn` on the tick chain: it starts once the tick in flight has finished, and every tick or kick asked for
   * meanwhile waits until it is done. POST /v1/sim/reset rebuilds the world inside this, so no tick reads or writes
   * a half-dropped database.
   */
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = inflight.then(fn, fn);
    inflight = run.then(() => undefined, () => undefined);
    return run;
  };
  return {
    tick,
    kick: tick,
    exclusive,
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, o.intervalMs ?? 5_000);
      timer.unref?.();
    },
    async stop() { if (timer) clearInterval(timer); timer = null; await inflight.catch(() => undefined); },
  };
}
