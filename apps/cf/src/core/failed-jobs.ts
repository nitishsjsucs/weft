// D1 weft-ops failed_jobs (the table belongs to apps/cf/d1): jobs that failed for good, written by the weft-dlq
// consumer (queues.ts) and by CompanyDO for an outbox row it could never send. Best effort, off the data path.
import type { CoreEnv } from "../shared/env";
import { logError } from "../shared/log";

/** A job that failed for good, as D1 weft-ops failed_jobs keeps it. */
export interface FailedJob { jobId: string; kind: string; slot: string | null; gen: number | null; queue: string; attempts: number; code: string; message: string }

/** Records a job in D1 weft-ops failed_jobs (the table belongs to apps/cf/d1), once per job id; without the binding,
 * or when the write fails, the failure is only logged. */
export async function recordFailedJob(env: CoreEnv, f: FailedJob): Promise<void> {
  if (!env.OPS) return;
  try {
    await env.OPS.prepare(`INSERT OR IGNORE INTO failed_jobs (job_id, kind, slot, gen, queue, attempts, code, message, failed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
      .bind(f.jobId, f.kind, f.slot, f.gen, f.queue, f.attempts, f.code, f.message.slice(0, 500), new Date().toISOString())
      .run();
  } catch (e) {
    logError("job.dead.d1", e);
  }
}
