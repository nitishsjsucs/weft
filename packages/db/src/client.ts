import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { WEFT_DB_DURABLE_EMU } from "../../contracts/src/ext/cf-db";
import * as schema from "./schema";
import { worldScope } from "./scope";
import { durableHandleOf, openDurableDb } from "./durable";
import { DurableEmulator } from "./emu";

export type Schema = typeof schema;
export type Db = LibSQLDatabase<Schema> & { $client: Client };
/** A drizzle transaction or the db itself; everything a command or simulator writes goes through one of these. */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0] | Db;

export interface OpenDbOptions { dataDir: string; fileName?: string }

/** node:fs without a static import, so the durable import path (CompanyDO) never reaches it. Node only. */
function nodeFs(): { mkdirSync(path: string, opts: { recursive: true }): unknown } {
  const fs = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.("node:fs");
  if (!fs) throw new Error("openDb needs node:fs (Node only); a Durable Object uses openDurableDb");
  return fs as { mkdirSync(path: string, opts: { recursive: true }): unknown };
}

const OPEN_PRAGMAS = "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;";

/**
 * One client per process (SPEC 4): WAL, busy_timeout 5000, foreign keys on. Call closeDb() or the process never exits.
 * With WEFT_DB=durable-emu (docs/cloudflare/design.md 11.2) the same Db runs on openDurableDb over the node:sqlite
 * emulator of a Durable Object's storage, in <dataDir>/<fileName> (or in memory for ":memory:"); the open-time
 * PRAGMAs go through the facade, which drops the two workerd refuses.
 */
export function openDb(opts: OpenDbOptions): Db {
  nodeFs().mkdirSync(opts.dataDir, { recursive: true });
  if (process.env.WEFT_DB === WEFT_DB_DURABLE_EMU) {
    const path = opts.dataDir === ":memory:" ? ":memory:" : join(opts.dataDir, opts.fileName ?? "weft.db");
    const emu = new DurableEmulator({ path });
    const { db } = openDurableDb(emu);
    emulators.set(db, emu);
    pragmas.set(db, db.$client.executeMultiple(OPEN_PRAGMAS));
    return db;
  }
  const url = opts.dataDir === ":memory:" ? ":memory:" : `file:${join(opts.dataDir, opts.fileName ?? "weft.db")}`;
  const client = serializeWrites(createClient({ url }));
  const db = trackTransactions(drizzle(client, { schema }) as Db);
  pragmas.set(db, client.executeMultiple(OPEN_PRAGMAS));
  return db;
}

/**
 * libsql runs a transaction on its own connection, so a statement issued through the top-level db from inside the
 * transaction's callback would wait on the transaction's own lock. currentTransaction(db) names the transaction the
 * current async context runs in, so code that only holds the db (the SQL memory repo) can join it. A durable Db needs
 * none of this: every statement in the transaction's context already belongs to it.
 */
const txContext = new AsyncLocalStorage<{ db: object; tx: DbTx; active: boolean }>();
function trackTransactions(db: Db): Db {
  const original = db.transaction.bind(db) as (cb: (tx: DbTx) => Promise<unknown>, config?: unknown) => Promise<unknown>;
  (db as unknown as { transaction: unknown }).transaction = (cb: (tx: DbTx) => Promise<unknown>, config?: unknown) =>
    original(async (tx) => {
      const token = { db, tx, active: true };
      try { return await txContext.run(token, () => cb(tx)); } finally { token.active = false; }
    }, config);
  return db;
}
/** The libsql transaction of `db` the current async context runs in, or null (always null for a durable Db). */
export function currentTransaction(db: Db): DbTx | null {
  const t = txContext.getStore();
  return t && t.active && t.db === db ? t.tx : null;
}
const emulators = new WeakMap<Db, DurableEmulator>();

/** The emulator behind a Db opened under WEFT_DB=durable-emu, else null (tests and the conformance suite). */
export function emulatorOf(db: Db): DurableEmulator | null { return emulators.get(db) ?? null; }
/**
 * The libsql client pools connections. A statement that fails with SQLITE_BUSY is not reset until it is garbage
 * collected, so its connection goes back to the pool holding a stale read snapshot: later writes on it fail with
 * SQLITE_BUSY_SNAPSHOT and later commits with "SQL statements in progress". Contention only happens when an autocommit
 * write lands while a transaction on another connection holds the write lock, so every autocommit write (anything but
 * SELECT, WITH or PRAGMA) runs under the process write mutex unless its caller already holds it. A blocking
 * busy_timeout would stall the only JS thread, and with it the lock holder, so the rare busy error that remains is
 * retried asynchronously. Statements inside a transaction run on the transaction object, not here; writeLocked() in
 * @weft/executor retries whole transactions.
 */
function serializeWrites(client: Client): Client {
  const execute = client.execute.bind(client) as (...a: unknown[]) => Promise<unknown>;
  const batch = client.batch.bind(client) as (...a: unknown[]) => Promise<unknown>;
  const isRead = (stmt: unknown) => /^\s*(select|with|pragma)\b/i.test(typeof stmt === "string" ? stmt : String((stmt as { sql?: unknown })?.sql ?? ""));
  const retrying = async (fn: () => Promise<unknown>) => {
    let wait = 5;
    for (let attempt = 1; ; attempt++) {
      try { return await fn(); } catch (err) {
        if (!isBusyError(err) || attempt >= 40) throw err;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 200);
      }
    }
  };
  (client as unknown as { execute: unknown }).execute = (...args: unknown[]) =>
    isRead(args[0]) ? retrying(() => execute(...args)) : withWriteLock(() => retrying(() => execute(...args)));
  (client as unknown as { batch: unknown }).batch = (...args: unknown[]) => withWriteLock(() => retrying(() => batch(...args)));
  return client;
}

/** True for SQLITE_BUSY and its extended codes anywhere in the cause chain. */
export function isBusyError(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e && depth < 5; depth++) {
    const { code, extendedCode, message } = e as { code?: unknown; extendedCode?: unknown; message?: unknown };
    if ((typeof code === "string" && code.startsWith("SQLITE_BUSY")) || (typeof extendedCode === "string" && extendedCode.startsWith("SQLITE_BUSY"))) return true;
    if (typeof message === "string" && /database is locked/i.test(message)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

const pragmas = new WeakMap<Db, Promise<void>>();
/** Resolves once the open-time PRAGMAs ran. migrate() awaits it. */
export async function ready(db: Db): Promise<void> { await pragmas.get(db); }

export async function closeDb(db: Db): Promise<void> {
  await pragmas.get(db)?.catch(() => undefined);
  db.$client.close();
  const emu = emulators.get(db);
  if (emu) emu.close();
  else if (durableHandleOf(db)) { /* openDurableDb: the Durable Object owns its storage */ }
}

/**
 * One in-process async write mutex (SPEC 4, 2): every write serializes through it. Re-entrant: a call made while the
 * same async context already holds the lock runs at once instead of deadlocking. Work started inside the lock that
 * outlives it (a background run) holds nothing once the holder finishes. The mutex is per world
 * (docs/cloudflare/design.md 4.2): Durable Objects sharing an isolate never wait on each other's writes, and Node,
 * outside any WorldScope.run, keeps its single process-wide lock.
 */
const held = new AsyncLocalStorage<{ active: boolean; world: string }>();
const tails = new Map<string, Promise<unknown>>();
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const world = worldScope.current();
  const h = held.getStore();
  if (h?.active && h.world === world) return fn();
  const token = { active: true, world };
  const guarded = () => held.run(token, async () => { try { return await fn(); } finally { token.active = false; } });
  const run = (tails.get(world) ?? Promise.resolve()).then(guarded, guarded);
  const settled = run.catch(() => undefined);
  tails.set(world, settled);
  // Forget an idle world's tail so a pool of short-lived worlds does not grow the map.
  void settled.then(() => { if (tails.get(world) === settled) tails.delete(world); });
  return run;
}
