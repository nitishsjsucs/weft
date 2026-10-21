// Migrations on a Durable Object (docs/cloudflare/design.md 9.5): CompanyDO runs this under blockConcurrencyWhile in its
// constructor. Each pending journal entry runs in its own transactionSync and writes its __drizzle_migrations row
// exactly as drizzle-orm/libsql's migrator does (the same table text, hash and created_at), so a world migrated on
// Node and one migrated in a Durable Object hold identical rows. libsql turns foreign keys off around a migration;
// inside a Durable Object transaction that PRAGMA is a no-op, so checks are deferred to each entry's commit.
import type { DurableStorageLike } from "../../contracts/src/ext/cf-db";
import type { MigrationEntry } from "./migrations";
import { splitStatements } from "./sqltext";

export const MIGRATIONS_TABLE = "__drizzle_migrations";
/** drizzle-orm's statement, byte for byte (sqlite-core and libsql migrators), so sqlite_master matches. */
const CREATE_MIGRATIONS = `
		CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
			id SERIAL PRIMARY KEY,
			hash text NOT NULL,
			created_at numeric
		)
	`;

export interface DurableMigrationOutcome { applied: string[]; skipped: number }

/** Applies every journal entry newer than the last recorded one. Idempotent. */
export function migrateDurable(storage: DurableStorageLike, migrations: readonly MigrationEntry[]): DurableMigrationOutcome {
  const sql = storage.sql;
  sql.exec(CREATE_MIGRATIONS);
  const last = sql.exec(`SELECT id, hash, created_at FROM "${MIGRATIONS_TABLE}" ORDER BY created_at DESC LIMIT 1`).toArray()[0];
  const applied: string[] = [];
  let skipped = 0;
  for (const m of migrations) {
    if (last && !(Number(last.created_at) < m.folderMillis)) { skipped++; continue; }
    storage.transactionSync(() => {
      sql.exec("PRAGMA defer_foreign_keys = ON");
      for (const piece of m.statements) {
        // A piece is one statement as drizzle wrote it; a piece holding only comments is skipped (libsql would send
        // it and get nothing back; workerd refuses a script without a statement).
        if (splitStatements(piece).length === 0) continue;
        sql.exec(piece);
      }
      sql.exec(`INSERT INTO "${MIGRATIONS_TABLE}" ("hash", "created_at") VALUES(?, ?)`, m.hash, m.folderMillis);
    });
    applied.push(m.tag);
  }
  return { applied, skipped };
}
