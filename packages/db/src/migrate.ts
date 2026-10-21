import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { ready, type Db } from "./client";
import { durableHandleOf } from "./durable";
import { migrateDurable } from "./migrate-durable";
import { readMigrationsFromDir, type MigrationEntry } from "./migrations";

/**
 * packages/db/drizzle on Node; empty where modules have no file URL (a bundled Worker passes its migrations in).
 * Resolved on call, never while the module evaluates: this module is on the hosted import graph
 * (docs/cloudflare/design.md 6.4), and workerd has no file URL for it.
 */
export function migrationsDir(): string {
  return typeof import.meta.url === "string" && import.meta.url.startsWith("file:") ? fileURLToPath(new URL("../drizzle", import.meta.url)) : "";
}

/**
 * Applies drizzle/0000 (generated schema), 0001_triggers.sql (custom abort triggers) and the later entries.
 * Idempotent. On libsql it is drizzle-orm/libsql's migrator, statement for statement (one batch with foreign keys
 * off); on a durable Db (openDurableDb, or WEFT_DB=durable-emu) it is migrateDurable: one transactionSync per entry,
 * writing the same __drizzle_migrations rows.
 */
export async function migrate(db: Db, migrations?: readonly MigrationEntry[]): Promise<void> {
  await ready(db);
  const entries = migrations ?? readMigrationsFromDir(migrationsDir());
  const durable = durableHandleOf(db);
  if (durable) {
    migrateDurable(durable.storage, entries);
    durable.facade.refreshTables();
    return;
  }
  // drizzle-orm/libsql/migrator, inlined so this module does not import node:fs statically.
  const session = (db as unknown as { session: { run(q: unknown): Promise<unknown>; migrate(q: unknown[]): Promise<unknown> } }).session;
  const migrationsTable = "__drizzle_migrations";
  await session.run(sql`
		CREATE TABLE IF NOT EXISTS ${sql.identifier(migrationsTable)} (
			id SERIAL PRIMARY KEY,
			hash text NOT NULL,
			created_at numeric
		)
	`);
  const dbMigrations = await db.values<[number, string, string]>(sql`SELECT id, hash, created_at FROM ${sql.identifier(migrationsTable)} ORDER BY created_at DESC LIMIT 1`);
  const last = dbMigrations[0] ?? undefined;
  const batch: unknown[] = [];
  for (const m of entries) {
    if (!last || Number(last[2]) < m.folderMillis) {
      for (const stmt of m.statements) batch.push(db.run(sql.raw(stmt)));
      batch.push(db.run(sql`INSERT INTO ${sql.identifier(migrationsTable)} ("hash", "created_at") VALUES(${m.hash}, ${m.folderMillis})`));
    }
  }
  await session.migrate(batch);
}
