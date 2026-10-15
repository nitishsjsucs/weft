// Simulator ids come from the shared id_counters table inside the caller's transaction (sima_0001, simc_0001, ...).
import { sql } from "drizzle-orm";
import { formatId, type IdPrefix } from "@weft/contracts";
import type { DbTx } from "@weft/db";

export async function mintId(db: DbTx, prefix: IdPrefix): Promise<string> {
  const rows = await db.all<{ next: number }>(sql`INSERT INTO id_counters (prefix, next) VALUES (${prefix}, 1)
    ON CONFLICT(prefix) DO UPDATE SET next = next + 1 RETURNING next`);
  const n = rows[0]?.next;
  if (typeof n !== "number") throw new Error(`mintId: no counter for ${prefix}`);
  return formatId(prefix, n);
}

/** The numeric part of a counter id: sima_0007 gives 7. */
export function seqOf(id: string): number {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}
