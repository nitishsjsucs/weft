// The hosts CompanyDO hands the durable platform (DurablePlatformInput.runHost and .schedulerHost; design 3.3).
//
// - Run jobs wait in a FIFO and ask for an alarm. Each alarm invocation drains what one invocation may: every job up
//   to the second live one (at most one live run per invocation, so its model calls get the invocation's fresh
//   50-fetch budget), in rounds so a job submitted while draining (a woken run, a template fallback) starts in the
//   same invocation when it makes no model fetch. It waits for the started jobs and asks for another alarm while
//   jobs remain. A job never survives the isolate: an eviction is a process restart and the boot rule applies.
// - Scheduler ticks come only from the alarm, and only while the sim clock rate is above 0 (hosted default 0, so time
//   moves only through the Simulators advance buttons). kick() after mutations stays inline in Weft's own code.
import type { FetchCounter, RunHost, RunHostJob, SchedulerHost } from "../../shared/contracts";

export interface DrainResult { started: number; remaining: number; liveStarted: number; fetches: number | null }

export interface DurableRunHost extends RunHost {
  readonly kind: "alarm";
  drain(): Promise<DrainResult>;
  readonly draining: boolean;
}

export function durableRunHost(opts: { arm: () => void | Promise<void>; counter?: FetchCounter; maxRounds?: number }): DurableRunHost {
  const fifo: RunHostJob[] = [];
  const maxRounds = opts.maxRounds ?? 16;
  let draining = false;
  const arm = () => { void Promise.resolve().then(opts.arm).catch(() => undefined); };
  return {
    kind: "alarm",
    get draining() { return draining; },
    submit(job) {
      fifo.push(job);
      if (!draining) arm();
    },
    pending: () => fifo.map((j) => j.runId),
    async drain() {
      if (draining) return { started: 0, remaining: fifo.length, liveStarted: 0, fetches: opts.counter?.count ?? null };
      draining = true;
      let started = 0;
      let liveStarted = 0;
      try {
        for (let round = 0; round < maxRounds && fifo.length > 0; round++) {
          const batch: RunHostJob[] = [];
          while (fifo.length > 0) {
            const next = fifo[0]!;
            if (next.live && liveStarted > 0) break;
            fifo.shift();
            if (next.live) liveStarted += 1;
            batch.push(next);
          }
          if (!batch.length) break;
          started += batch.length;
          await Promise.allSettled(batch.map((j) => j.start()));
        }
      } finally {
        draining = false;
      }
      if (fifo.length > 0) arm();
      return { started, remaining: fifo.length, liveStarted, fetches: opts.counter?.count ?? null };
    },
  };
}

export interface DurableSchedulerHost extends SchedulerHost {
  /** Runs one tick if the clock rate is above 0; returns whether the next tick should be armed. */
  tick(): Promise<boolean>;
  /** Re-arms after a request when the clock started running (a Simulators rate change). */
  poke(): void;
  readonly started: boolean;
  readonly intervalMs: number;
}

export function durableSchedulerHost(opts: { arm: (at: number) => void | Promise<void>; cancel: () => void }): DurableSchedulerHost {
  let input: { tick: () => Promise<void>; intervalMs: number; clockRate: () => number } | null = null;
  let armed = false;
  const rate = () => { try { return input?.clockRate() ?? 0; } catch { return 0; } };
  const schedule = () => {
    if (!input || armed || rate() <= 0) return;
    armed = true;
    void Promise.resolve(opts.arm(Date.now() + input.intervalMs)).catch(() => { armed = false; });
  };
  return {
    get started() { return input !== null; },
    get intervalMs() { return input?.intervalMs ?? 0; },
    start(i) {
      input = i;
      armed = false;
      schedule();
    },
    async stop() {
      input = null;
      armed = false;
      opts.cancel();
    },
    async tick() {
      armed = false;
      if (!input || rate() <= 0) return false;
      try {
        await input.tick();
      } finally {
        schedule();
      }
      return true;
    },
    poke: schedule,
  };
}

/**
 * Counts outbound fetches per alarm invocation (design 8.1: Workers Free allows 50 external subrequests; Weft keeps
 * 10 in reserve, MAX_FETCHES_PER_ALARM). A fetch past `max` is refused before it is sent, so the platform's own
 * limit never fails a step half way.
 */
export class FetchBudgetExceeded extends Error {
  readonly code = "FETCH_BUDGET";
  constructor(max: number) { super(`FETCH_BUDGET: more than ${max} outbound fetches in one invocation`); }
}

export function fetchCounter(max = 40): FetchCounter & { readonly max: number; readonly peak: number } {
  let count = 0;
  let peak = 0;
  return {
    max,
    get count() { return count; },
    get peak() { return peak; },
    wrap(f) {
      return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (count >= max) return Promise.reject(new FetchBudgetExceeded(max));
        count += 1;
        peak = Math.max(peak, count);
        return f(input, init);
      }) as typeof fetch;
    },
    reset() { count = 0; },
  };
}
