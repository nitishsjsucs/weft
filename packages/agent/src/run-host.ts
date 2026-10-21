// Where run jobs start (docs/cloudflare/design.md 3.3 and 8.1; the RunHost port in cf-agent.ts). The runtime's queue
// (concurrency 1 for a live provider, 8 for scripted) is unchanged; a host only decides when a job enters it.
//
// - immediate (Node): a job enters the queue at once, so Node runs exactly as before.
// - alarm (CompanyDO): jobs wait in a FIFO and `arm` asks for a DO alarm. Each alarm invocation calls drain(), which
//   starts what one invocation may (every job ahead of the first live job it cannot start, and at most one live run,
//   so that run's model calls get the invocation's fresh 50-fetch budget), waits for them, and arms again while jobs
//   remain. A job never survives the isolate: an eviction is a process restart and the boot rule applies.
// Portable: no node: imports.
import type { FetchCounter, RunHost, RunHostJob } from "../../contracts/src/ext/cf-agent";

export function immediateRunHost(): RunHost {
  return {
    kind: "immediate",
    submit(job) { void job.start().catch(() => undefined); },
    pending: () => [],
    drain: async () => ({ started: 0, remaining: 0 }),
  };
}

export interface AlarmRunHostOptions {
  /** Asks for an alarm (CompanyDO: setAlarm now). Called once per needed invocation: on the first submit while idle,
   * and after a drain that left jobs behind. Each setAlarm is a row written, so it is never called twice in a row. */
  arm?: () => void | Promise<void>;
  /** Reset at the start of every drain, so it counts one invocation's fetches. */
  counter?: FetchCounter;
  /** Rounds per drain: jobs submitted while draining (a template fallback, a woken run) start in the same invocation
   * when they make no model fetch. */
  maxRounds?: number;
}

export interface DrainResult { started: number; remaining: number; liveStarted: number; fetches: number | null }

export interface AlarmRunHost extends RunHost {
  readonly kind: "alarm";
  readonly armed: boolean;
  readonly draining: boolean;
  drain(): Promise<DrainResult>;
  /** The last drain's result (tests, the alarm log line). */
  readonly last: DrainResult | null;
}

export function alarmRunHost(opts: AlarmRunHostOptions = {}): AlarmRunHost {
  const fifo: RunHostJob[] = [];
  const maxRounds = opts.maxRounds ?? 16;
  let armed = false;
  let draining = false;
  let last: DrainResult | null = null;
  const arm = () => {
    if (armed) return;
    armed = true;
    try { void Promise.resolve(opts.arm?.()).catch(() => { armed = false; }); } catch { armed = false; }
  };
  return {
    kind: "alarm",
    get armed() { return armed; },
    get draining() { return draining; },
    get last() { return last; },
    submit(job) {
      fifo.push(job);
      if (!draining) arm();
    },
    pending: () => fifo.map((j) => j.runId),
    async drain() {
      if (draining) return { started: 0, remaining: fifo.length, liveStarted: 0, fetches: opts.counter?.count ?? null };
      draining = true;
      armed = false;
      opts.counter?.reset();
      let started = 0;
      let liveStarted = 0;
      try {
        for (let round = 0; round < maxRounds && fifo.length > 0; round++) {
          const batch: RunHostJob[] = [];
          while (fifo.length > 0) {
            const next = fifo[0]!;
            if (next.live && liveStarted > 0) break;
            fifo.shift();
            if (next.live) liveStarted++;
            batch.push(next);
          }
          if (batch.length === 0) break;
          started += batch.length;
          await Promise.allSettled(batch.map((j) => j.start()));
        }
      } finally {
        draining = false;
      }
      last = { started, remaining: fifo.length, liveStarted, fetches: opts.counter?.count ?? null };
      if (fifo.length > 0) arm();
      return last;
    },
  };
}

// Fetch counting ---------------------------------------------------------------------------------------------------

export class FetchBudgetExceeded extends Error {
  readonly code = "FETCH_BUDGET";
  constructor(max: number) { super(`FETCH_BUDGET: more than ${max} outbound fetches in one invocation`); }
}

/**
 * Counts outbound fetches per invocation (design 8.1: Workers Free allows 50 external subrequests; Weft keeps 10 in
 * reserve). A fetch past `max` throws FETCH_BUDGET before it is sent, so the platform's own limit never fails a step
 * half way; a chat run makes at most 36 model fetches (12 steps, 3 attempts each), a routine at most 18.
 */
export function createFetchCounter(opts: { max?: number } = {}): FetchCounter & { readonly max: number } {
  const max = opts.max ?? 40;
  let count = 0;
  return {
    max,
    get count() { return count; },
    wrap(f) {
      const counted = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (count >= max) return Promise.reject(new FetchBudgetExceeded(max));
        count++;
        return f(input, init);
      };
      return counted as typeof fetch;
    },
    reset() { count = 0; },
  };
}

/** The IO_IN_TX guard as transports call it (cf-db.ts TxGuard), typed structurally. */
export interface TxGuardLike { assertNotInTx(what: string): void }

/** A fetch that refuses inside a transaction (IO_IN_TX) and counts toward the invocation's budget. */
export function guardedFetch(base: typeof fetch, o: { what: string; guard?: TxGuardLike | null; counter?: FetchCounter | null }): typeof fetch {
  const counted = o.counter ? o.counter.wrap(base) : base;
  const g = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    try { o.guard?.assertNotInTx(o.what); } catch (e) { return Promise.reject(e); }
    return counted(input, init);
  };
  return g as typeof fetch;
}
