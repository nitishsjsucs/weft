// The rows budgets a world holds itself to (design 6.3, defense in depth). They do not replace any cap: they exist so
// that an amplifier nobody has found yet (one request that makes a world read or write without bound) cannot spend
// the account's daily Durable Object rows, which Weft shares with six other apps.
//
// - A leased slot tallies the rows its requests and alarm drains read and write, per generation and UTC day (a reset
//   starts the next generation, and since leases can last 30 days (2026-10-23) the tally also refills at 00:00 UTC).
//   Past `leaseRowsWritten` its mutations answer 429 DEMO_LIMIT, and past `leaseRowsRead` every request does ("this
//   workspace has used today's activity limit; it refills at 00:00 UTC, or reset it to start fresh").
// - The showcase tallies the rows it reads per UTC day; past `showcaseRowsReadPerDay` every request answers 503
//   SHOWCASE_LIMIT, while leased workspaces and the static pages keep working.
//
// The tally lives in the object's memory and is written to its storage cheaply: one row (kv `weft.budget`), at most
// every `persistEvery` requests and alarms (200 on the showcase), and whenever it crosses a step or a limit, so a
// refusal survives an eviction and a hibernation loses at most a few requests' rows. Every limit can be changed in KV
// weft-config (budget.lease_rows_written, budget.lease_rows_read, budget.showcase_rows_read).

/**
 * Defaults. Measured with pnpm e2e:cf on the local stack (scripted provider, rich world, two runs on 2026-10-23), each
 * on its own generation: the guided tour read 23,899 and 24,237 rows and wrote 417 (238 and 250 requests and alarms);
 * all eight demo scenarios read 55,790 and 55,865 and wrote 2,525 (107). leaseRowsRead is over three times the larger
 * sum (80,102), rounded up; leaseRowsWritten is the 5,000 design 6.3 sets, about 1.7 times the two together (2,942).
 */
export const WORLD_BUDGET = {
  leaseRowsWritten: 5_000,
  leaseRowsRead: 250_000,
  showcaseRowsReadPerDay: 1_000_000,
  persistEvery: 20,
  writeStep: 250,
  readStep: 20_000,
} as const;
/** How often the showcase writes its day's tally: it serves anonymous reads (most of them answered by the front's
 * memo), so it writes less often than a leased slot, and only its rows read matter. */
export const SHOWCASE_TALLY_CADENCE = { persistEvery: 200, writeStep: Number.MAX_SAFE_INTEGER, readStep: 50_000 } as const;
export type TallyCadence = { persistEvery: number; writeStep: number; readStep: number };

/** One generation's (or one showcase day's) rows and its requests and alarms. */
export interface BudgetTally { key: string; rowsWritten: number; rowsRead: number; events: number }

export interface TallyStore {
  get(): BudgetTally | null;
  put(t: BudgetTally): void;
}

export interface BudgetLimits { rowsWritten: number | null; rowsRead: number }

/** Which step of `step` rows `n` is in. */
const stepOf = (n: number, step: number) => Math.floor(n / Math.max(1, step));

export class RowsTally {
  private t: BudgetTally | null = null;
  private saved: BudgetTally | null = null;
  private loaded = false;
  /** Writes of the tally so far (tests and the health readout). */
  writes = 0;

  constructor(private readonly store: TallyStore, private readonly cadence: TallyCadence = WORLD_BUDGET) {}

  /** The tally for `key`; a stored or kept tally of another key (an earlier generation or day) starts again at zero. */
  read(key: string): BudgetTally {
    if (!this.loaded) {
      this.loaded = true;
      try { this.saved = this.store.get(); } catch { this.saved = null; }
      this.t = this.saved ? { ...this.saved } : null;
    }
    if (!this.t || this.t.key !== key) this.t = { key, rowsWritten: 0, rowsRead: 0, events: 0 };
    return this.t;
  }

  /** Adds rows a request, an alarm drain or a boot read and wrote. */
  add(key: string, u: { rowsRead: number; rowsWritten: number }): BudgetTally {
    const t = this.read(key);
    t.rowsRead += Math.max(0, u.rowsRead);
    t.rowsWritten += Math.max(0, u.rowsWritten);
    return t;
  }

  /**
   * Counts one request or alarm and writes the tally when it is due: every persistEvery events, on crossing a step,
   * or on reaching a limit (so the refusal holds after an eviction). Returns whether it wrote.
   */
  event(key: string, limits: BudgetLimits, cadence: TallyCadence = this.cadence): boolean {
    const t = this.read(key);
    t.events += 1;
    const s = this.saved && this.saved.key === key ? this.saved : { key, rowsWritten: 0, rowsRead: 0, events: 0 };
    const crossed = (n: number, prev: number, limit: number | null) => limit !== null && n >= limit && prev < limit;
    // Requests that moved no row (a refused one past its limit, say) never write the tally on their count alone.
    const moved = t.rowsRead !== s.rowsRead || t.rowsWritten !== s.rowsWritten;
    const due = (moved && t.events - s.events >= cadence.persistEvery)
      || stepOf(t.rowsWritten, cadence.writeStep) !== stepOf(s.rowsWritten, cadence.writeStep)
      || stepOf(t.rowsRead, cadence.readStep) !== stepOf(s.rowsRead, cadence.readStep)
      || crossed(t.rowsWritten, s.rowsWritten, limits.rowsWritten) || crossed(t.rowsRead, s.rowsRead, limits.rowsRead);
    if (!due) return false;
    try {
      this.store.put({ ...t });
      this.saved = { ...t };
      this.writes += 1;
      return true;
    } catch {
      return false;   // kept in memory; the next due event writes it
    }
  }
}

/** What a request finds against the limits: null to serve it, or which limit refuses it. */
export function overLimit(t: BudgetTally, limits: BudgetLimits, mutation: boolean): "read" | "write" | null {
  if (t.rowsRead >= limits.rowsRead) return "read";
  if (mutation && limits.rowsWritten !== null && t.rowsWritten >= limits.rowsWritten) return "write";
  return null;
}
