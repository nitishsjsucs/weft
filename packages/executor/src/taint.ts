// Taint (harness 6.2). run_taint is written only here. Every exec reads it fresh inside the call.
import { eq, sql } from "drizzle-orm";
import { runTaint, type DbTx } from "@weft/db";

export interface TaintState { tainted: boolean; taintedBy: string | null; sinceStep: number | null }

export async function readTaint(db: DbTx, runId: string): Promise<TaintState> {
  const [row] = await db.select().from(runTaint).where(eq(runTaint.runId, runId)).limit(1);
  return row ? { tainted: row.tainted, taintedBy: row.taintedBy, sinceStep: row.sinceStep } : { tainted: false, taintedBy: null, sinceStep: null };
}

/** Initial row at run open. */
export async function initTaint(tx: DbTx, runId: string, by: string | null): Promise<void> {
  await tx.insert(runTaint).values({ runId, tainted: by !== null, taintedBy: by, sinceStep: by !== null ? 0 : null });
}

/** Marks the run tainted. The first source is kept; later sources do not overwrite it. */
export async function markTainted(tx: DbTx, runId: string, by: string, step: number): Promise<void> {
  await tx.run(sql`INSERT INTO run_taint (run_id, tainted, tainted_by, since_step) VALUES (${runId}, 1, ${by}, ${step})
    ON CONFLICT(run_id) DO UPDATE SET tainted = 1, tainted_by = COALESCE(run_taint.tainted_by, excluded.tainted_by),
    since_step = COALESCE(run_taint.since_step, excluded.since_step)`);
  // Read-only mirror for the UI (agent_runs belongs to the brain; the row may not exist yet).
  await tx.run(sql`UPDATE agent_runs SET tainted = 1, tainted_by = COALESCE(tainted_by, ${by}) WHERE id = ${runId}`);
}
