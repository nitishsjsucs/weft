// The wall-clock spend ledger (harness 4.5, 13.7; SPEC 9.10). Real spend lives in <dir>/<yyyy-mm-dd UTC>.jsonl,
// outside every company directory, so a world reset or a sim clock advance never touches it. Writers take a lock by
// mkdir <dir>/.lock (atomic), retried for 2 s; a lock older than 10 s by mtime is stale and removed. Node only: the
// fold, totals and cap code are spend-core.ts, which the SQL store SpendDO runs shares (docs/cloudflare/design.md 4.3).
//
// The per-run cap keys a run by its world and its id. Run ids restart at run_0001 whenever the world is rebuilt
// (POST /v1/sim/reset, pnpm db:reset, every eval trial world), while this ledger outlives every world, so a run id
// alone summed the first run of every world into one per-run cap (the eval runner lost trials to "Stopped by the run
// spend cap" after a full dev run). The day and live caps stay cumulative across worlds.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SpendLedger } from "@weft/contracts";
import { capsFromEnv, createLedgerCore, nodeCaps, type EntryQuery, type LedgerCore, type LedgerEntry, type SpendCaps, type SpendStore } from "./spend-core";

export { capsFromEnv, type LedgerEntry, type SpendCaps } from "./spend-core";

export interface SpendLedgerOptions {
  dir: string;
  caps?: Partial<SpendCaps>;
  env?: Record<string, string | undefined>;
  /** Wall clock, injectable for tests. Never the sim clock. */
  wallNow?: () => Date;
  lockRetryMs?: number;
  staleLockMs?: number;
  /**
   * The world the ledger's run ids belong to, read at every reservation (so a reset in this process starts a new
   * world). Entries record it, and the per-run cap and run-scoped totals count only the current world's entries for
   * that run id. Absent, or null: run ids alone, as before.
   */
  world?: () => string | null;
}

export class SpendLockTimeout extends Error {
  readonly code = "SPEND_LOCK_TIMEOUT";
  constructor(dir: string) { super(`SPEND_LOCK_TIMEOUT: could not take ${join(dir, ".lock")} within the retry window`); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LedgerTotals { settledMicros: number; openMicros: number }

export interface WeftSpendLedger extends SpendLedger {
  readonly dir: string;
  readonly caps: SpendCaps;
  /** Settled plus open reservations for a scope; what the cap check uses. */
  committed(scope: { day?: string; runId?: string; live?: boolean }): Promise<LedgerTotals>;
  entries(day?: string): LedgerEntry[];
}

export interface FileSpendStoreOptions { dir: string; lockRetryMs?: number; staleLockMs?: number }

/** One JSONL file per UTC day of the reservation; a day scope reads one file, run and live scopes read all. */
export function createFileSpendStore(opts: FileSpendStoreOptions): SpendStore & { readDay(day: string): LedgerEntry[] } {
  const dir = opts.dir;
  const retryMs = opts.lockRetryMs ?? 2000;
  const staleMs = opts.staleLockMs ?? 10_000;
  const lockDir = join(dir, ".lock");
  const fileFor = (day: string) => join(dir, `${day}.jsonl`);

  function readDay(day: string): LedgerEntry[] {
    let text = "";
    try { text = readFileSync(fileFor(day), "utf8"); } catch { return []; }
    const out: LedgerEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as LedgerEntry); } catch { /* a torn line never counts */ }
    }
    return out;
  }

  function allDays(): string[] {
    try {
      return readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, 10)).sort();
    } catch {
      return [];
    }
  }

  return {
    kind: "file",
    readDay,
    async exclusive(fn) {
      mkdirSync(dir, { recursive: true });
      const deadline = Date.now() + retryMs;
      for (;;) {
        try {
          mkdirSync(lockDir);
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          try {
            if (Date.now() - statSync(lockDir).mtimeMs > staleMs) {
              rmdirSync(lockDir);
              continue;
            }
          } catch {
            continue; // removed between our mkdir and stat
          }
          if (Date.now() >= deadline) throw new SpendLockTimeout(dir);
          await sleep(20);
        }
      }
      try {
        return fn();
      } finally {
        try { rmdirSync(lockDir); } catch { /* already gone */ }
      }
    },
    entries(q: EntryQuery) {
      if (q.reservationId !== undefined) {
        // Reservations settle in the file they were made in: the newest file holding the reservation has them all.
        for (const day of allDays().reverse()) {
          const es = readDay(day);
          if (es.some((e) => e.kind === "reserve" && e.reservationId === q.reservationId)) return es.filter((e) => e.reservationId === q.reservationId);
        }
        return [];
      }
      return (q.days ?? allDays()).flatMap(readDay);
    },
    append(e) {
      appendFileSync(fileFor(e.at.slice(0, 10)), JSON.stringify(e) + "\n");
    },
    newReservationId: () => `rsv_${randomBytes(8).toString("hex")}`,
  };
}

export function createSpendLedger(opts: SpendLedgerOptions): WeftSpendLedger {
  const dir = opts.dir;
  const caps: SpendCaps = { ...capsFromEnv(opts.env ?? process.env), ...opts.caps };
  const wallNow = opts.wallNow ?? (() => new Date());
  const store = createFileSpendStore({ dir, lockRetryMs: opts.lockRetryMs, staleLockMs: opts.staleLockMs });
  const hosted = nodeCaps(caps);
  const core: LedgerCore = createLedgerCore({ store, caps: () => hosted, wallNow, world: opts.world });
  return {
    dir,
    caps,
    async reserve(input) {
      const r = await core.reserve(input);
      // The frozen refusal shape: the Node ledger has only the run, day and live caps.
      return r.ok ? r : { ok: false as const, code: r.code, cap: r.cap, spentMicros: r.spentMicros };
    },
    settle: (reservationId, actualUsdMicros) => core.settle(reservationId, actualUsdMicros),
    release: (reservationId) => core.release(reservationId),
    spent: (scope) => core.spent(scope),
    async committed(scope) {
      const t = await core.committed(scope);
      return { settledMicros: t.settledMicros, openMicros: t.openMicros };
    },
    entries(day) {
      return store.readDay(day ?? wallNow().toISOString().slice(0, 10));
    },
  };
}
