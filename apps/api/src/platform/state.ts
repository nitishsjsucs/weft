// SmallState (docs/cloudflare/design.md 4.1): small synchronous per-world values. On the durable platform they are
// rows of the kv_state table, read and written with the Durable Object's synchronous SQL API, so a write inside a
// transaction commits and rolls back with it. On Node they are files under the data dir; the world id keeps its
// existing file (companies/.world-id) so the spend ledger keeps keying runs as before. The world digest never counts
// kv_state.
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { kvState, type Db } from "@weft/db";
import type { SqlStorageLike } from "../../../../packages/contracts/src/ext/cf-db";
import { SMALL_STATE_KEYS, type SmallState } from "../../../../packages/contracts/src/ext/cf-platform";
import { worldIdFile } from "../world-id";

/** node:fs on first use, never a static import: this module is on the hosted import graph (docs/cloudflare/design.md
 * 6.4), where only Node's code paths call it. */
const fs = () => process.getBuiltinModule("node:fs");

const KEY = /^[a-z][a-z0-9_.-]{0,79}$/;
const checkKey = (key: string) => { if (!KEY.test(key)) throw new Error(`bad small state key ${JSON.stringify(key).slice(0, 40)}`); return key; };

/** kv_state over the synchronous SQL API (workerd's ctx.storage.sql, or the node:sqlite emulator). */
export function sqlSmallState(sql: SqlStorageLike): SmallState {
  const get = (key: string): string | null => {
    const rows = sql.exec<{ value: string }>("SELECT value FROM kv_state WHERE key = ?", checkKey(key)).toArray();
    const v = rows[0]?.value;
    return typeof v === "string" ? v : null;
  };
  return {
    get,
    set(key, value) {
      sql.exec("INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", checkKey(key), String(value));
    },
    setIfAbsent(key, value) {
      sql.exec("INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING", checkKey(key), String(value));
      return get(key) ?? String(value);
    },
    delete(key) {
      sql.exec("DELETE FROM kv_state WHERE key = ?", checkKey(key));
    },
  };
}

/** Node: one file per key under <dataDir>/run/state, and the world id in its own file beside the memory repos. */
export function fileSmallState(dataDir: string): SmallState {
  const fileOf = (key: string) => (checkKey(key) === SMALL_STATE_KEYS.worldId ? worldIdFile(dataDir) : join(dataDir, "run", "state", key));
  const get = (key: string): string | null => {
    try { return fs().readFileSync(fileOf(key), "utf8").trim() || null; } catch { return null; }
  };
  return {
    get,
    set(key, value) {
      const f = fileOf(key);
      fs().mkdirSync(dirname(f), { recursive: true });
      fs().writeFileSync(f, `${value}\n`, { mode: 0o600 });
    },
    setIfAbsent(key, value) {
      const f = fileOf(key);
      fs().mkdirSync(dirname(f), { recursive: true });
      try { fs().writeFileSync(f, `${value}\n`, { flag: "wx", mode: 0o600 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      return get(key) ?? value;
    },
    delete(key) { fs().rmSync(fileOf(key), { force: true }); },
  };
}

/**
 * One kv_state row through the drizzle Db, on every platform: where the routines engine keeps its prebuilt hash
 * (docs/cloudflare/design.md 4.4). It lives with the world's tables, so a Node reset (every table dropped) and a
 * hosted restore take it with the routine rows; the world digest never counts kv_state.
 */
export function kvRow(db: Db, key: string): { get(): Promise<string | null>; set(value: string): Promise<void> } {
  checkKey(key);
  return {
    async get() { return (await db.select({ v: kvState.value }).from(kvState).where(eq(kvState.key, key)).limit(1))[0]?.v ?? null; },
    async set(value) { await db.insert(kvState).values({ key, value }).onConflictDoUpdate({ target: kvState.key, set: { value } }); },
  };
}
