// The SQL spend store SpendDO runs (docs/cloudflare/design.md 4.1 and 4.3): `spend_entries` holds the same lines as
// the Node ledger's JSONL files and is never reset; `neuron_entries` records the neurons each Workers AI reservation
// settled at, for `pnpm cf:budget` to compare with the account's neuron analytics. The fold, totals and caps are
// spend-core.ts, so this store and the file store give identical results.
//
// Typed structurally over the part of a SQLite Durable Object's `ctx.storage` it uses (cf-db.ts), so it runs on
// workerd, on the node:sqlite emulator and on plain node:sqlite in tests. SpendDO is the only writer, so query results
// are memoized in memory and kept current on every append: after the first read of a day, a reservation reads 0 rows.
// Rows written per entry: the row plus its index entries (day, reservation, and run for entries that have one).
// Every statement's cursor is read to the end, so a write has finished before the next statement runs.
import type { DurableStorageLike, SqlRow } from "../../contracts/src/ext/cf-db";
import { randomReservationId, type EntryQuery, type LedgerEntry, type SpendStore } from "./spend-core";
import type { NeuronProduct } from "../../contracts/src/ext/cf-agent";

export type SqlSpendStorage = Pick<DurableStorageLike, "sql" | "transactionSync">;

export const SPEND_SCHEMA_VERSION = "1";

/** Hand-written schema with a version row (design 9.5: "Lobby and Spend: small hand-written schemas"). */
export const SPEND_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS spend_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS spend_entries (
    seq INTEGER PRIMARY KEY, at TEXT NOT NULL, day TEXT NOT NULL, world TEXT, run_id TEXT, kind TEXT NOT NULL,
    reservation_id TEXT NOT NULL, usd_micros INTEGER NOT NULL, model TEXT NOT NULL, live INTEGER NOT NULL,
    visitor TEXT, ip_hash TEXT, neurons INTEGER, product TEXT)`,
  `CREATE INDEX IF NOT EXISTS spend_entries_day ON spend_entries(day)`,
  `CREATE INDEX IF NOT EXISTS spend_entries_reservation ON spend_entries(reservation_id)`,
  `CREATE INDEX IF NOT EXISTS spend_entries_run ON spend_entries(run_id, world) WHERE run_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS neuron_entries (seq INTEGER PRIMARY KEY, day TEXT NOT NULL, product TEXT NOT NULL, model TEXT NOT NULL, neurons INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS neuron_entries_day ON neuron_entries(day)`,
];

const COLUMNS = "at, day, world, run_id, kind, reservation_id, usd_micros, model, live, visitor, ip_hash, neurons, product";

/** Memoized entries are dropped wholesale past this many, and read again on the next miss. */
const MEMO_MAX_ENTRIES = 20_000;

function toEntry(r: SqlRow): LedgerEntry {
  const s = (v: unknown) => (v === null || v === undefined ? undefined : String(v));
  const e: LedgerEntry = {
    at: String(r.at), runId: r.run_id === null ? null : String(r.run_id), kind: String(r.kind) as LedgerEntry["kind"],
    reservationId: String(r.reservation_id), usdMicros: Number(r.usd_micros), model: String(r.model), live: Number(r.live) === 1,
  };
  const world = s(r.world), visitor = s(r.visitor), ipHash = s(r.ip_hash), product = s(r.product);
  if (world !== undefined) e.world = world;
  if (visitor !== undefined) e.visitor = visitor;
  if (ipHash !== undefined) e.ipHash = ipHash;
  if (r.neurons !== null && r.neurons !== undefined) e.neurons = Number(r.neurons);
  if (product !== undefined) e.product = product as NeuronProduct;
  return e;
}

export interface SqlSpendStore extends SpendStore {
  readonly kind: "sqlite";
  /** Settled neurons per product for a day, from neuron_entries. */
  neuronsSettled(day: string): Record<string, number>;
  /** Drops the in-memory memo (tests; a SpendDO restart starts without one). */
  forget(): void;
}

export function createSqlSpendStore(storage: SqlSpendStorage): SqlSpendStore {
  const sql = storage.sql;
  storage.transactionSync(() => {
    for (const s of SPEND_SCHEMA) sql.exec(s).toArray();
    sql.exec(`INSERT OR IGNORE INTO spend_meta (key, value) VALUES ('schema', ?)`, SPEND_SCHEMA_VERSION).toArray();
  });
  const version = sql.exec<{ value: string }>(`SELECT value FROM spend_meta WHERE key = 'schema'`).toArray()[0]?.value;
  if (version !== SPEND_SCHEMA_VERSION) throw new Error(`spend schema version ${String(version)} is not ${SPEND_SCHEMA_VERSION}`);

  const memo = new Map<string, { match: (e: LedgerEntry) => boolean; rows: LedgerEntry[] }>();
  let memoSize = 0;
  const remember = (key: string, match: (e: LedgerEntry) => boolean, load: () => LedgerEntry[]): LedgerEntry[] => {
    const hit = memo.get(key);
    if (hit) return hit.rows;
    const rows = load();
    if (memoSize + rows.length > MEMO_MAX_ENTRIES) { memo.clear(); memoSize = 0; }
    memo.set(key, { match, rows });
    memoSize += rows.length;
    return rows;
  };
  const select = (where: string, ...args: unknown[]): LedgerEntry[] =>
    sql.exec(`SELECT ${COLUMNS} FROM spend_entries${where ? ` WHERE ${where}` : ""} ORDER BY seq`, ...args).toArray().map(toEntry);

  return {
    kind: "sqlite",
    async exclusive(fn) {
      return storage.transactionSync(fn);
    },
    entries(q: EntryQuery) {
      if (q.reservationId !== undefined) return select("reservation_id = ?", q.reservationId);
      if (q.days) return q.days.flatMap((day) => remember(`d:${day}`, (e) => e.at.slice(0, 10) === day, () => select("day = ?", day)));
      if (q.runId !== undefined) {
        const { runId, world } = q;
        return world === undefined
          ? remember(`r:*:${runId}`, (e) => e.runId === runId, () => select("run_id = ?", runId))
          : remember(`r:${world}:${runId}`, (e) => e.runId === runId && e.world === world, () => select("run_id = ? AND world = ?", runId, world));
      }
      if (q.live === true) return remember("live", (e) => e.live, () => select("live = 1"));
      return select("");
    },
    append(e) {
      const day = e.at.slice(0, 10);
      sql.exec(`INSERT INTO spend_entries (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        e.at, day, e.world ?? null, e.runId, e.kind, e.reservationId, e.usdMicros, e.model, e.live ? 1 : 0, e.visitor ?? null, e.ipHash ?? null,
        e.neurons ?? null, e.product ?? null).toArray();
      if (e.kind === "settle" && (e.neurons ?? 0) > 0) {
        sql.exec(`INSERT INTO neuron_entries (day, product, model, neurons) VALUES (?, ?, ?, ?)`, day, e.product ?? "agent", e.model, e.neurons).toArray();
      }
      for (const m of memo.values()) if (m.match(e)) { m.rows.push(e); memoSize++; }
    },
    newReservationId: randomReservationId,
    neuronsSettled(day) {
      const out: Record<string, number> = {};
      for (const r of sql.exec<{ product: string; n: number }>(`SELECT product, SUM(neurons) AS n FROM neuron_entries WHERE day = ? GROUP BY product`, day).toArray()) out[r.product] = Number(r.n);
      return out;
    },
    forget() { memo.clear(); memoSize = 0; },
  };
}
