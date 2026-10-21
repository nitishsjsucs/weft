// Canonical dump and sha256 for `pnpm db:digest` (SPEC 5): two seeds must give the same digest.
import { sql } from "drizzle-orm";
import type { Db } from "@weft/db";
import { canonicalJson, sha256Hex } from "@weft/core";
import { DIRTY_TABLE, HOSTED_TABLES, RESERVED_TABLE_PREFIX } from "../../contracts/src/ext/cf-db";

/** Columns that are random or wall-clock by design: token hashes, key material, vault ciphertext, migration timestamps. */
export const DIGEST_EXCLUDE: Record<string, readonly string[] | "*"> = {
  __drizzle_migrations: "*",
  exec_runs: ["token_hash"],
  api_keys: ["hash", "prefix"],
  vault_secrets: ["ciphertext", "iv", "tag", "fingerprint", "last_used_at"],
  // Weft on Cloudflare (docs/cloudflare/design.md 4.1 and 4.6): hosted runtime state, never world content. kv_state
  // holds the world id and generation and the lease's key plaintexts; run handles are bearer tokens; the dirty-key
  // table only tracks what the delta reset must undo.
  kv_state: "*",
  run_handles: ["token", "nonce"],
  [DIRTY_TABLE]: "*",
  // The SQL memory repo (WEFT_MEMORY=sqlite, always on hosted): git memory was never part of the world digest, so the
  // digest is the same whichever repository holds memory. The snapshot manifest digests these tables on its own and
  // records the memory HEAD separately (cf1-db snapshot.ts, scripts/cf/snapshot.ts).
  mem_objects: "*",
  mem_refs: "*",
  mem_log: "*",
};
/** Settings rows whose values are wall clock. */
const SETTINGS_EXCLUDE = new Set(["clock.base_wall"]);
/** The hosted tables (migration 0008_hosted.sql) count only once they hold a row: empty, as on Node by default, they
 * leave the dump exactly as it was before they existed, so the base digest and every pinned eval digest stay put. */
const SKIP_WHEN_EMPTY = new Set<string>(HOSTED_TABLES);

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
/** BLOB cells (git objects, upload chunks) as `{ $blob: hex }`; canonicalJson takes no binary values. */
function cell(v: unknown): unknown {
  if (v instanceof ArrayBuffer) return { $blob: hex(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) return { $blob: hex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  return v;
}

export async function dumpDb(db: Db): Promise<Record<string, unknown[]>> {
  // Tables named _cf_* belong to workerd (its _cf_KV is listed in sqlite_master and refuses every read); Node has none.
  const tables = await db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, ${RESERVED_TABLE_PREFIX.length}) <> ${RESERVED_TABLE_PREFIX} ORDER BY name`);
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    const ex = DIGEST_EXCLUDE[name];
    if (ex === "*") continue;
    if (SKIP_WHEN_EMPTY.has(name) && (await db.all(sql.raw(`SELECT 1 FROM "${name}" LIMIT 1`))).length === 0) continue;
    const cols = (await db.all<{ name: string }>(sql.raw(`PRAGMA table_info("${name}")`))).map((c) => c.name).filter((c) => !ex?.includes(c));
    if (cols.length === 0) continue;
    const list = cols.map((c) => `"${c}"`).join(", ");
    let rows = await db.all<Record<string, unknown>>(sql.raw(`SELECT ${list} FROM "${name}" ORDER BY ${list}`));
    if (name === "settings") rows = rows.filter((r) => !SETTINGS_EXCLUDE.has(String(r.key)));
    out[name] = rows.map((r) => {
      const o: Record<string, unknown> = { ...r };
      for (const k of Object.keys(o)) o[k] = cell(o[k]);
      return o;
    });
  }
  return out;
}

export async function digestDb(db: Db): Promise<string> {
  return sha256Hex(canonicalJson(await dumpDb(db)));
}
