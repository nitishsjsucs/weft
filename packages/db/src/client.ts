import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema";

export type Schema = typeof schema;
export type Db = LibSQLDatabase<Schema> & { $client: Client };
/** A drizzle transaction or the db itself; everything a command or simulator writes goes through one of these. */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0] | Db;

export interface OpenDbOptions { dataDir: string; fileName?: string }

/** One client per process (SPEC 4): WAL, busy_timeout 5000, foreign keys on. Call closeDb() or the process never exits. */
export function openDb(opts: OpenDbOptions): Db {
  mkdirSync(opts.dataDir, { recursive: true });
  const url = opts.dataDir === ":memory:" ? ":memory:" : `file:${join(opts.dataDir, opts.fileName ?? "weft.db")}`;
  const client = serializeWrites(createClient({ url }));
  const db = drizzle(client, { schema }) as Db;
  pragmas.set(db, client.executeMultiple("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;"));
  return db;
}
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
}

/**
 * One in-process async write mutex (SPEC 4, 2): every write serializes through it. Re-entrant: a call made while the
 * same async context already holds the lock runs at once instead of deadlocking. Work started inside the lock that
 * outlives it (a background run) holds nothing once the holder finishes.
 */
const held = new AsyncLocalStorage<{ active: boolean }>();
let tail: Promise<unknown> = Promise.resolve();
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  if (held.getStore()?.active) return fn();
  const token = { active: true };
  const guarded = () => held.run(token, async () => { try { return await fn(); } finally { token.active = false; } });
  const run = tail.then(guarded, guarded);
  tail = run.catch(() => undefined);
  return run;
}
