// The extras' part of weft-core's cron (design 9.1; cf4-worker's scheduled handler calls it every 15 minutes): parked
// jobs that are due (a daily neuron share refused them) go back to their queues, the model comparison is computed
// into its one D1 row (refreshComparison, so the anonymous GET /api/_hosted/models reads that row and never the
// runs), and once a day, in the first quarter hour after 00:00 UTC, `weft-ops` is pruned. It never evaluates @weft/*
// (design 3.2). Track cf6-extras.
import { d1JobLedger, messageOf, pruneOps, QUEUES, queueOfJob, refreshComparison, requeueDueJobs, type HostedJob, type QueueLike } from "@weft/cf-extras";
import type { ExtrasEnv } from "./env";

export interface ExtrasCronEnv extends Pick<ExtrasEnv, "OPS"> {
  JOBS?: QueueLike<HostedJob>;
  RENDER?: QueueLike<HostedJob>;
}
export interface ExtrasCronResult { requeued: number; pruned: boolean; compared: number | null }

export async function extrasCron(env: ExtrasCronEnv, now: Date = new Date(), log: (evt: Record<string, unknown>) => void = (e) => console.log(JSON.stringify(e))): Promise<ExtrasCronResult> {
  let requeued = 0;
  if (env.JOBS) {
    const jobs = env.JOBS, render = env.RENDER ?? null;
    try {
      requeued = await requeueDueJobs(d1JobLedger(env.OPS, () => now), async (job) => {
        const q = queueOfJob(job) === QUEUES.render ? render : jobs;
        if (!q) throw new Error(`no producer binding for ${queueOfJob(job)}`);
        await q.send(job, { contentType: "json" });
      }, now);
    } catch (e) {
      // The jobs not sent stay parked and go on the next run.
      log({ evt: "extras.cron", outcome: "requeue_failed", message: messageOf(e) });
    }
  }
  const pruned = now.getUTCHours() === 0 && now.getUTCMinutes() < 15;
  if (pruned) await pruneOps(env.OPS, now);
  let compared: number | null = null;
  try {
    compared = (await refreshComparison(env.OPS, now)).rows;
  } catch (e) {
    // The stored comparison stays as it was until the next run.
    log({ evt: "extras.cron", outcome: "compare_failed", message: messageOf(e) });
  }
  log({ evt: "extras.cron", requeued, pruned, compared });
  return { requeued, pruned, compared };
}
