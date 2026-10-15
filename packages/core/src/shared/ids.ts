import { sql } from "drizzle-orm";
import { formatId, type IdPrefix } from "@weft/contracts";
import type { DbTx } from "@weft/db";

/** Next id for a prefix from the id_counters table, inside the caller's transaction: wrk_0001, wrk_0002, ... */
export async function newId(tx: DbTx, prefix: IdPrefix): Promise<string> {
  const rows = await tx.all<{ next: number }>(sql`INSERT INTO id_counters (prefix, next) VALUES (${prefix}, 1)
    ON CONFLICT(prefix) DO UPDATE SET next = next + 1 RETURNING next`);
  const n = rows[0]?.next;
  if (typeof n !== "number") throw new Error(`newId: no counter for ${prefix}`);
  return formatId(prefix, n);
}

/** Binds newId to a transaction, the shape CommandDeps.newId expects. */
export function idMinter(tx: DbTx): (prefix: IdPrefix) => Promise<string> {
  return (prefix) => newId(tx, prefix);
}
