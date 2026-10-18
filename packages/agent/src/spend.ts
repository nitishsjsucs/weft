// The wall-clock spend ledger (harness 4.5, 13.7; SPEC 9.10). Real spend lives in <dir>/<yyyy-mm-dd UTC>.jsonl,
// outside every company directory, so a world reset or a sim clock advance never touches it. Writers take a lock by
// mkdir <dir>/.lock (atomic), retried for 2 s; a lock older than 10 s by mtime is stale and removed.
//
// The per-run cap keys a run by its world and its id. Run ids restart at run_0001 whenever the world is rebuilt
// (POST /v1/sim/reset, pnpm db:reset, every eval trial world), while this ledger outlives every world, so a run id
// alone summed the first run of every world into one per-run cap (the eval runner lost trials to "Stopped by the run
// spend cap" after a full dev run). The day and live caps stay cumulative across worlds.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SpendEntry, SpendLedger } from "@weft/contracts";

export interface SpendCaps { runUsd: number; dayUsd: number; liveUsd: number }

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

/** A ledger line: the contract's entry plus the world its run id belongs to, when the ledger knows it. */
export type LedgerEntry = SpendEntry & { world?: string };

export function capsFromEnv(env: Record<string, string | undefined>): SpendCaps {
  const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
  return { runUsd: num(env.WEFT_RUN_USD_CAP, 0.1), dayUsd: num(env.WEFT_DAY_USD_CAP, 2), liveUsd: num(env.WEFT_LIVE_USD_CAP, 0.5) };
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

export function createSpendLedger(opts: SpendLedgerOptions): WeftSpendLedger {
  const dir = opts.dir;
  const caps: SpendCaps = { ...capsFromEnv(opts.env ?? process.env), ...opts.caps };
  const wallNow = opts.wallNow ?? (() => new Date());
  const retryMs = opts.lockRetryMs ?? 2000;
  const staleMs = opts.staleLockMs ?? 10_000;
  const lockDir = join(dir, ".lock");
  const today = () => wallNow().toISOString().slice(0, 10);
  const fileFor = (day: string) => join(dir, `${day}.jsonl`);

  async function withLock<T>(fn: () => T): Promise<T> {
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
  }

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

  /** The current world, or undefined when the ledger keys runs by id alone. */
  const currentWorld = (): string | undefined => opts.world?.() ?? undefined;

  function allDays(): string[] {
    try {
      return readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, 10)).sort();
    } catch {
      return [];
    }
  }

  /** Fold entries into per-reservation state: open reservations count at their reserved amount. */
  function fold(entries: LedgerEntry[]): Map<string, { e: LedgerEntry; micros: number; open: boolean }> {
    const m = new Map<string, { e: LedgerEntry; micros: number; open: boolean }>();
    for (const e of entries) {
      if (e.kind === "reserve") m.set(e.reservationId, { e, micros: e.usdMicros, open: true });
      else {
        const cur = m.get(e.reservationId);
        if (!cur) continue;
        cur.micros = e.kind === "settle" ? e.usdMicros : 0;
        cur.open = false;
      }
    }
    return m;
  }

  /** A run scope means that run id in the current world: an earlier world's run_0001 is another run. */
  type Scope = { day?: string; runId?: string; live?: boolean };
  const inWorld = (scope: Scope): Scope & { world?: string } => (scope.runId !== undefined ? { ...scope, world: currentWorld() } : scope);

  function totals(scope: Scope & { world?: string }): LedgerTotals {
    // Reservations settle in the file they were made in, so a day scope reads one file; run and live scopes read all.
    const days = scope.day ? [scope.day] : allDays();
    const res = fold(days.flatMap(readDay));
    const world = scope.world;
    let settledMicros = 0;
    let openMicros = 0;
    for (const r of res.values()) {
      if (scope.runId !== undefined && r.e.runId !== scope.runId) continue;
      if (world !== undefined && r.e.world !== world) continue;
      if (scope.live !== undefined && r.e.live !== scope.live) continue;
      if (r.open) openMicros += r.micros;
      else settledMicros += r.micros;
    }
    return { settledMicros, openMicros };
  }

  function append(e: LedgerEntry) {
    appendFileSync(fileFor(e.at.slice(0, 10)), JSON.stringify(e) + "\n");
  }

  function findReservation(id: string): LedgerEntry | null {
    for (const day of allDays().reverse()) {
      const hit = readDay(day).find((e) => e.kind === "reserve" && e.reservationId === id);
      if (hit) return hit;
    }
    return null;
  }

  return {
    dir,
    caps,
    async reserve(input) {
      return withLock(() => {
        const usd = (t: LedgerTotals) => t.settledMicros + t.openMicros;
        const checks: { cap: "run" | "day" | "live"; capMicros: number; committed: number }[] = [];
        const world = input.runId !== null ? currentWorld() : undefined;
        if (input.runId !== null) checks.push({ cap: "run", capMicros: caps.runUsd * Math.max(1, input.runCapScale ?? 1) * 1e6, committed: usd(totals({ runId: input.runId, world })) });
        checks.push({ cap: "day", capMicros: caps.dayUsd * 1e6, committed: usd(totals({ day: today() })) });
        if (input.live) checks.push({ cap: "live", capMicros: caps.liveUsd * 1e6, committed: usd(totals({ live: true })) });
        for (const c of checks) {
          if (c.committed + input.usdMicros > c.capMicros) return { ok: false as const, code: "BUDGET_EXCEEDED" as const, cap: c.cap, spentMicros: c.committed };
        }
        const reservationId = `rsv_${randomBytes(8).toString("hex")}`;
        append({ at: wallNow().toISOString(), runId: input.runId, kind: "reserve", reservationId, usdMicros: Math.ceil(input.usdMicros), model: input.model, live: input.live, ...(world !== undefined ? { world } : {}) });
        return { ok: true as const, reservationId };
      });
    },
    async settle(reservationId, actualUsdMicros) {
      await withLock(() => {
        const r = findReservation(reservationId);
        if (!r) return;
        append({ at: r.at, runId: r.runId, kind: "settle", reservationId, usdMicros: Math.max(0, Math.ceil(actualUsdMicros)), model: r.model, live: r.live, ...(r.world !== undefined ? { world: r.world } : {}) });
      });
    },
    async release(reservationId) {
      await withLock(() => {
        const r = findReservation(reservationId);
        if (!r) return;
        append({ at: r.at, runId: r.runId, kind: "release", reservationId, usdMicros: 0, model: r.model, live: r.live, ...(r.world !== undefined ? { world: r.world } : {}) });
      });
    },
    async spent(scope) {
      return totals(inWorld(scope)).settledMicros;
    },
    async committed(scope) {
      return totals(inWorld(scope));
    },
    entries(day) {
      return readDay(day ?? today());
    },
  };
}
