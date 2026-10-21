// Test support for the durable platform (track cf2-platform): a node:sqlite stand-in for a SQLite-backed Durable
// Object's ctx.storage, and a drizzle facade over it with a meter and the IO_IN_TX guard. It follows the shapes
// docs/cloudflare/design.md 4.2 fixes (closure transactions, nested ones for savepoints, no linear transaction,
// rowsAffected from changes(), per-table commit versions) so apps/api's durable platform runs end to end in plain
// vitest. cf1-db owns the real facade and emulator (packages/db); the integration stage can point
// testDurableDriver() at them (.scratch/contract-requests/cf2-platform.md). Tables read and written come from SQLite's
// own authorizer, so the meter is exact.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { sql as dsql } from "drizzle-orm";
import { createTableRelationsHelpers, extractTablesRelationalConfig } from "drizzle-orm";
import { LibSQLDatabase } from "drizzle-orm/libsql";
import { LibSQLSession, LibSQLTransaction } from "drizzle-orm/libsql/session";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { schema, type Db } from "@weft/db";
import type { DurableDbHandle, DurableStorageLike, SqlCommit, SqlCursorLike, SqlMeter, SqlRow, SqlUsage, TxGuard } from "../../../../packages/contracts/src/ext/cf-db";
import type { FixtureSource } from "../../../../packages/contracts/src/ext/cf-platform";
import type { DurableDbDriver } from "../../src/platform/durable";

const READ = 20, INSERT = 18, UPDATE = 23, DELETE = 9;   // sqlite3 authorizer action codes
const isInternal = (t: string) => t.startsWith("sqlite_") || t === "pragma_table_info";

interface StatementInfo { stmt: StatementSync; reader: boolean; read: Set<string>; written: Set<string> }
export interface EmuStats { statements: number; rowsWritten: number; rowsRead: number }

/** The emulated ctx.storage. `gate()` resolves once no other async context holds a transaction open. */
export interface EmuStorage extends DurableStorageLike {
  readonly db: DatabaseSync;
  /** Tables the last exec read and wrote (from the authorizer). */
  lastTables(): { read: string[]; written: string[] };
  inTransaction(): boolean;
  /** Every statement this storage ran and the rows they wrote, whoever ran them (the facade, small state, migrations). */
  stats(): EmuStats;
  /** Waits while a transaction opened by another async context is still open (workerd's input gate). */
  gate(): Promise<void>;
  onCommit(fn: (tables: string[]) => void): void;
  close(): void;
}

export function createEmuStorage(path = ":memory:"): EmuStorage {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  const cache = new Map<string, StatementInfo>();
  let collecting: { read: Set<string>; written: Set<string> } | null = null;
  db.setAuthorizer((action: number, a: string | null, _b: string | null) => {
    if (collecting && a && !isInternal(a)) {
      if (action === READ) collecting.read.add(a);
      else if (action === INSERT || action === UPDATE || action === DELETE) collecting.written.add(a);
    }
    return 0;   // SQLITE_OK
  });
  const prepare = (q: string): StatementInfo => {
    let info = cache.get(q);
    if (info) return info;
    collecting = { read: new Set(), written: new Set() };
    try {
      if (/^\s*pragma\s+(journal_mode|busy_timeout)\b/i.test(q)) throw Object.assign(new Error("not authorized: SQLITE_AUTH"), { code: "SQLITE_AUTH" });
      const stmt = db.prepare(q);
      // Arrays, as workerd's raw(): a join returns columns with the same name (two "id"s), which objects would merge.
      stmt.setReturnArrays(true);
      info = { stmt, reader: stmt.columns().length > 0, read: collecting.read, written: collecting.written };
    } finally { collecting = null; }
    if (cache.size > 2000) cache.clear();
    cache.set(q, info);
    return info;
  };
  const toBinding = (v: unknown): null | number | bigint | string | Uint8Array => {
    if (v === undefined || v === null) return null;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
    return String(v);
  };
  const fromValue = (v: unknown): SqlRow[string] => {
    if (v instanceof Uint8Array) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
    if (typeof v === "bigint") return Number(v);
    return v as SqlRow[string];
  };

  // Transaction state: one top-level transaction at a time (the object's input gate), with an async context marker.
  const txScope = new AsyncLocalStorage<{ id: number; depth: number }>();
  let open: { id: number; written: Set<string> } | null = null;
  let nextTx = 1, sp = 0;
  let waiters: (() => void)[] = [];
  const commitListeners: ((tables: string[]) => void)[] = [];
  let last = { read: [] as string[], written: [] as string[] };
  const totals: EmuStats = { statements: 0, rowsWritten: 0, rowsRead: 0 };
  const release = () => { const w = waiters; waiters = []; for (const f of w) f(); };
  const inOther = () => !!open && txScope.getStore()?.id !== open.id;
  const gate = async () => { while (inOther()) await new Promise<void>((r) => waiters.push(r)); };
  const commitTables = (tables: Iterable<string>) => { const t = [...new Set(tables)].sort(); if (t.length) for (const l of commitListeners) l(t); };

  const exec = <T extends SqlRow>(query: string, ...bindings: unknown[]): SqlCursorLike<T> => {
    const info = prepare(query);
    const args = bindings.map(toBinding);
    let rows: T[] = [];
    let arrays: SqlRow[string][][] = [];
    let columns: string[] = [];
    let written = 0;
    if (info.reader) {
      arrays = (info.stmt.all(...args) as unknown as unknown[][]).map((r) => r.map(fromValue));
      columns = info.stmt.columns().map((c) => c.name);
      rows = arrays.map((r) => { const o: SqlRow = {}; columns.forEach((c, i) => { if (!(c in o)) o[c] = r[i]!; }); return o as T; });
    } else {
      written = Number(info.stmt.run(...args).changes);
    }
    // INSERT ... RETURNING reads like a query; changes() still counts what it wrote.
    if (info.reader && info.written.size) written = Number((db.prepare("SELECT changes() AS c").get() as { c: number }).c);
    last = { read: [...info.read], written: [...info.written] };
    totals.statements++;
    totals.rowsRead += rows.length;
    if (info.written.size) totals.rowsWritten += written;
    // A statement that changed rows wrote its tables (and, through triggers, theirs); one that changed none wrote nothing.
    if (written > 0 && info.written.size) {
      if (open) for (const t of info.written) open.written.add(t);
      else commitTables(info.written);
    }
    let i = 0;
    const cursor: SqlCursorLike<T> = {
      next: () => (i < rows.length ? { value: rows[i++]!, done: false } : { value: undefined, done: true }),
      toArray: () => rows.slice(i),
      one: () => { if (rows.length !== 1) throw new Error(`Expected exactly one result from SQL query, but got ${rows.length}.`); return rows[0]!; },
      raw: <U extends SqlRow[string][]>() => (arrays as U[])[Symbol.iterator]() as IterableIterator<U>,
      columnNames: columns,
      rowsRead: rows.length,
      rowsWritten: written,
      [Symbol.iterator]: () => rows[Symbol.iterator](),
    };
    return cursor;
  };

  const storage: EmuStorage = {
    db,
    sql: { exec, get databaseSize() { return 0; } },
    async transaction<T>(closure: (txn: unknown) => Promise<T>): Promise<T> {
      const cur = txScope.getStore();
      if (cur && open && cur.id === open.id) {
        const name = `emu_sp${++sp}`;
        db.exec(`SAVEPOINT ${name}`);
        try {
          const v = await txScope.run({ id: cur.id, depth: cur.depth + 1 }, () => closure(null));
          db.exec(`RELEASE ${name}`);
          return v;
        } catch (e) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw e; }
      }
      await gate();
      const id = nextTx++;
      open = { id, written: new Set() };
      db.exec("BEGIN");
      try {
        const v = await txScope.run({ id, depth: 1 }, () => closure(null));
        db.exec("COMMIT");
        const tables = open.written;
        open = null;
        commitTables(tables);
        return v;
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
        open = null;
        throw e;
      } finally { release(); }
    },
    transactionSync<T>(closure: () => T): T {
      const name = `emu_sync${++sp}`;
      const outer = !open && !db.isTransaction;   // a top-level transactionSync commits on its own
      const local = new Set<string>();
      const prevOpen = open;
      if (outer) open = { id: -1, written: local };
      db.exec(`SAVEPOINT ${name}`);
      try {
        const v = closure();
        db.exec(`RELEASE ${name}`);
        if (outer) { open = prevOpen; commitTables(local); }
        return v;
      } catch (e) {
        db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`);
        if (outer) open = prevOpen;
        throw e;
      }
    },
    async deleteAll() {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
      db.exec("PRAGMA foreign_keys = OFF");
      for (const t of tables) db.exec(`DROP TABLE IF EXISTS "${t.replace(/"/g, "")}"`);
      db.exec("PRAGMA foreign_keys = ON");
      cache.clear();
    },
    lastTables: () => last,
    stats: () => ({ ...totals }),
    inTransaction: () => !!open && open.id !== -1 && txScope.getStore()?.id === open.id,
    gate,
    onCommit: (fn) => { commitListeners.push(fn); },
    close: () => { cache.clear(); db.close(); },
  };
  return storage;
}

// ------------------------------------------------------------------------------------------------ meter and guard

function emptyUsage(): SqlUsage { return { statements: 0, rowsRead: 0, rowsWritten: 0, tablesRead: [], tablesWritten: [] }; }
interface Acc { statements: number; rowsRead: number; rowsWritten: number; read: Set<string>; written: Set<string> }
const newAcc = (): Acc => ({ statements: 0, rowsRead: 0, rowsWritten: 0, read: new Set(), written: new Set() });
const usageOf = (a: Acc): SqlUsage => ({ statements: a.statements, rowsRead: a.rowsRead, rowsWritten: a.rowsWritten, tablesRead: [...a.read].sort(), tablesWritten: [...a.written].sort() });

export interface TestMeter extends SqlMeter {
  record(s: { rowsRead: number; rowsWritten: number; read: string[]; written: string[] }): void;
}

export function createTestMeter(storage: EmuStorage): TestMeter {
  const scopes = new AsyncLocalStorage<Acc[]>();
  let total = newAcc();
  const versions = new Map<string, number>();
  let seq = 0;
  const listeners = new Set<(c: SqlCommit) => void>();
  storage.onCommit((tables) => {
    for (const t of tables) versions.set(t, (versions.get(t) ?? 0) + 1);
    const c = { seq: ++seq, tables };
    for (const l of listeners) l(c);
  });
  const add = (a: Acc, s: { rowsRead: number; rowsWritten: number; read: string[]; written: string[] }) => {
    a.statements++; a.rowsRead += s.rowsRead; a.rowsWritten += s.rowsWritten;
    for (const t of s.read) a.read.add(t);
    for (const t of s.written) a.written.add(t);
  };
  return {
    record(s) {
      add(total, s);
      for (const a of scopes.getStore() ?? []) add(a, s);
    },
    async measure<T>(fn: () => Promise<T>) {
      const acc = newAcc();
      const value = await scopes.run([...(scopes.getStore() ?? []), acc], fn);
      return { value, usage: usageOf(acc) };
    },
    totals: () => usageOf(total),
    reset: () => { total = newAcc(); },
    version: (t) => versions.get(t) ?? 0,
    versions: (ts) => Object.fromEntries([...ts].map((t) => [t, versions.get(t) ?? 0])),
    onCommit: (l) => { listeners.add(l); return () => listeners.delete(l); },
  };
}
export const NO_USAGE = emptyUsage();

export function createTestGuard(storage: EmuStorage): TxGuard {
  return {
    inTx: () => storage.inTransaction(),
    assertNotInTx(what) {
      if (storage.inTransaction()) throw Object.assign(new Error(`IO_IN_TX: ${what} inside a transaction`), { code: "IO_IN_TX" });
    },
  };
}

// ------------------------------------------------------------------------------------------------ the drizzle facade

/** A libsql ResultSet row: column names enumerable, indexes and length not (drizzle maps both ways). Built from the
 * raw array, so a join's same-named columns keep their own values by index. */
function libsqlRow(columns: string[], row: SqlRow[string][]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  columns.forEach((c, i) => {
    Object.defineProperty(out, i, { value: row[i], enumerable: false });
    if (!Object.prototype.hasOwnProperty.call(out, c)) Object.defineProperty(out, c, { value: row[i], enumerable: true, writable: true });
  });
  Object.defineProperty(out, "length", { value: columns.length, enumerable: false });
  return out;
}

type Stmt = string | { sql: string; args?: unknown[] | Record<string, unknown> };
const toArgs = (s: Stmt) => (typeof s === "string" ? [] : Array.isArray(s.args) ? s.args : s.args ? Object.values(s.args) : []);
const toSql = (s: Stmt) => (typeof s === "string" ? s : s.sql);
const toBind = (v: unknown) => (Buffer.isBuffer(v) || v instanceof Uint8Array ? (v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer) : typeof v === "boolean" ? (v ? 1 : 0) : v);

export function openTestDurableDb(storage: EmuStorage, meter: TestMeter = createTestMeter(storage), guard: TxGuard = createTestGuard(storage)): DurableDbHandle<Db> {
  const run = (s: Stmt) => {
    const q = toSql(s);
    const cur = storage.sql.exec(q, ...toArgs(s).map(toBind));
    const rows = [...cur.raw()];
    const t = storage.lastTables();
    let rowsAffected = 0, lastInsertRowid: bigint | undefined;
    if (cur.columnNames.length === 0 || t.written.length) {
      const c = storage.sql.exec<{ c: number; r: number }>("SELECT changes() AS c, last_insert_rowid() AS r").one();
      rowsAffected = Number(c.c);
      lastInsertRowid = BigInt(c.r);
    }
    meter.record({ rowsRead: rows.length, rowsWritten: rowsAffected, read: t.read, written: rowsAffected > 0 ? t.written : [] });
    const columns = cur.columnNames;
    return { columns, columnTypes: columns.map(() => ""), rows: rows.map((r) => libsqlRow(columns, r)), rowsAffected, lastInsertRowid, toJSON: () => ({}) };
  };
  const client = {
    closed: false, protocol: "file",
    async execute(s: Stmt) { await storage.gate(); return run(s); },
    async batch(stmts: Stmt[]) { await storage.gate(); return storage.transactionSync(() => stmts.map(run)); },
    async migrate(stmts: Stmt[]) { await storage.gate(); return storage.transactionSync(() => stmts.map(run)); },
    async executeMultiple(text: string) {
      await storage.gate();
      for (const part of text.split(";").map((x) => x.trim()).filter(Boolean)) {
        if (/^pragma\s+(journal_mode|busy_timeout)\b/i.test(part)) continue;
        run(part);
      }
    },
    async transaction() { throw Object.assign(new Error("UNSUPPORTED_LINEAR_TRANSACTION: use db.transaction(callback)"), { code: "UNSUPPORTED_LINEAR_TRANSACTION" }); },
    async sync() { return undefined; },
    close() { /* the storage belongs to the object */ },
  };
  const dialect = new SQLiteAsyncDialect();
  const cfg = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
  const schemaCfg = { fullSchema: schema, schema: cfg.tables, tableNamesMap: cfg.tableNamesMap };

  class DurableTransaction extends LibSQLTransaction<typeof schema, typeof cfg.tables> {
    override async transaction<T>(cb: (tx: DurableTransaction) => Promise<T>): Promise<T> {
      const tx = new DurableTransaction("async", dialect, (this as unknown as { session: never }).session, schemaCfg as never, this.nestedIndex + 1);
      return storage.transaction(() => cb(tx));
    }
  }
  class DurableSession extends LibSQLSession<typeof schema, typeof cfg.tables> {
    override async transaction<T>(cb: (tx: DurableTransaction) => Promise<T>): Promise<T> {
      const tx = new DurableTransaction("async", dialect, this as never, schemaCfg as never);
      return storage.transaction(() => cb(tx));
    }
  }
  const session = new DurableSession(client as never, dialect, schemaCfg as never, {}, undefined);
  const db = new LibSQLDatabase("async", dialect, session as never, schemaCfg as never) as unknown as Db;
  (db as unknown as { $client: unknown }).$client = client;
  return { db, meter, guard };
}

// ------------------------------------------------------------------------------------------------ migrations

/** drizzle's libsql migrator, over the bundled journal and SQL in a FixtureSource, one transactionSync per entry. */
export function migrateFromFixtures(storage: DurableStorageLike, fixtures: FixtureSource): void {
  const journal = JSON.parse(fixtures.text("packages/db/drizzle/meta/_journal.json") ?? "null") as { entries: { tag: string; when: number }[] } | null;
  if (!journal) throw new Error("migrations are not bundled");
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`);
  const lastRow = storage.sql.exec<{ created_at: number }>(`SELECT created_at FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1`).toArray()[0];
  const lastAt = lastRow ? Number(lastRow.created_at) : -1;
  for (const e of journal.entries) {
    if (e.when <= lastAt) continue;
    const text = fixtures.text(`packages/db/drizzle/${e.tag}.sql`);
    if (text === null) throw new Error(`migration ${e.tag} is not bundled`);
    const hash = createHash("sha256").update(text).digest("hex");
    storage.transactionSync(() => {
      for (const stmt of text.split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean)) storage.sql.exec(stmt);
      storage.sql.exec(`INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)`, hash, e.when);
    });
  }
}

/** The driver the durable platform uses in these tests. */
export function testDurableDriver(): DurableDbDriver & { handles: DurableDbHandle<Db>[] } {
  const handles: DurableDbHandle<Db>[] = [];
  return {
    handles,
    open(storage) { const h = openTestDurableDb(storage as EmuStorage); handles.push(h); return h; },
    migrate(storage, fixtures) { migrateFromFixtures(storage, fixtures); },
  };
}

export { dsql };
