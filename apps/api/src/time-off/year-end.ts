// Time-off year end on the scheduler tick (wave 3, docs/wave3.md). Owner: w3-timeoff. On the first tick of a new year,
// svc_scheduler runs time_off.close_year (carryover and forfeits per policy). Scaffold: no-op.
import type { ExecutorBundle, SimClock } from "@weft/contracts";
import type { Db } from "@weft/db";

export async function timeOffYearEnd(_d: { db: Db; clock: SimClock; executor: ExecutorBundle; now: string }): Promise<void> {}
