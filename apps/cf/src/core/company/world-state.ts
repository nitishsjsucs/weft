// The world stamp a slot keeps in its own storage: `kv_state('world.id') = "slot-N:gen-G"` (SMALL_STATE_KEYS) plus the
// read-only flag and the lease's visitor and IP hash. CompanyDO reads it with plain SQL before any @weft/* module
// loads, so an unprovisioned object never evaluates the Weft stack. The table comes from migration 0008_hosted.sql;
// before the first restore it does not exist and the object is unprovisioned.
import { DO_NAMES, hostedWorldId, SMALL_STATE_KEYS, type WorldMode } from "../../shared/contracts";
import type { WorldStamp } from "./rpc";

interface SqlLike { exec(q: string, ...b: unknown[]): { toArray(): Record<string, unknown>[] } }

export function modeOf(slot: string): WorldMode {
  if (slot === DO_NAMES.showcase) return "showcase";
  if (slot === DO_NAMES.smoke) return "smoke";
  if (slot === DO_NAMES.conformance) return "conformance";
  return "slot";
}

export function parseWorldId(v: string | null | undefined): { slot: string; gen: number } | null {
  const m = /^([a-z0-9-]{1,32}):gen-(\d{1,9})$/.exec(v ?? "");
  return m ? { slot: m[1]!, gen: Number(m[2]) } : null;
}

export function hasKvState(sql: SqlLike): boolean {
  return sql.exec(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'kv_state'`).toArray().length > 0;
}

export function readStamp(sql: SqlLike): WorldStamp | null {
  if (!hasKvState(sql)) return null;
  const rows = sql.exec(`SELECT key, value FROM kv_state WHERE key IN (?, ?, ?, ?)`,
    SMALL_STATE_KEYS.worldId, SMALL_STATE_KEYS.readOnly, SMALL_STATE_KEYS.leaseVisitor, SMALL_STATE_KEYS.leaseIpHash).toArray();
  const get = (k: string) => (rows.find((r) => r.key === k)?.value as string | undefined) ?? null;
  const id = parseWorldId(get(SMALL_STATE_KEYS.worldId));
  if (!id) return null;
  return { slot: id.slot, gen: id.gen, mode: modeOf(id.slot), visitor: get(SMALL_STATE_KEYS.leaseVisitor), ipHash: get(SMALL_STATE_KEYS.leaseIpHash) };
}

/** Writes the stamp (inside the caller's transaction when there is one). */
export function writeStamp(sql: SqlLike, s: WorldStamp): void {
  const put = (k: string, v: string) => sql.exec(`INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, k, v);
  const del = (k: string) => sql.exec(`DELETE FROM kv_state WHERE key = ?`, k);
  put(SMALL_STATE_KEYS.worldId, hostedWorldId(s));
  if (s.mode === "showcase") put(SMALL_STATE_KEYS.readOnly, "1");
  else del(SMALL_STATE_KEYS.readOnly);
  if (s.visitor) put(SMALL_STATE_KEYS.leaseVisitor, s.visitor); else del(SMALL_STATE_KEYS.leaseVisitor);
  if (s.ipHash) put(SMALL_STATE_KEYS.leaseIpHash, s.ipHash); else del(SMALL_STATE_KEYS.leaseIpHash);
  // Keys minted for an earlier lease die with it.
  del(SMALL_STATE_KEYS.leaseKeys);
}

export function leaseKeys(sql: SqlLike): string[] {
  if (!hasKvState(sql)) return [];
  const v = sql.exec(`SELECT value FROM kv_state WHERE key = ?`, SMALL_STATE_KEYS.leaseKeys).toArray()[0]?.value;
  try { const a = JSON.parse(String(v ?? "[]")) as unknown; return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}

export function addLeaseKey(sql: SqlLike, key: string): void {
  const keys = [...leaseKeys(sql), key].slice(-8);
  sql.exec(`INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, SMALL_STATE_KEYS.leaseKeys, JSON.stringify(keys));
}
