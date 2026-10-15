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
  const client = createClient({ url });
  const db = drizzle(client, { schema }) as Db;
  pragmas.set(db, client.executeMultiple("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;"));
  return db;
}
const pragmas = new WeakMap<Db, Promise<void>>();
/** Resolves once the open-time PRAGMAs ran. migrate() awaits it. */
export async function ready(db: Db): Promise<void> { await pragmas.get(db); }

export async function closeDb(db: Db): Promise<void> {
  await pragmas.get(db)?.catch(() => undefined);
  db.$client.close();
}

/** One in-process async write mutex (SPEC 4, 2): executor writes serialize through it. Re-entrant calls deadlock, so never nest. */
let tail: Promise<unknown> = Promise.resolve();
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}
