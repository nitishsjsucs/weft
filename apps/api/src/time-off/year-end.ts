// Time-off year end on the scheduler tick (wave 3, docs/wave3.md). Owner: w3-timeoff. On the first tick of a new year,
// svc_scheduler runs time_off.close_year (carryover and forfeits per policy, then the new year's front loads). The
// ledger's run keys (close:<year>:<assignment>) make it idempotent, so a later tick in the same year is a cheap no-op.
import { sql } from "drizzle-orm";
import type { ExecutorBundle, SimClock } from "@weft/contracts";
import type { Db } from "@weft/db";

/** Years this process already closed, per database (a restart re-checks the ledger once). */
const closedIn = new WeakMap<Db, Set<number>>();
const ptYear = (iso: string) => Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric" }).format(new Date(Date.parse(iso))));

export async function timeOffYearEnd(d: { db: Db; clock: SimClock; executor: ExecutorBundle; now: string }): Promise<void> {
  const closing = ptYear(d.now) - 1;
  const seen = closedIn.get(d.db) ?? new Set<number>();
  closedIn.set(d.db, seen);
  if (seen.has(closing)) return;
  // Only a year the ledger has rows in, and only once: any close row for it means it was closed.
  const [rows] = await d.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM time_off_ledger WHERE effective_date LIKE ${`${closing}-%`}`);
  if (!rows?.n) { seen.add(closing); return; }
  const [done] = await d.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM time_off_ledger WHERE run_key LIKE ${`close:${closing}:%`} OR run_key LIKE ${`front:${closing + 1}:%`}`);
  if (!done?.n) await d.executor.system.exec("svc_scheduler", "time_off.close_year", { year: closing }, { eventId: null, attended: false, requestedBy: null });
  seen.add(closing);
}
