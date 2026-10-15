// Canonical dump and sha256 for `pnpm db:digest` (SPEC 5): two seeds must give the same digest.
import { sql } from "drizzle-orm";
import type { Db } from "@weft/db";
import { canonicalJson, sha256Hex } from "@weft/core";

/** Columns that are random or wall-clock by design: token hashes, key material, vault ciphertext, migration timestamps. */
export const DIGEST_EXCLUDE: Record<string, readonly string[] | "*"> = {
  __drizzle_migrations: "*",
  exec_runs: ["token_hash"],
  api_keys: ["hash", "prefix"],
  vault_secrets: ["ciphertext", "iv", "tag", "fingerprint", "last_used_at"],
};
/** Settings rows whose values are wall clock. */
const SETTINGS_EXCLUDE = new Set(["clock.base_wall"]);

export async function dumpDb(db: Db): Promise<Record<string, unknown[]>> {
  const tables = await db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    const ex = DIGEST_EXCLUDE[name];
    if (ex === "*") continue;
    const cols = (await db.all<{ name: string }>(sql.raw(`PRAGMA table_info("${name}")`))).map((c) => c.name).filter((c) => !ex?.includes(c));
    if (cols.length === 0) continue;
    const list = cols.map((c) => `"${c}"`).join(", ");
    let rows = await db.all<Record<string, unknown>>(sql.raw(`SELECT ${list} FROM "${name}" ORDER BY ${list}`));
    if (name === "settings") rows = rows.filter((r) => !SETTINGS_EXCLUDE.has(String(r.key)));
    out[name] = rows.map((r) => ({ ...r }));
  }
  return out;
}

export async function digestDb(db: Db): Promise<string> {
  return sha256Hex(canonicalJson(await dumpDb(db)));
}
