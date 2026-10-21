// The durable database facade (docs/cloudflare/design.md 4.2): drizzle-orm/libsql over a SQLite-backed Durable
// Object's storage, so every Db and DbTx type and every query Weft builds stay exactly as they are on Node.
//
// - DurableSession.transaction(cb) is storage.transaction(async () => cb(tx)), and a nested tx.transaction(cb) is the
//   same call nested. The drizzle callback runs inside the storage closure, so every write it issues, after any
//   number of awaits, belongs to the transaction, and an inner throw rolls back only the inner part. Drizzle's
//   savepoint, release and rollback-to statements are never emitted.
// - facadeClient.transaction() throws UNSUPPORTED_LINEAR_TRANSACTION: the deferred-commit and linear begin/commit
//   shapes are unreachable (the conformance suite keeps them as negative cases).
// - rowsAffected and lastInsertRowid come from SELECT changes(), last_insert_rowid() after each statement that
//   returns no rows, as libsql reports them; never from cursor.rowsWritten, which counts index entries.
// - batch() and migrate() run in transactionSync; executeMultiple drops the PRAGMAs workerd refuses; statements over
//   100 bound parameters are rewritten with inlined literals; values over 2 MB are refused; workerd's
//   "(extended: SQLITE_...)" suffix becomes `code` and `extendedCode`, as on a LibsqlError.
// - The meter records rows and tables per statement and bumps table versions per commit; the IO_IN_TX guard is on
//   for the whole outer transaction.
//
// Nothing here imports node:fs, @libsql/client or Cloudflare types, so CompanyDO can load it.
import { createTableRelationsHelpers, extractTablesRelationalConfig } from "drizzle-orm";
import { LibSQLDatabase } from "drizzle-orm/libsql/driver-core";
import { LibSQLSession, LibSQLTransaction } from "drizzle-orm/libsql/session";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import type { Client, InArgs, InStatement, ResultSet, Row, TransactionMode } from "@libsql/client";
import { AsyncLocalStorage } from "node:async_hooks";
import { DO_SQL_LIMITS, DURABLE_DB_ERRORS, REFUSED_PRAGMAS, type DurableDbHandle, type DurableStorageLike, type OpenDurableDbOptions, type SqlCursorLike } from "../../contracts/src/ext/cf-db";
import * as schema from "./schema";
import { createSqlMeter, type SqlMeterControl } from "./meter";
import { createTxGuard, DurableDbError, type TxGuardControl } from "./tx-guard";
import { inlineParameters, leadingWords, onlyAnonymousParameters, parameterCount, splitStatements, statementKind, tablesOf, targetTable, tokenize } from "./sqltext";
import { parseWorkerdSuffix } from "./sqlite-errors";
import type { Db } from "./client";

export { DurableDbError } from "./tx-guard";

// ---- values -------------------------------------------------------------------------------------------------------

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const textEncoder = new TextEncoder();

/** libsql's argument conversion (lib-esm/sqlite3.js valueToSql), producing values workerd binds the same way. */
export function libsqlArg(v: unknown): string | number | null | Uint8Array {
  if (v === null) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new RangeError("Only finite numbers (not Infinity or NaN) can be passed as arguments");
    return v;
  }
  if (typeof v === "string") return v;
  if (typeof v === "bigint") {
    if (v < -MAX_SAFE || v > MAX_SAFE) throw new RangeError("bigint is outside the range a Durable Object can bind exactly (it binds numbers only)");
    return Number(v);
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof Date) return v.valueOf();
  if (v === undefined) throw new TypeError("undefined cannot be passed as argument to the database");
  return v as string;
}

function byteLength(v: string | number | null | Uint8Array): number {
  if (typeof v === "string") return v.length * 3 <= DO_SQL_LIMITS.maxValueBytes ? 0 : textEncoder.encode(v).byteLength;
  if (v instanceof Uint8Array) return v.byteLength;
  return 0;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** A SQL literal that reads back as the bound value would (JS numbers bind as REAL in workerd and libsql alike). */
export function sqlLiteral(v: string | number | null | Uint8Array): string {
  if (v === null) return "NULL";
  if (typeof v === "number") {
    if (Object.is(v, -0)) return "-0.0";
    const s = String(v);
    return /[.eE]/.test(s) ? s : `${s}.0`;
  }
  if (v instanceof Uint8Array) return `X'${hex(v)}'`;
  if (v.includes("\u0000")) return `CAST(X'${hex(textEncoder.encode(v))}' AS TEXT)`;
  return `'${v.replace(/'/g, "''")}'`;
}

/** Named arguments in the order the statement first names them (workerd binds positionally). */
function positional(sqlText: string, args: InArgs | undefined): unknown[] {
  if (!args) return [];
  if (Array.isArray(args)) return args;
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const t of tokenize(sqlText)) {
    if (t.kind !== "param" || t.text === "?" || /^\?\d+$/.test(t.text)) continue;
    const name = t.text.slice(1);
    if (seen.has(name)) continue;
    seen.add(name);
    const rec = args as Record<string, unknown>;
    out.push(name in rec ? rec[name] : rec[t.text]);
  }
  return out;
}

// ---- results ------------------------------------------------------------------------------------------------------

/** libsql's row shape: indexed values (not enumerable), named columns (enumerable, first one wins), and length. */
function libsqlRow(values: readonly unknown[], columns: readonly string[]): Row {
  const row: Record<string | number, unknown> = {};
  Object.defineProperty(row, "length", { value: values.length });
  for (let i = 0; i < values.length; i++) {
    Object.defineProperty(row, i, { value: values[i] });
    const c = columns[i]!;
    if (!Object.hasOwn(row, c)) Object.defineProperty(row, c, { value: values[i], enumerable: true, configurable: true, writable: true });
  }
  return row as unknown as Row;
}

class DurableResultSet implements ResultSet {
  constructor(readonly columns: string[], readonly columnTypes: string[], readonly rows: Row[], readonly rowsAffected: number, readonly lastInsertRowid: bigint | undefined) {}
  toJSON() {
    return { columns: this.columns, columnTypes: this.columnTypes, rows: this.rows.map((r) => Array.prototype.slice.call(r)), rowsAffected: this.rowsAffected, lastInsertRowid: this.lastInsertRowid === undefined ? null : String(this.lastInsertRowid) };
  }
}

function mapError(e: unknown): unknown {
  if (e instanceof DurableDbError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const parsed = parseWorkerdSuffix(message);
  if (!parsed) return e;
  return new DurableDbError(parsed.code, `${parsed.code}: ${parsed.message}`, parsed.extendedCode, { cause: e });
}

// ---- the facade ---------------------------------------------------------------------------------------------------

interface TxFrame { open: boolean; written: Set<string>; parent: TxFrame | null }

export interface DurableFacade {
  readonly storage: DurableStorageLike;
  readonly meter: SqlMeterControl;
  readonly guard: TxGuardControl;
  /** The open facade transaction of the current async context, if any. */
  frame(): TxFrame | null;
  /** Runs `body` as a transaction: nested in the current one when there is one. */
  transaction<T>(body: () => Promise<T>): Promise<T>;
  executeSync(stmt: InStatement): ResultSet;
  refreshTables(): void;
}

const unsupported = () => new DurableDbError(DURABLE_DB_ERRORS.linearTransaction,
  "UNSUPPORTED_LINEAR_TRANSACTION: the durable facade never opens a linear (begin, then commit later) transaction. Use db.transaction(async (tx) => ...): it runs inside storage.transaction, where every write after any await belongs to the transaction.");

function createFacade(storage: DurableStorageLike, meter: SqlMeterControl, guard: TxGuardControl): DurableFacade & { client: Client } {
  const frames = new AsyncLocalStorage<TxFrame>();
  let known: Set<string> | null = null;
  const refreshTables = () => {
    known = new Set((storage.sql.exec("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").toArray() as { name: string }[]).map((r) => String(r.name)));
  };
  const currentFrame = (): TxFrame | null => {
    let f = frames.getStore() ?? null;
    while (f && !f.open) f = f.parent;
    return f;
  };

  const run = (sqlText: string, args: unknown[]): SqlCursorLike => {
    try { return storage.sql.exec(sqlText, ...args); } catch (e) { throw mapError(e); }
  };

  const executeSync = (stmt: InStatement): ResultSet => {
    let sqlText = typeof stmt === "string" ? stmt : stmt.sql;
    let args = (typeof stmt === "string" ? [] : positional(sqlText, stmt.args)).map(libsqlArg);
    for (const a of args) {
      const n = byteLength(a);
      if (n > DO_SQL_LIMITS.maxValueBytes) {
        throw new DurableDbError(DURABLE_DB_ERRORS.valueTooLarge, `SQL_VALUE_TOO_LARGE: a bound value of ${n} bytes is over the ${DO_SQL_LIMITS.maxValueBytes}-byte Durable Object row limit`);
      }
    }
    if (args.length > DO_SQL_LIMITS.maxBoundParameters && onlyAnonymousParameters(sqlText) && parameterCount(sqlText) === args.length) {
      sqlText = inlineParameters(sqlText, args, (v) => sqlLiteral(v as string | number | null | Uint8Array));
      args = [];
    }
    const cursor = run(sqlText, args);
    const columns = [...cursor.columnNames];
    const values = [...cursor.raw()];
    const kind = statementKind(sqlText);
    if (kind === "ddl" || known === null) refreshTables();
    const tables = tablesOf(sqlText, known!);
    let rowsAffected = 0;
    let lastInsertRowid: bigint | undefined;
    if (columns.length === 0) {
      const c = storage.sql.exec("SELECT changes() AS c, last_insert_rowid() AS r").one();
      rowsAffected = Number(c.c);
      lastInsertRowid = BigInt(Number(c.r));
    }
    meter.record({ rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten, tablesRead: tables.read, tablesWritten: tables.written });
    // A write that changed nothing (an UPDATE matching no row, an INSERT ... DO NOTHING) bumps no version, so polls
    // over that table keep their ETag. DDL bumps the table it names.
    const changed = kind === "ddl" ? [targetTable(sqlText)].filter((t): t is string => Boolean(t))
      : tables.written.length > 0 && (rowsAffected > 0 || columns.length > 0) ? tables.written : [];
    if (changed.length > 0) {
      const f = currentFrame();
      if (f) for (const t of changed) f.written.add(t);
      else meter.commit(changed);
    }
    return new DurableResultSet(columns, columns.map(() => ""), values.map((v) => libsqlRow(v, columns)), rowsAffected, lastInsertRowid);
  };

  const transaction = async <T>(body: () => Promise<T>): Promise<T> => {
    const parent = currentFrame();
    const frame: TxFrame = { open: true, written: new Set(), parent };
    const outer = () => storage.transaction(() => frames.run(frame, body));
    let value: T;
    try {
      value = parent ? await outer() : await guard.within(outer);
    } finally {
      frame.open = false;
    }
    if (parent) for (const t of frame.written) parent.written.add(t);
    else meter.commit(frame.written);
    return value;
  };

  const executeSyncMany = (stmts: InStatement[]) => stmts.map((s) => executeSync(s));
  const syncTransaction = <T>(fn: () => T): T => {
    const parent = currentFrame();
    const frame: TxFrame = { open: true, written: new Set(), parent };
    let value: T;
    try {
      value = storage.transactionSync(() => frames.run(frame, fn));
    } finally {
      frame.open = false;
    }
    if (parent) for (const t of frame.written) parent.written.add(t);
    else meter.commit(frame.written);
    return value;
  };

  /**
   * PRAGMA foreign_keys outside a transaction, with libsql's meaning: it takes effect. workerd coalesces writes into an
   * implicit transaction that commits at the end of the turn, and inside it the PRAGMA is a no-op (verified locally),
   * so the facade lets that transaction commit (a timer turn) and retries until the setting reads back. Inside a
   * transaction the PRAGMA is a no-op on libsql as well, so it runs once as given.
   */
  const FOREIGN_KEYS = /^\s*PRAGMA\s+foreign_keys\s*=\s*(on|off|true|false|yes|no|1|0)\s*;?\s*$/i;
  const executeAsync = async (stmt: InStatement): Promise<ResultSet> => {
    const text = typeof stmt === "string" ? stmt : stmt.sql;
    const m = FOREIGN_KEYS.exec(text);
    if (!m || currentFrame()) return executeSync(stmt);
    const want = /^(on|true|yes|1)$/i.test(m[1]!) ? 1 : 0;
    let result = executeSync(stmt);
    for (let i = 0; i < 5 && Number(storage.sql.exec("PRAGMA foreign_keys").one().foreign_keys) !== want; i++) {
      await new Promise((r) => setTimeout(r, 0));
      result = executeSync(stmt);
    }
    return result;
  };

  let closed = false;
  const client = {
    get closed() { return closed; },
    protocol: "file",
    async execute(stmtOrSql: InStatement | string, args?: InArgs): Promise<ResultSet> {
      const stmt: InStatement = typeof stmtOrSql === "string" && args !== undefined ? { sql: stmtOrSql, args } : stmtOrSql;
      return executeAsync(stmt);
    },
    async batch(stmts: Array<InStatement | [string, InArgs?]>, _mode?: TransactionMode): Promise<ResultSet[]> {
      const norm = stmts.map((s) => (Array.isArray(s) ? { sql: s[0], args: s[1] ?? [] } : s)) as InStatement[];
      return syncTransaction(() => executeSyncMany(norm));
    },
    async migrate(stmts: InStatement[]): Promise<ResultSet[]> {
      // libsql turns foreign keys off around a migration batch; inside a Durable Object transaction the PRAGMA is a
      // no-op, so checks are deferred to the commit instead.
      return syncTransaction(() => { executeSync("PRAGMA defer_foreign_keys = ON"); return executeSyncMany(stmts); });
    },
    async transaction(): Promise<never> { throw unsupported(); },
    async executeMultiple(text: string): Promise<void> {
      for (const s of splitStatements(text)) {
        const [verb, name] = leadingWords(s, 2);
        const pragma = verb === "PRAGMA" ? (name ?? "").toLowerCase().split("=")[0]!.trim() : "";
        if (pragma && REFUSED_PRAGMAS.includes(pragma)) continue;
        await executeAsync(s);
      }
    },
    async sync() { return undefined; },
    async reconnect() { /* one storage, nothing to reconnect */ },
    close() { closed = true; },
  } as unknown as Client;

  return {
    storage, meter, guard, client, executeSync, refreshTables,
    frame: currentFrame,
    transaction,
  };
}

// ---- drizzle session and transaction ------------------------------------------------------------------------------

type Rel = ReturnType<typeof relational>;
function relational() {
  const tablesConfig = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
  return { fullSchema: schema, schema: tablesConfig.tables, tableNamesMap: tablesConfig.tableNamesMap };
}

type Tx = LibSQLTransaction<typeof schema, Rel["schema"]>;

/** drizzle's LibSQLSession with the transaction mapped onto storage.transaction (closure form). */
export class DurableSession extends LibSQLSession<typeof schema, Rel["schema"]> {
  constructor(private readonly facade: DurableFacade & { client: Client }, private readonly dialectRef: SQLiteAsyncDialect, private readonly rel: Rel) {
    super(facade.client, dialectRef, rel, {}, undefined);
  }
  override async transaction<T>(cb: (tx: Tx) => T | Promise<T>): Promise<T> {
    return this.facade.transaction(async () => cb(new DurableTransaction(this.dialectRef, this, this.rel, 0, this.facade)));
  }
}

/** drizzle's LibSQLTransaction whose nested transaction (a savepoint on libsql) is a nested storage.transaction. */
export class DurableTransaction extends LibSQLTransaction<typeof schema, Rel["schema"]> {
  constructor(private readonly dialectRef: SQLiteAsyncDialect, private readonly sessionRef: DurableSession, private readonly rel: Rel, nestedIndex: number, private readonly facade: DurableFacade) {
    super("async", dialectRef, sessionRef as never, rel as never, nestedIndex);
  }
  override async transaction<T>(cb: (tx: Tx) => Promise<T>): Promise<T> {
    return this.facade.transaction(async () => cb(new DurableTransaction(this.dialectRef, this.sessionRef, this.rel, this.nestedIndex + 1, this.facade)));
  }
}

// ---- entry point --------------------------------------------------------------------------------------------------

export interface DurableDb extends DurableDbHandle<Db> {
  readonly storage: DurableStorageLike;
  readonly facade: DurableFacade;
}

const handles = new WeakMap<object, DurableDb>();

/** The durable handle behind a Db opened by openDurableDb (or openDb under WEFT_DB=durable-emu), else null. */
export function durableHandleOf(db: object): DurableDb | null { return handles.get(db) ?? null; }

/**
 * Opens Weft's Db over a Durable Object's storage (or the node:sqlite emulator). The returned db is typed and behaves
 * as @weft/db's Db: `$client` is the facade client, `db.transaction` runs in storage.transaction.
 */
export function openDurableDb(storage: DurableStorageLike, opts: OpenDurableDbOptions = {}): DurableDb {
  const meter = (opts.meter as SqlMeterControl | undefined) ?? createSqlMeter();
  if (typeof (meter as Partial<SqlMeterControl>).record !== "function") throw new TypeError("openDurableDb: opts.meter must come from createSqlMeter()");
  const guard = (opts.guard as TxGuardControl | undefined) ?? createTxGuard();
  if (typeof (guard as Partial<TxGuardControl>).within !== "function") throw new TypeError("openDurableDb: opts.guard must come from createTxGuard()");
  const facade = createFacade(storage, meter, guard);
  const dialect = new SQLiteAsyncDialect({});
  const rel = relational();
  const session = new DurableSession(facade, dialect, rel);
  const db = new LibSQLDatabase("async", dialect, session as never, rel as never) as unknown as Db;
  (db as unknown as { $client: Client }).$client = facade.client;
  const handle: DurableDb = { db, meter, guard, storage, facade };
  handles.set(db, handle);
  handles.set(facade.client, handle);
  return handle;
}
