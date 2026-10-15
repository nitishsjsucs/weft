import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, migrate, openDb, type Db } from "@weft/db";
import type { SimClock } from "@weft/contracts";

export interface SimTestWorld { db: Db; clock: SimClock; dir: string; close(): Promise<void> }

/** Monday 2026-10-26 08:30 PT, frozen. */
export async function simWorld(at = "2026-10-26T15:30:00.000Z"): Promise<SimTestWorld> {
  const dir = mkdtempSync(join(tmpdir(), "weft-sim-"));
  const db = openDb({ dataDir: dir });
  await migrate(db);
  const clock = fixedClock(at);
  return { db, clock, dir, async close() { await closeDb(db); rmSync(dir, { recursive: true, force: true }); } };
}

export const CRED = "sim-portal-secret-value-0001";

/** A frozen in-memory SimClock for simulator tests. */
export function fixedClock(at: string): SimClock {
  let now = at;
  return { now: () => now, rate: () => 0, advance: async (to) => { now = to; }, set: async (to) => { now = to; } };
}
