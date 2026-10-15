import { fileURLToPath } from "node:url";
import { migrate as drizzleMigrate } from "drizzle-orm/libsql/migrator";
import { ready, type Db } from "./client";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Applies drizzle/0000 (generated schema) and drizzle/0001_triggers.sql (custom abort triggers). Idempotent. */
export async function migrate(db: Db): Promise<void> {
  await ready(db);
  await drizzleMigrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
