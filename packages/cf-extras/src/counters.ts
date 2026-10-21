// Daily counters for the extras' hard caps (design 6.3): Help queries (30 a day) and Browser Run seconds (300 a day).
// They live in LobbyDO, which is strongly consistent, so the cap holds across isolates; the Rate Limiting binding is
// never the cap. `sqlDailyCounters` is the implementation LobbyDO mounts on its own `ctx.storage.sql` (one small
// table, one row per counter per UTC day); `memoryDailyCounters` is for tests. Track cf6-extras.
import type { SqlStorageLike } from "./bindings";
import { utcDay } from "./bytes";

export type CounterName = "help.queries" | "pdf.browser_ms" | (string & {});
export interface CounterTake { ok: boolean; used: number; left: number }

export interface DailyCounters {
  /** Adds `n` to today's counter unless that would pass `cap`; `ok` false leaves it unchanged. */
  take(name: CounterName, n: number, cap: number, day?: string): Promise<CounterTake>;
  /** Adds `n` unconditionally (a measured amount, such as browser time already used). */
  add(name: CounterName, n: number, day?: string): Promise<number>;
  peek(name: CounterName, day?: string): Promise<number>;
}

export const COUNTERS = { help: "help.queries", browserMs: "pdf.browser_ms" } as const;

export function memoryDailyCounters(now: () => Date = () => new Date()): DailyCounters & { dump(): Record<string, number> } {
  const m = new Map<string, number>();
  const k = (name: string, day?: string) => `${day ?? utcDay(now())}|${name}`;
  return {
    async take(name, n, cap, day) {
      const key = k(name, day);
      const used = m.get(key) ?? 0;
      if (used + n > cap) return { ok: false, used, left: Math.max(0, cap - used) };
      m.set(key, used + n);
      return { ok: true, used: used + n, left: Math.max(0, cap - used - n) };
    },
    async add(name, n, day) { const key = k(name, day); const v = (m.get(key) ?? 0) + n; m.set(key, v); return v; },
    async peek(name, day) { return m.get(k(name, day)) ?? 0; },
    dump: () => Object.fromEntries(m),
  };
}

export const COUNTER_TABLE = "extras_daily";
const DDL = `CREATE TABLE IF NOT EXISTS ${COUNTER_TABLE} (day TEXT NOT NULL, name TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (day, name))`;

/**
 * Counters over a Durable Object's SQLite. Synchronous SQL inside one DO call, so a take is atomic: the object's input
 * gate serializes calls. Rows older than `keepDays` are deleted on the first write of a new day.
 */
export function sqlDailyCounters(sql: SqlStorageLike, opts: { now?: () => Date; keepDays?: number } = {}): DailyCounters {
  const now = opts.now ?? (() => new Date());
  const keepDays = opts.keepDays ?? 7;
  let ready = false;
  let prunedFor: string | null = null;
  const init = () => { if (!ready) { sql.exec(DDL); ready = true; } };
  const read = (day: string, name: string): number => {
    const rows = sql.exec<{ used: number }>(`SELECT used FROM ${COUNTER_TABLE} WHERE day = ? AND name = ?`, day, name).toArray();
    return rows.length ? Number(rows[0]!.used) : 0;
  };
  const write = (day: string, name: string, used: number) => {
    sql.exec(`INSERT INTO ${COUNTER_TABLE} (day, name, used) VALUES (?, ?, ?) ON CONFLICT (day, name) DO UPDATE SET used = excluded.used`, day, name, used);
    const today = utcDay(now());
    if (prunedFor !== today) {
      const cutoff = utcDay(new Date(Date.parse(`${today}T00:00:00Z`) - keepDays * 86_400_000));
      sql.exec(`DELETE FROM ${COUNTER_TABLE} WHERE day < ?`, cutoff);
      prunedFor = today;
    }
  };
  return {
    async take(name, n, cap, day) {
      init();
      const d = day ?? utcDay(now());
      const used = read(d, name);
      if (used + n > cap) return { ok: false, used, left: Math.max(0, cap - used) };
      write(d, name, used + n);
      return { ok: true, used: used + n, left: Math.max(0, cap - used - n) };
    },
    async add(name, n, day) {
      init();
      const d = day ?? utcDay(now());
      const v = read(d, name) + n;
      write(d, name, v);
      return v;
    },
    async peek(name, day) { init(); return read(day ?? utcDay(now()), name); },
  };
}

/** The RPC methods LobbyDO exposes for these counters (cf4-worker; see the cf6 contract requests). */
export interface LobbyCounterRpc {
  extrasCounterTake(name: string, n: number, cap: number, day?: string): Promise<CounterTake>;
  extrasCounterAdd(name: string, n: number, day?: string): Promise<number>;
  extrasCounterPeek(name: string, day?: string): Promise<number>;
}
/** DailyCounters over a LobbyDO stub. */
export function lobbyCounters(stub: LobbyCounterRpc): DailyCounters {
  return {
    take: (name, n, cap, day) => stub.extrasCounterTake(name, n, cap, day),
    add: (name, n, day) => stub.extrasCounterAdd(name, n, day),
    peek: (name, day) => stub.extrasCounterPeek(name, day),
  };
}
