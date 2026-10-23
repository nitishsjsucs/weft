// Weft on Cloudflare, round 0 contract (track cf0-contracts; docs/cloudflare/design.md 4.1 to 4.6). Additive only.
// The durable database facade: the Durable Object storage it runs on (typed structurally, so nothing outside apps/cf
// and packages/cf-extras imports Cloudflare types), its meter, the IO_IN_TX guard, WorldScope and the hosted tables.
// Implemented by cf1-db in packages/db (durable.ts, meter.ts, tx-guard.ts, scope.ts, emu.ts, migrate-durable.ts,
// snapshot.ts). Types, constants and pure helpers only: a Worker that imports this file evaluates no schema code.

/** A value DO SQLite binds or returns (workerd's SqlStorageValue). */
export type SqlStorageValue = ArrayBuffer | string | number | null;
export type SqlRow = Record<string, SqlStorageValue>;

/** What `sql.exec` returns: structurally workerd's SqlStorageCursor, and what the node:sqlite emulator returns too. */
export interface SqlCursorLike<T extends SqlRow = SqlRow> extends Iterable<T> {
  next(): IteratorResult<T, undefined>;
  toArray(): T[];
  /** Exactly one row, or it throws. */
  one(): T;
  raw<U extends SqlStorageValue[]>(): IterableIterator<U>;
  readonly columnNames: string[];
  /** Rows read so far, as billed. */
  readonly rowsRead: number;
  /** Rows written as billed. It counts index entries too (2 against changes() 1 on a compare-and-set, verified
   * locally), so it is never the source of rowsAffected; the facade reads `SELECT changes(), last_insert_rowid()`. */
  readonly rowsWritten: number;
}

export interface SqlStorageLike {
  exec<T extends SqlRow = SqlRow>(query: string, ...bindings: unknown[]): SqlCursorLike<T>;
  readonly databaseSize: number;
}

/**
 * The part of a SQLite-backed Durable Object's `ctx.storage` the facade, the migrator and the resets use. workerd's
 * DurableObjectStorage is assignable to it, and so is the emulator (`emu.ts`, `WEFT_DB=durable-emu`). Alarms are not
 * part of it: CompanyDO uses `ctx.storage` directly for those.
 */
export interface DurableStorageLike {
  readonly sql: SqlStorageLike;
  /**
   * The closure form is the only transaction the facade uses (design 4.2): drizzle's callback runs inside the closure,
   * so every write it issues after any number of awaits belongs to the transaction. Nested calls roll back the inner
   * part only. The transaction holds the object's input gate; a body still waiting after 30 s resets the object.
   */
  transaction<T>(closure: (txn: unknown) => Promise<T>): Promise<T>;
  /** Used for `batch()`, each migration journal entry and the delta reset. */
  transactionSync<T>(closure: () => T): T;
  /** Full restore: drops every table (and, from compatibility date 2026-02-24, the alarm). */
  deleteAll(): Promise<void>;
  /** Point-in-time recovery (design 4.6); absent in the emulator and in Miniflare. */
  getCurrentBookmark?(): Promise<string>;
  onNextSessionRestoreBookmark?(bookmark: string): Promise<string>;
}

/** Statement and row counts for one measured span or the meter's lifetime. */
export interface SqlUsage {
  statements: number;
  rowsRead: number;
  rowsWritten: number;
  /** Tables named in the statements, from drizzle's quoted identifiers; sorted, no duplicates. */
  tablesRead: string[];
  tablesWritten: string[];
}

/** One committed outer transaction (or autocommit write) that wrote at least one table. */
export interface SqlCommit {
  /** Increases by one per commit, from 1 after each restart. The WebSocket feed sends it. */
  seq: number;
  tables: string[];
}

/**
 * The facade meter (design 4.2 and 4.5). It feeds the ETag versions, the clean-slot check, the Lobby's daily counters
 * and the tests. Versions live in memory and start again after a restart, so the first poll after one computes.
 */
export interface SqlMeter {
  /** Runs `fn` and returns what it cost; a nested measure counts toward every enclosing one. */
  measure<T>(fn: () => Promise<T>): Promise<{ value: T; usage: SqlUsage }>;
  /** Totals since the meter was created or last reset. */
  totals(): SqlUsage;
  reset(): void;
  /** 0 until a commit writes the table, then bumped once per commit that wrote it. */
  version(table: string): number;
  versions(tables: Iterable<string>): Record<string, number>;
  /** Called after every commit that wrote a table; returns the unsubscribe function. */
  onCommit(listener: (commit: SqlCommit) => void): () => void;
}

/**
 * The runtime IO_IN_TX guard (design 4.2). `inTx()` is true for the whole outer transaction. On the durable platform
 * the R2-backed BlobStore, the provider transports, the Queue producer and every DO RPC stub call `assertNotInTx`.
 */
export interface TxGuard {
  inTx(): boolean;
  /** Throws a DurableDbError with code IO_IN_TX naming `what` when called inside a transaction. */
  assertNotInTx(what: string): void;
}

export interface OpenDurableDbOptions {
  /** Share a meter (for example one per CompanyDO); openDurableDb creates one when absent. */
  meter?: SqlMeter;
  guard?: TxGuard;
}

/** What `openDurableDb(storage, opts)` in packages/db returns; `TDb` is @weft/db's `Db`, unchanged. */
export interface DurableDbHandle<TDb> {
  readonly db: TDb;
  readonly meter: SqlMeter;
  readonly guard: TxGuard;
}
export type OpenDurableDb<TDb> = (storage: DurableStorageLike, opts?: OpenDurableDbOptions) => DurableDbHandle<TDb>;

/** Error codes the facade throws (as `code` on the error), beside the SQLite codes it maps from workerd's
 * `(extended: SQLITE_...)` message suffix onto `code` and `extendedCode`. */
export const DURABLE_DB_ERRORS = {
  /** `facadeClient.transaction()`: the deferred-commit and linear begin/commit shapes are unreachable on purpose. */
  linearTransaction: "UNSUPPORTED_LINEAR_TRANSACTION",
  /** Real I/O inside a transaction body. */
  ioInTx: "IO_IN_TX",
  /** A bound value over the 2 MB row limit. */
  valueTooLarge: "SQL_VALUE_TOO_LARGE",
} as const;
export type DurableDbErrorCode = (typeof DURABLE_DB_ERRORS)[keyof typeof DURABLE_DB_ERRORS];

/** DO SQLite limits the facade and the emulator enforce (design 2 and 4.1; developers.cloudflare.com/durable-objects/platform/limits/). */
export const DO_SQL_LIMITS = {
  /** More bound parameters than this are rewritten with inlined literals. */
  maxBoundParameters: 100,
  maxValueBytes: 2 * 1024 * 1024,
  maxStatementBytes: 100 * 1024,
  maxColumns: 100,
  /** A transaction body still waiting on I/O after this resets the object (verified locally). */
  inputGateTimeoutMs: 30_000,
} as const;

/** PRAGMAs workerd refuses with SQLITE_AUTH; `executeMultiple` drops them. `foreign_keys` and `defer_foreign_keys` pass. */
export const REFUSED_PRAGMAS: readonly string[] = ["journal_mode", "busy_timeout"];

/** Tables migration 0008_hosted.sql adds (design 4.1). Empty on Node unless a hosted option is on; the digest skips
 * them while they are empty, so the base and eval digests do not move. */
export const HOSTED_TABLES = ["mem_objects", "mem_refs", "mem_log", "blobs", "run_files", "run_handles", "kv_state", "outbox"] as const;
export type HostedTable = (typeof HOSTED_TABLES)[number];

/** The delta reset's dirty-key table (design 4.6). Created by the snapshot restore on the durable side only; never
 * in a migration, never in a digest. */
export const DIRTY_TABLE = "_weft_dirty";
/**
 * Rows written by the delta reset after the 10-flow engaged session (design 4.6 and 8.2) on the SQL memory repo every
 * hosted world runs: cf1's measured baseline, 717 in workerd (on Linux; 634 on the Mac), whose 25% band the Miniflare
 * suite checks. packages/db/test-workerd/flows.ts records the same measurement as
 * DELTA_RESET_SQL_MEMORY_BASELINE_ROWS; apps/cf's unit suite keeps the two equal. The Lobby's session estimate is built
 * on it.
 */
export const HOSTED_DELTA_RESET_BASELINE_ROWS = 717;
/** workerd lists its own `_cf_KV` table in sqlite_master and refuses every read of it (SQLITE_AUTH, verified locally
 * in Miniflare 5.20261019.1-beta): anything that walks sqlite_master skips this prefix. */
export const RESERVED_TABLE_PREFIX = "_cf_";
/** Blob chunk size in the `blobs` table, under the 2 MB row limit. */
export const BLOB_CHUNK_BYTES = 1024 * 1024;

/**
 * Per-world scope (design 4.2 and 6.4). Several DO instances can share one isolate, so module state that today is a
 * process singleton (the write-lock tail, auth windows, otel `learned`, `recallNotes`, the trace redactor, webhook
 * receivers) is keyed by the current world. Outside any `run`, the world is NODE_WORLD, so Node keeps one world.
 */
export interface WorldScope {
  run<T>(world: string, fn: () => T): T;
  current(): string;
  /** A per-world value, created on first use inside each world. */
  keyed<T>(make: (world: string) => T): () => T;
}
export const NODE_WORLD = "node";

/** `WEFT_DB=durable-emu` makes Node's openDb run on openDurableDb over the node:sqlite emulator (design 11.2). */
export const WEFT_DB_DURABLE_EMU = "durable-emu";
