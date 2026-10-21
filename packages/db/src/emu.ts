// The node:sqlite emulator of a SQLite-backed Durable Object's storage (docs/cloudflare/design.md 4.2 and 11.2):
// `DurableStorageLike` over one DatabaseSync connection, with workerd's behavior copied where Weft can reach it, as
// the conformance suite pins it against workerd (packages/db/test/conformance.test.ts on this emulator,
// packages/db/test-workerd on Miniflare). `WEFT_DB=durable-emu` runs the whole Node suite through it.
//
// Copied from workerd (verified locally in Miniflare 5.20261019.1-beta, workerd 1.20261019.1):
// - `sql.exec` runs every statement of a script, binds only the last one, and returns the last one's cursor;
//   BEGIN, COMMIT, ROLLBACK, SAVEPOINT and RELEASE are refused with workerd's message.
// - The authorizer refusals (journal_mode, busy_timeout, user_version, integrity_check and the other PRAGMAs outside
//   workerd's list, ATTACH, temporary objects, sqlite_version() and friends, any `_cf_*` table), the 100-parameter,
//   100,000-byte statement and 100-column limits, and the message format "<message>: SQLITE_X (extended: ...)".
// - Bindings as workerd converts them: numbers bind as REAL, booleans as the text "true" or "false", undefined as
//   NULL, other objects as their string, NaN and Infinity as NULL, a BigInt throws. Integers read back as numbers.
// - Implicit transactions (automatic write coalescing): writes outside an explicit transaction join one SQLite
//   transaction that commits at the end of the turn (after the microtask queue drains). Inside it a PRAGMA
//   foreign_keys change is a no-op and defer_foreign_keys stays on, and a commit that leaves a deferred foreign key
//   violated resets the object.
// - transaction(closure) starts its closure on the next turn, once the caller's pending microtasks have run (so a
//   caller's statements right after the call are not part of it), and holds the input gate until it settles.
//   Every statement while it is open belongs to it, after any number of awaits; nested calls are savepoints that roll
//   back alone. A second event (`deliver`) waits for the gate, and so does a timer scheduled from outside the
//   transaction (`sleep`): a body that waits on one deadlocks, and after `gateTimeoutMs` (30 s, as workerd) the object
//   resets: the transaction rolls back and rejects with workerd's message, and this handle refuses every later call
//   (`revive()` gives a handle on the committed state, as the next event gets a fresh object).
//
// Approximations (documented, pinned only where they agree with workerd):
// - rowsWritten follows workerd's counting as measured: an inserted row counts 1 plus one per index on the table, an
//   updated row 1 plus one per index over a changed column, a deleted row 1, a row a trigger inserts 1 plus its
//   table's indexes, DDL 1, DROP 0.
// - rowsRead is a lower bound: rows returned, or rows an UPDATE touched.
// - Node has no input gate around concurrent async chains (two app.request calls, a background run), so a statement
//   from an async context outside the open transaction runs inside its savepoint here, where workerd would have
//   delivered it as a later event. Such writes are recorded and replayed if the transaction rolls back, so they
//   behave as if they ran outside it. workerd attributes a continuation to the context that resolved its promise and
//   this emulator to the context it was registered in (AsyncLocalStorage); the two differ only for shapes the facade
//   never builds, which the conformance suite does not pin.
import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { DO_SQL_LIMITS, RESERVED_TABLE_PREFIX, type DurableStorageLike, type SqlCursorLike, type SqlRow, type SqlStorageLike, type SqlStorageValue } from "../../contracts/src/ext/cf-db";
import { leadingWords, parameterCount, splitStatements, statementKind, targetTable, tokenize, type SqlToken } from "./sqltext";
import { codesOf, workerdSuffix } from "./sqlite-errors";

/** PRAGMAs workerd allows (developers.cloudflare.com/d1/sql-api/sql-statements/ and verified locally); any other is SQLITE_AUTH. */
export const ALLOWED_PRAGMAS: ReadonlySet<string> = new Set([
  "foreign_keys", "defer_foreign_keys", "table_info", "table_xinfo", "table_list", "index_list", "index_info", "index_xinfo",
  "foreign_key_list", "foreign_key_check", "quick_check", "optimize", "legacy_alter_table", "recursive_triggers",
  "case_sensitive_like", "reverse_unordered_selects", "data_version", "ignore_check_constraints",
]);
/** node:sqlite through process.getBuiltinModule: workerd has no node:sqlite, and a Worker bundle that reaches this module
 * (it is exported beside the facade) must not import it statically. */
type NodeSqlite = typeof import("node:sqlite");
let sqliteModule: NodeSqlite | null = null;
function nodeSqlite(): NodeSqlite {
  if (sqliteModule) return sqliteModule;
  const m = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.("node:sqlite") as NodeSqlite | undefined;
  if (!m) throw new Error("the durable emulator needs node:sqlite (Node 22.5 or later)");
  sqliteModule = m;
  return m;
}
/** Authorizer action codes (sqlite.org/c3ref/c_alter_table.html). */
const A = {
  OK: 0, DENY: 1, CREATE_TEMP_INDEX: 3, CREATE_TEMP_TABLE: 4, CREATE_TEMP_TRIGGER: 5, CREATE_TEMP_VIEW: 6, DROP_TEMP_INDEX: 12,
  DROP_TEMP_TABLE: 13, DROP_TEMP_TRIGGER: 14, DROP_TEMP_VIEW: 15, PRAGMA: 19, READ: 20, TRANSACTION: 22, ATTACH: 24, DETACH: 25,
  FUNCTION: 31, SAVEPOINT: 32,
} as const;
const DENIED_FUNCTIONS: ReadonlySet<string> = new Set(["load_extension", "sqlite_version", "sqlite_source_id", "sqlite_compileoption_get", "sqlite_compileoption_used"]);

export const WORKERD_MESSAGES = {
  transactionStatement: "To execute a transaction, please use the state.storage.transaction() or state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements. The JavaScript API is safer because it will automatically roll back on exceptions, and because it interacts correctly with Durable Objects' automatic atomic write coalescing.",
  gateTimeout: "A call to blockConcurrencyWhile() in a Durable Object waited for too long. The call was canceled and the Durable Object was reset.",
  constraintReset: "Durable Object was reset and rolled back to its last known good state because the application left the database in a state where constraints were violated",
  multiBindings: "When executing multiple SQL statements in a single call, only the last statement can have parameters.",
  wrongBindings: "Wrong number of parameter bindings for SQL query.",
  noStatement: "SQL code did not contain a statement.",
  deleteAllInTx: "Cannot call deleteAll() within a transaction",
  oneNone: "Expected exactly one result from SQL query, but got no results.",
  oneMany: "Expected exactly one result from SQL query, but got multiple results.",
  bigint: "Cannot convert a BigInt value to a number",
  /** This emulator's own refusal after a reset (workerd discards the object; its old handle is unusable). */
  reset: "Durable Object storage is unusable: the object was reset",
  /** This emulator's own refusal after close(). */
  closed: "The durable emulator is closed",
} as const;

export interface DurableEmulatorOptions {
  /** A database file, or ":memory:" (the default). */
  path?: string;
  /** How long an async transaction may hold the input gate before the object resets (default 30 s, as workerd). */
  gateTimeoutMs?: number;
}

/** An Error shaped as workerd throws it, plus the codes the facade maps onto `code` and `extendedCode`. */
export class EmulatedSqlError extends Error {
  constructor(message: string, readonly sqliteCode?: string, readonly sqliteExtendedCode?: string) { super(message); this.name = "Error"; }
}

interface ForeignWrite { sql: string; args: unknown[]; ctxLevel: number }
/** One committed user write, as record() returns it: replaying these in order reproduces the session's writes. */
export interface RecordedWrite { sql: string; args: unknown[] }
interface Frame {
  kind: "async" | "sync";
  level: number;
  name: string;
  open: boolean;
  parent: Frame | null;
  foreign: ForeignWrite[];
  /** User writes issued in this frame, for record(); they move down on commit and are dropped on rollback. */
  recorded: RecordedWrite[];
  /** Nested async transactions of this frame waiting for a sibling's savepoint to close. */
  waiters: Array<() => void>;
  rollbackRequested: boolean;
}

/** The next turn: after every queued microtask has run (workerd's evalLater, approximately). */
const nextTurn = () => new Promise<void>((r) => setImmediate(r));

interface IndexInfo { name: string; columns: string[]; expression: boolean }


class EmulatedCursor<T extends SqlRow = SqlRow> implements SqlCursorLike<T> {
  private pos = 0;
  constructor(private readonly arrays: SqlStorageValue[][], readonly columnNames: string[], readonly rowsRead: number, readonly rowsWritten: number) {}
  private object(arr: SqlStorageValue[]): T {
    const row: SqlRow = {};
    this.columnNames.forEach((c, i) => { row[c] = arr[i] ?? null; });
    return row as T;
  }
  next(): IteratorResult<T, undefined> {
    if (this.pos >= this.arrays.length) return { done: true, value: undefined };
    return { done: false, value: this.object(this.arrays[this.pos++]!) };
  }
  toArray(): T[] {
    const out = this.arrays.slice(this.pos).map((a) => this.object(a));
    this.pos = this.arrays.length;
    return out;
  }
  one(): T {
    const rest = this.arrays.length - this.pos;
    if (rest === 0) throw new Error(WORKERD_MESSAGES.oneNone);
    if (rest > 1) throw new Error(WORKERD_MESSAGES.oneMany);
    return this.object(this.arrays[this.pos++]!);
  }
  *raw<U extends SqlStorageValue[]>(): IterableIterator<U> {
    while (this.pos < this.arrays.length) yield this.arrays[this.pos++]!.slice() as U;
  }
  [Symbol.iterator](): Iterator<T> { return { next: () => this.next() as IteratorResult<T> }; }
}

/** workerd's binding conversion (verified locally): see the file header. */
export function workerdBinding(v: unknown): string | number | null | Uint8Array {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return String(v);
  if (typeof v === "bigint") throw new TypeError(WORKERD_MESSAGES.bigint);
  if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer);
  return String(v);
}

function readValue(v: unknown): SqlStorageValue {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Uint8Array) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  return v as SqlStorageValue;
}

/** Columns an UPDATE (or an upsert's DO UPDATE) assigns, from its SET list, lower case. */
export function setColumns(sql: string): Set<string> {
  const tokens = tokenize(sql).filter((t) => t.kind !== "space" && t.kind !== "comment");
  const out = new Set<string>();
  const name = (t: SqlToken) => (t.kind === "ident" ? t.text.slice(1, -1) : t.text).toLowerCase();
  let i = tokens.findIndex((t) => t.kind === "word" && t.text.toUpperCase() === "SET");
  if (i < 0) return out;
  let depth = 0;
  let atStart = true;
  for (i = i + 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "punct" && t.text === "(") {
      if (atStart && depth === 0) {
        // (a, b) = (...): a column list.
        for (i = i + 1; i < tokens.length && !(tokens[i]!.kind === "punct" && tokens[i]!.text === ")"); i++) {
          if (tokens[i]!.kind === "word" || tokens[i]!.kind === "ident") out.add(name(tokens[i]!));
        }
        atStart = false;
      } else depth++;
      continue;
    }
    if (t.kind === "punct" && t.text === ")") { depth--; continue; }
    if (depth === 0 && t.kind === "word" && /^(WHERE|FROM|RETURNING)$/i.test(t.text)) break;
    if (depth === 0 && t.kind === "punct" && t.text === ",") { atStart = true; continue; }
    if (atStart && (t.kind === "word" || t.kind === "ident")) { out.add(name(t)); atStart = false; }
  }
  return out;
}

export class DurableEmulator implements DurableStorageLike {
  readonly sql: SqlStorageLike;
  private readonly db: DatabaseSync;
  private readonly als = new AsyncLocalStorage<Frame>();
  private readonly stack: Frame[] = [];
  private readonly gateWaiters: Array<{ go: () => void; fail: (e: Error) => void }> = [];
  private gateBusy = false;
  private readonly gateTimeoutMs: number;
  /** WEFT_EMU_DEBUG=<ms>: log, with stacks, a transaction holding the gate or a caller waiting on it for longer, and
   * PRAGMA foreign_keys no-ops inside a transaction. A diagnostic for Node runs on the emulator; off by default. */
  private readonly debugMs = Number(process.env.WEFT_EMU_DEBUG) || 0;
  private internal = 0;
  private deadReason: string | null = null;
  private implicitOpen = false;
  private recording: RecordedWrite[] | null = null;
  private implicitRecorded: RecordedWrite[] = [];
  private seq = 0;
  private schemaCache = new Map<string, { indexes: IndexInfo[]; triggerTargets: string[] }>();
  /** Concurrent writes the emulator could not replay after a rollback (a divergence worth a test failure). */
  replayFailures = 0;
  /** True once this handle saw a reset; `revive()` gives a handle on the committed state. */
  get reset(): boolean { return this.deadReason !== null; }

  constructor(opts: DurableEmulatorOptions = {}, shared?: DatabaseSync) {
    this.gateTimeoutMs = opts.gateTimeoutMs ?? DO_SQL_LIMITS.inputGateTimeoutMs;
    this.db = shared ?? new (nodeSqlite().DatabaseSync)(opts.path ?? ":memory:", { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: true });
    this.db.setAuthorizer((action, a1, a2) => this.authorize(action, a1, a2));
    const self = this;
    this.sql = {
      exec<T extends SqlRow = SqlRow>(query: string, ...bindings: unknown[]): SqlCursorLike<T> { return self.exec<T>(query, bindings, false); },
      get databaseSize() { return self.databaseSize(); },
    };
  }

  /** A fresh handle on the same database after a reset: the next event of a new object instance. */
  revive(): DurableEmulator {
    return new DurableEmulator({ gateTimeoutMs: this.gateTimeoutMs }, this.db);
  }

  private closed = false;
  /** Commits the pending implicit transaction and closes the database. Later calls fail at once, and an event or
   * timer waiting on the gate is canceled, so nothing that outlives the close waits forever. */
  close(): void {
    if (this.closed) return;
    if (this.db.isOpen && !this.reset && this.stack.length === 0) this.commitImplicit();
    this.closed = true;
    for (const f of this.stack) f.open = false;
    this.stack.length = 0;
    this.gateBusy = false;
    for (const w of this.gateWaiters.splice(0)) w.fail(new Error(WORKERD_MESSAGES.closed));
    if (this.db.isOpen) this.db.close();
  }

  // ---- authorizer ---------------------------------------------------------------------------------------------

  private authorize(action: number, a1: string | null, a2: string | null): number {
    if (this.internal > 0) return A.OK;
    switch (action) {
      case A.PRAGMA:
        return a1 && ALLOWED_PRAGMAS.has(a1.toLowerCase()) ? A.OK : A.DENY;
      case A.ATTACH: case A.DETACH:
      case A.CREATE_TEMP_INDEX: case A.CREATE_TEMP_TABLE: case A.CREATE_TEMP_TRIGGER: case A.CREATE_TEMP_VIEW:
      case A.DROP_TEMP_INDEX: case A.DROP_TEMP_TABLE: case A.DROP_TEMP_TRIGGER: case A.DROP_TEMP_VIEW:
      case A.TRANSACTION: case A.SAVEPOINT:
        return A.DENY;
      case A.FUNCTION:
        return a2 && DENIED_FUNCTIONS.has(a2.toLowerCase()) ? A.DENY : A.OK;
      default:
        // Reads and writes of workerd's own tables (its _cf_KV), and DDL on them.
        if ((a1 && a1.startsWith(RESERVED_TABLE_PREFIX)) || (a2 && a2.startsWith(RESERVED_TABLE_PREFIX) && action !== A.READ)) return A.DENY;
        return A.OK;
    }
  }

  private run<T>(fn: () => T): T {
    this.internal++;
    try { return fn(); } finally { this.internal--; }
  }
  private exp(sql: string): void { this.run(() => this.db.exec(sql)); }

  private databaseSize(): number {
    this.alive();
    return this.run(() => {
      const pages = Number((this.db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
      const size = Number((this.db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
      return pages * size;
    });
  }

  private alive(): void {
    if (this.closed) throw new Error(WORKERD_MESSAGES.closed);
    if (this.deadReason !== null) throw new Error(WORKERD_MESSAGES.reset);
  }

  // ---- implicit transactions ----------------------------------------------------------------------------------

  private implicitOpener = "";
  private ensureImplicit(): void {
    if (this.implicitOpen || this.stack.length > 0) return;
    if (this.debugMs) this.implicitOpener = new Error("implicit transaction opened").stack ?? "";
    this.exp("BEGIN");
    this.implicitOpen = true;
    setImmediate(() => { if (this.implicitOpen && this.db.isOpen && this.stack.length === 0) this.commitImplicit(); });
  }

  /** Commits the implicit transaction; a deferred foreign key it leaves violated resets the object, as workerd does. */
  private commitImplicit(): void {
    if (!this.implicitOpen) return;
    this.implicitOpen = false;
    const recorded = this.implicitRecorded;
    this.implicitRecorded = [];
    try { this.exp("COMMIT"); this.recording?.push(...recorded); } catch (e) {
      try { this.exp("ROLLBACK"); } catch { /* already rolled back */ }
      this.resetObject(`${WORKERD_MESSAGES.constraintReset}: ${(e as Error).message}${workerdSuffix((e as { errcode?: number }).errcode ?? 787)}`);
    }
  }

  // ---- statements ---------------------------------------------------------------------------------------------

  private error(e: unknown): Error {
    const err = e as { message?: string; errcode?: number };
    if (typeof err?.errcode === "number") {
      const c = codesOf(err.errcode);
      return new EmulatedSqlError(`${err.message}${workerdSuffix(err.errcode)}`, c.code, c.extendedCode);
    }
    return e instanceof Error ? e : new Error(String(e));
  }

  /** Indexes of a table and the tables its triggers write, for the rowsWritten estimate. */
  private schemaOf(table: string): { indexes: IndexInfo[]; triggerTargets: string[] } {
    const key = table.toLowerCase();
    const hit = this.schemaCache.get(key);
    if (hit) return hit;
    const out = this.run(() => {
      const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
      const list = this.db.prepare(`PRAGMA index_list(${q(table)})`).all() as { name: string }[];
      const indexes = list.map((ix) => {
        const cols = this.db.prepare(`PRAGMA index_xinfo(${q(ix.name)})`).all() as { cid: number; name: string | null; key: number }[];
        const keyCols = cols.filter((c) => c.key === 1);
        return { name: ix.name, columns: keyCols.filter((c) => c.name).map((c) => c.name!.toLowerCase()), expression: keyCols.some((c) => c.cid === -2) };
      });
      const triggers = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE").all(table) as { sql: string }[];
      const targets = new Set<string>();
      for (const t of triggers) {
        const body = t.sql.slice(t.sql.search(/\bBEGIN\b/i) + 5);
        for (const m of body.matchAll(/\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+[`"[]?([A-Za-z0-9_]+)/gi)) targets.add(m[1]!);
      }
      return { indexes, triggerTargets: [...targets] };
    });
    this.schemaCache.set(key, out);
    return out;
  }

  private counters(): { changes: number; total: number; rowid: number } {
    return this.run(() => {
      const r = this.db.prepare("SELECT changes() AS c, total_changes() AS t, last_insert_rowid() AS r").get() as { c: number; t: number; r: number };
      return { changes: Number(r.c), total: Number(r.t), rowid: Number(r.r) };
    });
  }

  /** The innermost open async frame of the current async context (walking up from a closed nested frame). */
  private contextFrame(): Frame | null {
    let f = this.als.getStore() ?? null;
    while (f && !f.open) f = f.parent;
    return f;
  }
  private innermostAsync(): Frame | null {
    for (let i = this.stack.length - 1; i >= 0; i--) if (this.stack[i]!.kind === "async") return this.stack[i]!;
    return null;
  }

  private exec<T extends SqlRow>(query: string, bindings: unknown[], replay: boolean): SqlCursorLike<T> {
    this.alive();
    if (typeof query !== "string") throw new TypeError("SQL query must be a string");
    if (Buffer.byteLength(query, "utf8") > 100_000) throw new EmulatedSqlError(`statement too long${workerdSuffix(18)}`, "SQLITE_TOOBIG", "SQLITE_TOOBIG");
    const statements = splitStatements(query);
    if (statements.length === 0) throw new Error(WORKERD_MESSAGES.noStatement);
    const args = bindings.map(workerdBinding);
    let cursor: SqlCursorLike<T> | null = null;
    for (const [i, stmtSql] of statements.entries()) {
      const last = i === statements.length - 1;
      const want = parameterCount(stmtSql);
      if (!last && want > 0) throw new Error(WORKERD_MESSAGES.multiBindings);
      if (want > DO_SQL_LIMITS.maxBoundParameters) throw new EmulatedSqlError(`too many SQL variables${workerdSuffix(1)}`, "SQLITE_ERROR", "SQLITE_ERROR");
      const mine = last ? args : [];
      if (mine.length !== want) throw new Error(WORKERD_MESSAGES.wrongBindings);
      cursor = this.execOne<T>(stmtSql, mine, last ? bindings : [], replay);
    }
    return cursor!;
  }

  private execOne<T extends SqlRow>(stmtSql: string, args: (string | number | null | Uint8Array)[], original: unknown[], replay: boolean): SqlCursorLike<T> {
    const kind = statementKind(stmtSql);
    if (kind === "transaction") throw new Error(WORKERD_MESSAGES.transactionStatement);
    if (this.debugMs && kind === "pragma" && /PRAGMA\s+foreign_keys\s*=/i.test(stmtSql) && (this.implicitOpen || this.stack.length)) {
      console.error(`[emu] ${stmtSql} is a no-op inside a transaction (open frames: ${this.stack.length}); the implicit transaction was opened at`, this.implicitOpener);
    }
    let stmt: StatementSync;
    try { stmt = this.db.prepare(stmtSql); } catch (e) { throw this.error(e); }
    const columns = stmt.columns();
    if (columns.length > DO_SQL_LIMITS.maxColumns) throw new EmulatedSqlError(`too many columns in result set${workerdSuffix(1)}`, "SQLITE_ERROR", "SQLITE_ERROR");
    const writes = kind === "write" || kind === "ddl";
    if (writes) this.ensureImplicit();
    const before = writes || kind === "other" ? this.counters() : null;
    const ddl = kind === "ddl";
    const words = ddl ? leadingWords(stmtSql, 3) : [];
    const checkColumns = ddl && (words[1] === "TABLE" || (words[0] === "ALTER" && words[1] === "TABLE"));
    const sp = `_emu_ddl_${this.seq++}`;
    if (checkColumns) this.exp(`SAVEPOINT ${sp}`);
    let arrays: SqlStorageValue[][] = [];
    try {
      if (columns.length > 0) {
        stmt.setReadBigInts(true);
        stmt.setReturnArrays(true);
        arrays = (stmt.all(...args) as unknown as unknown[][]).map((r) => r.map(readValue));
      } else {
        stmt.run(...args);
      }
      if (checkColumns) {
        const name = targetTable(stmtSql);
        const n = name ? this.run(() => this.db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all().length) : 0;
        if (n > DO_SQL_LIMITS.maxColumns) throw new EmulatedSqlError(`too many columns on ${name}${workerdSuffix(1)}`, "SQLITE_ERROR", "SQLITE_ERROR");
        this.exp(`RELEASE ${sp}`);
      }
    } catch (e) {
      if (checkColumns) this.exp(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e instanceof EmulatedSqlError ? e : this.error(e);
    }
    if (ddl) this.schemaCache.clear();
    let rowsWritten = 0;
    let rowsRead = arrays.length;
    if (before) {
      const after = this.counters();
      const delta = after.total - before.total;
      const direct = delta === 0 ? 0 : Math.min(after.changes, delta);
      const triggered = Math.max(0, delta - direct);
      const target = kind === "write" ? targetTable(stmtSql) : null;
      const info = target ? this.schemaOf(target) : null;
      if (kind === "write") {
        const first = leadingWords(stmtSql, 1)[0];
        const verb = first === "WITH" ? (/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.exec(stmtSql)?.[1] ?? "").toUpperCase() : first;
        const idx = info?.indexes ?? [];
        const upsertUpdate = (verb === "INSERT" || verb === "REPLACE") && /\bDO\s+UPDATE\b/i.test(stmtSql) && after.rowid === before.rowid && direct > 0;
        if (verb === "UPDATE" || upsertUpdate) {
          const set = setColumns(stmtSql);
          rowsWritten = direct * (1 + idx.filter((ix) => ix.expression || ix.columns.some((c) => set.has(c))).length);
          rowsRead += direct;
        } else if (verb === "DELETE") {
          rowsWritten = direct;
        } else {
          rowsWritten = direct * (1 + idx.length);
        }
      } else if (ddl) {
        rowsWritten = words[0] === "DROP" ? 0 : 1;
      }
      if (triggered > 0) {
        const targets = info?.triggerTargets ?? [];
        rowsWritten += triggered * (targets.length === 1 ? 1 + this.schemaOf(targets[0]!).indexes.length : 1);
      }
    }
    if (!replay && writes) this.trackConcurrent(stmtSql, original);
    if (this.recording && writes) (this.stack.length ? this.stack[this.stack.length - 1]!.recorded : this.implicitRecorded).push({ sql: stmtSql, args: original });
    return new EmulatedCursor<T>(arrays, columns.map((c) => c.name), rowsRead, rowsWritten);
  }

  /** A write from an async context outside the open transaction (see the header): replayed if it rolls back. */
  private trackConcurrent(sql: string, args: unknown[]): void {
    const inner = this.innermostAsync();
    if (!inner) return;
    const ctxLevel = this.contextFrame()?.level ?? 0;
    if (ctxLevel >= inner.level) return;
    this.stack[this.stack.length - 1]!.foreign.push({ sql, args, ctxLevel });
  }

  // ---- transactions -------------------------------------------------------------------------------------------

  private openFrame(kind: Frame["kind"], parent: Frame | null): Frame {
    const level = this.stack.length + 1;
    const frame: Frame = { kind, level, name: `_emu_sp_${level}_${this.seq++}`, open: true, parent, foreign: [], recorded: [], waiters: [], rollbackRequested: false };
    this.exp(`SAVEPOINT ${frame.name}`);
    this.stack.push(frame);
    return frame;
  }

  /** Closes the innermost frame. Returns the reset reason when the commit leaves a deferred foreign key violated. */
  private closeFrame(frame: Frame, commit: boolean): string | null {
    if (this.stack[this.stack.length - 1] !== frame) throw new Error("emulator: transaction frames closed out of order");
    const below = this.stack.length >= 2 ? this.stack[this.stack.length - 2]! : null;
    let failure: string | null = null;
    if (commit) {
      try { this.exp(`RELEASE ${frame.name}`); } catch (e) {
        // Only the outermost RELEASE checks deferred foreign keys; workerd resets the object instead.
        failure = `${WORKERD_MESSAGES.constraintReset}: ${(e as Error).message}${workerdSuffix((e as { errcode?: number }).errcode ?? 787)}`;
        this.exp(`ROLLBACK TO ${frame.name}; RELEASE ${frame.name}`);
      }
    } else {
      this.exp(`ROLLBACK TO ${frame.name}; RELEASE ${frame.name}`);
    }
    frame.open = false;
    this.stack.pop();
    this.schemaCache.clear();
    if (commit && !failure && this.recording) (below ? below.recorded : this.implicitOpen ? this.implicitRecorded : this.recording).push(...frame.recorded);
    const carried: ForeignWrite[] = commit && !failure ? frame.foreign : [];
    if (!(commit && !failure) && frame.kind === "async") {
      for (const w of frame.foreign) {
        try { this.exec(w.sql, w.args, true); } catch { this.replayFailures++; }
      }
      carried.push(...frame.foreign);
    }
    if (below) for (const w of carried) if (w.ctxLevel < below.level) below.foreign.push(w);
    // A sibling nested transaction waiting for this savepoint to close.
    const parent = frame.parent;
    if (parent && parent.waiters.length) parent.waiters.shift()!();
    return failure;
  }

  private resetObject(reason: string): void {
    if (this.deadReason !== null) return;
    this.deadReason = reason;
    try { if (this.db.isOpen && this.db.isTransaction) this.exp("ROLLBACK"); } catch { /* nothing open */ }
    this.implicitOpen = false;
    this.implicitRecorded = [];
    for (const f of this.stack) f.open = false;
    // Writes from outside the transaction were never part of it: they stay, as they do in workerd.
    const concurrent = this.stack.flatMap((f) => f.foreign);
    this.stack.length = 0;
    this.gateBusy = false;
    if (concurrent.length) {
      this.deadReason = null;
      for (const w of concurrent) { try { this.exec(w.sql, w.args, true); } catch { this.replayFailures++; } }
      this.commitImplicit();
      this.deadReason = reason;
    }
    // Events and timers waiting on the gate are canceled with the reset.
    for (const w of this.gateWaiters.splice(0)) w.fail(new Error(reason));
  }

  /** The input gate: one root transaction at a time, handed to waiters in arrival order. */
  private gateHolder = "";
  private async acquireGate(): Promise<void> {
    const here = this.debugMs ? new Error("gate requested").stack ?? "" : "";
    if (!this.gateBusy) { this.gateBusy = true; this.gateHolder = here; return; }
    const holder = this.gateHolder;
    const warn = this.debugMs ? setTimeout(() => console.error(`[emu] waiting more than ${this.debugMs} ms for the gate`, here, "\nheld by", holder), this.debugMs) : null;
    try {
      await new Promise<void>((go, fail) => this.gateWaiters.push({ go, fail }));
    } finally { if (warn) clearTimeout(warn); }
    this.gateHolder = here;
    this.alive();
  }
  private releaseGate(): void {
    const next = this.gateWaiters.shift();
    if (next) next.go(); else this.gateBusy = false;
  }

  async transaction<T>(closure: (txn: unknown) => Promise<T>): Promise<T> {
    this.alive();
    const ctx = this.contextFrame();
    if (!ctx) await this.acquireGate();
    // workerd runs the closure on a later turn, after the caller's queued microtasks.
    await nextTurn();
    if (this.reset) throw new Error(this.deadReason!);
    let frame: Frame;
    if (ctx) {
      // Nested: wait while a sibling's nested savepoint is innermost.
      while (this.stack[this.stack.length - 1] !== ctx) {
        if (!ctx.open) throw new Error("emulator: a nested transaction outlived the transaction that started it");
        const warn = this.debugMs ? setTimeout(() => console.error(`[emu] a nested transaction waited more than ${this.debugMs} ms for a sibling's savepoint`, new Error("nested").stack), this.debugMs) : null;
        await new Promise<void>((r) => ctx.waiters.push(r));
        if (warn) clearTimeout(warn);
        this.alive();
      }
      frame = this.openFrame("async", ctx);
    } else {
      // Writes coalesced before the transaction commit on their own: they never become part of it.
      this.commitImplicit();
      if (this.reset) { this.releaseGate(); throw new Error(this.deadReason!); }
      frame = this.openFrame("async", null);
    }
    const txn = { rollback: () => { frame.rollbackRequested = true; } };
    const isRoot = frame.parent === null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const opened = isRoot && this.debugMs ? new Error("transaction opened").stack ?? "" : "";
    const debug = opened ? setTimeout(() => console.error(`[emu] a transaction has held the gate for ${this.debugMs} ms (${this.gateWaiters.length} waiting); opened at`, opened), this.debugMs) : null;
    const body = this.als.run(frame, () => Promise.resolve().then(() => closure(txn)));
    const settled = body.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
    const out = isRoot
      ? await Promise.race([settled, new Promise<{ timeout: true }>((r) => { timer = setTimeout(() => r({ timeout: true }), this.gateTimeoutMs); })])
      : await settled;
    if (timer) clearTimeout(timer);
    if (debug) clearTimeout(debug);
    if (this.closed) throw new Error(WORKERD_MESSAGES.closed);
    if ("timeout" in out) {
      this.resetObject(WORKERD_MESSAGES.gateTimeout);
      throw new Error(WORKERD_MESSAGES.gateTimeout);
    }
    if (this.reset) throw new Error(this.deadReason!);
    const commit = out.ok && !frame.rollbackRequested;
    let failure: string | null = null;
    try {
      // A body that returned while one of its own nested transactions is still open: close inner frames first.
      while (this.stack.length && this.stack[this.stack.length - 1] !== frame) this.closeFrame(this.stack[this.stack.length - 1]!, false);
      failure = this.closeFrame(frame, commit);
    } finally {
      if (isRoot && !this.closed) this.releaseGate();
    }
    if (failure) { this.resetObject(failure); throw new Error(failure); }
    if (!out.ok) throw out.e;
    return out.v as T;
  }

  transactionSync<T>(closure: () => T): T {
    this.alive();
    this.ensureImplicit();
    const frame = this.openFrame("sync", this.contextFrame());
    let value: T;
    try {
      value = closure();
    } catch (e) {
      if (frame.open) this.closeFrame(frame, false);
      throw e;
    }
    const failure = this.closeFrame(frame, true);
    if (failure) { this.resetObject(failure); throw new Error(failure); }
    return value;
  }

  async deleteAll(): Promise<void> {
    this.alive();
    if (this.stack.length > 0) throw new Error(WORKERD_MESSAGES.deleteAllInTx);
    this.commitImplicit();
    this.alive();
    this.run(() => {
      const objects = this.db.prepare(`SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND substr(name, 1, 4) <> '${RESERVED_TABLE_PREFIX}'`).all() as { type: string; name: string }[];
      this.db.exec("PRAGMA foreign_keys = OFF");
      try {
        for (const t of ["trigger", "view", "table"]) {
          for (const o of objects.filter((x) => x.type === t)) this.db.exec(`DROP ${t.toUpperCase()} IF EXISTS "${o.name.replace(/"/g, '""')}"`);
        }
        if (this.db.prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_sequence'").get()) this.db.exec("DELETE FROM sqlite_sequence");
      } finally { this.db.exec("PRAGMA foreign_keys = ON"); }
      this.db.exec("VACUUM");
    });
    this.schemaCache.clear();
  }

  // ---- events and timers, gated like workerd's input gate -----------------------------------------------------

  /** Runs `fn` as a new incoming event: it waits until no transaction holds the gate. */
  async deliver<T>(fn: () => Promise<T> | T): Promise<T> {
    this.alive();
    await this.acquireGate();
    this.releaseGate();
    return this.als.exit(() => Promise.resolve().then(fn));
  }

  /** A timer as workerd delivers it: scheduled outside the transaction holding the gate, it fires once the gate opens. */
  async sleep(ms: number): Promise<void> {
    const inside = this.contextFrame() !== null;
    await new Promise((r) => setTimeout(r, ms));
    if (!inside && this.gateBusy) { await this.acquireGate(); this.releaseGate(); }
  }

  /**
   * Records every committed user write (statement text and bindings, in commit order) from now until stop(). A
   * session recorded on the emulator can be replayed on workerd to measure what the same writes cost there.
   */
  record(): { stop(): RecordedWrite[] } {
    this.recording = [];
    return { stop: () => { const out = this.recording ?? []; this.recording = null; return out; } };
  }

  /** True while an async transaction holds (or has reserved) the gate. */
  get gateHeld(): boolean { return this.gateBusy; }
}

/** Opens an emulator (`WEFT_DB=durable-emu` uses a file under the data dir). */
export function openDurableEmulator(opts: DurableEmulatorOptions = {}): DurableEmulator {
  return new DurableEmulator(opts);
}
