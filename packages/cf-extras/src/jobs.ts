// After-commit jobs (design 3.4): validation of the queue message bodies, and the D1 job ledger that makes every
// handler idempotent on redelivery. Queues deliver at least once, so a handler records each job's progress in
// `jobs`: an OCR read that succeeded is kept until its write-back lands (a redelivery never pays for a second model
// call), and a finished job is acknowledged again without doing anything. Failures that retrying cannot fix go to
// `failed_jobs` at once; the rest retry and, after max_retries, reach `weft-dlq`, whose consumer records them too.
// A job a daily share refuses is parked until the next UTC day and sent again by the cron. Track cf6-extras.
import { z } from "zod";
import { QUEUES, type HostedJob } from "../../contracts/src/ext/cf-extras";
import type { D1Like } from "./bindings";

const Id = (prefix: string) => z.string().min(prefix.length + 1).max(64).startsWith(prefix);
const Slot = z.string().regex(/^[a-z0-9-]{1,32}$/);
const Sha = z.string().regex(/^[0-9a-f]{64}$/);
const Base = { v: z.literal(1), jobId: z.string().min(1).max(64), slot: Slot, gen: z.number().int().min(0) };
const Ocr = { uploadId: Id("upl_"), sha256: Sha, storagePath: z.string().min(1).max(200), contentType: z.string().max(100) };

export const HostedJobSchema = z.discriminatedUnion("kind", [
  z.object({ ...Base, kind: z.literal("ocr.receipt"), expenseId: Id("exp_"), ...Ocr }).strict(),
  z.object({ ...Base, kind: z.literal("ocr.notice"), noticeId: Id("ntc_"), ...Ocr }).strict(),
  z.object({
    ...Base, kind: z.literal("embed.memory"), namespace: z.string().min(1).max(64),
    notes: z.array(z.object({ path: z.string().min(1).max(200), commit: z.string().regex(/^[0-9a-f]{40}$/), tainted: z.boolean(), kind: z.string().max(32) }).strict()).min(1).max(50),
  }).strict(),
  z.object({ ...Base, kind: z.literal("export.world"), what: z.enum(["memory", "world"]), requestedBy: z.string().min(1).max(64) }).strict(),
  z.object({
    ...Base, kind: z.literal("render.pdf"), pdf: z.enum(["offer_letter", "signed_agreement", "pay_stub"]), subjectId: z.string().min(1).max(64),
    sha256: Sha, html: z.string().min(1).max(100_000),
  }).strict(),
]);

export function parseJob(body: unknown): { ok: true; job: HostedJob } | { ok: false; message: string } {
  const r = HostedJobSchema.safeParse(body);
  return r.success ? { ok: true, job: r.data as HostedJob } : { ok: false, message: r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") };
}

/** A job's queue (render jobs have their own, at concurrency 1). */
export const queueOfJob = (j: Pick<HostedJob, "kind">): string => (j.kind === "render.pdf" ? QUEUES.render : QUEUES.jobs);

// Ledger ----------------------------------------------------------------------------------------------------------

/**
 * A job's progress. `read` keeps an OCR read until its write-back lands. `deferred` parks a job a daily share
 * refused until `notBefore` (its body kept, so the cron sends it again); `requeued` is a parked job sent again.
 */
export type JobState = "read" | "done" | "failed" | "deferred" | "requeued";
export interface JobRecord { state: JobState; outcome: string; result: unknown; notBefore?: string }
export interface FailedJob { jobId: string; kind: string; slot: string | null; gen: number | null; queue: string; attempts: number; code: string; message: string }

/**
 * The ledger is keyed by job id alone, across every slot and generation: job ids must be globally unique (the outbox
 * mints random `obx_<16 hex>` ids, and the PDF route mints its own the same way).
 */
export interface JobLedger {
  get(jobId: string): Promise<JobRecord | null>;
  /** Keeps an intermediate result (an OCR read) until the job is done. */
  saveRead(jobId: string, kind: string, result: unknown): Promise<void>;
  /** Marks the job done and drops any intermediate result. */
  done(jobId: string, kind: string, outcome: string): Promise<void>;
  failed(f: FailedJob): Promise<void>;
  /** Parks a job until `notBefore` (ISO time), keeping its body; never a job that is done, failed or read. */
  defer(job: HostedJob, notBefore: string, outcome: string): Promise<void>;
  /** Parked jobs due by `now`, and sent-again ones that made no progress in an hour (a send that was lost). */
  due(now: Date, limit: number): Promise<HostedJob[]>;
  /** Records that a parked job was sent again. */
  requeued(jobId: string): Promise<void>;
}

/** A requeued job that has not moved on in this long is sent again. */
export const REQUEUE_STALE_MS = 60 * 60_000;

export function d1JobLedger(db: D1Like, now: () => Date = () => new Date()): JobLedger {
  const at = () => now().toISOString();
  return {
    async get(jobId) {
      const r = await db.prepare("SELECT state, outcome, result_json, not_before FROM jobs WHERE job_id = ?").bind(jobId).first<{ state: JobState; outcome: string; result_json: string | null; not_before: string | null }>();
      if (!r) return null;
      let result: unknown = null;
      try { result = r.result_json ? JSON.parse(r.result_json) : null; } catch { result = null; }
      return { state: r.state, outcome: r.outcome, result, ...(r.not_before ? { notBefore: r.not_before } : {}) };
    },
    async saveRead(jobId, kind, result) {
      await db.prepare("INSERT INTO jobs (job_id, kind, state, outcome, result_json, updated_at) VALUES (?, ?, 'read', '', ?, ?) ON CONFLICT (job_id) DO UPDATE SET state = 'read', result_json = excluded.result_json, not_before = NULL, updated_at = excluded.updated_at WHERE jobs.state IN ('read', 'deferred', 'requeued')")
        .bind(jobId, kind, JSON.stringify(result), at()).run();
    },
    async done(jobId, kind, outcome) {
      await db.prepare("INSERT INTO jobs (job_id, kind, state, outcome, result_json, updated_at) VALUES (?, ?, 'done', ?, NULL, ?) ON CONFLICT (job_id) DO UPDATE SET state = 'done', outcome = excluded.outcome, result_json = NULL, not_before = NULL, updated_at = excluded.updated_at")
        .bind(jobId, kind, outcome.slice(0, 80), at()).run();
    },
    async failed(f) {
      await db.batch([
        db.prepare("INSERT INTO failed_jobs (job_id, kind, slot, gen, queue, attempts, code, message, failed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (job_id) DO UPDATE SET attempts = max(failed_jobs.attempts, excluded.attempts), code = excluded.code, message = excluded.message, failed_at = excluded.failed_at")
          .bind(f.jobId.slice(0, 64), f.kind.slice(0, 32), f.slot, f.gen, f.queue.slice(0, 32), f.attempts, f.code.slice(0, 40), f.message.slice(0, 300), at()),
        db.prepare("INSERT INTO jobs (job_id, kind, state, outcome, result_json, updated_at) VALUES (?, ?, 'failed', ?, NULL, ?) ON CONFLICT (job_id) DO UPDATE SET state = 'failed', outcome = excluded.outcome, result_json = NULL, not_before = NULL, updated_at = excluded.updated_at")
          .bind(f.jobId.slice(0, 64), f.kind.slice(0, 32), f.code.slice(0, 80), at()),
      ]);
    },
    async defer(job, notBefore, outcome) {
      await db.prepare("INSERT INTO jobs (job_id, kind, state, outcome, result_json, updated_at, not_before) VALUES (?, ?, 'deferred', ?, ?, ?, ?) ON CONFLICT (job_id) DO UPDATE SET state = 'deferred', outcome = excluded.outcome, result_json = excluded.result_json, updated_at = excluded.updated_at, not_before = excluded.not_before WHERE jobs.state IN ('deferred', 'requeued')")
        .bind(job.jobId, job.kind, outcome.slice(0, 80), JSON.stringify(job), at(), notBefore).run();
    },
    async due(t, limit) {
      const stale = new Date(t.getTime() - REQUEUE_STALE_MS).toISOString();
      const r = await db.prepare("SELECT job_id, result_json FROM jobs WHERE (state = 'deferred' AND not_before <= ?) OR (state = 'requeued' AND updated_at <= ?) ORDER BY updated_at LIMIT ?")
        .bind(t.toISOString(), stale, limit).all<{ job_id: string; result_json: string | null }>();
      const out: HostedJob[] = [];
      for (const row of r.results ?? []) {
        let body: unknown = null;
        try { body = row.result_json ? JSON.parse(row.result_json) : null; } catch { body = null; }
        const parsed = parseJob(body);
        if (parsed.ok && parsed.job.jobId === row.job_id) out.push(parsed.job);
      }
      return out;
    },
    async requeued(jobId) {
      await db.prepare("UPDATE jobs SET state = 'requeued', updated_at = ? WHERE job_id = ? AND state IN ('deferred', 'requeued')").bind(at(), jobId).run();
    },
  };
}

/** The next 00:00 UTC after `now`, plus a minute so the daily counters have rolled over. */
export function nextUtcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 1)).toISOString();
}

/**
 * Sends the parked jobs that are due back to their queues (the cron calls this every 15 minutes). A job is marked
 * sent only after its send succeeded; a lost send is retried an hour later, and a redelivered job does no work twice.
 */
export async function requeueDueJobs(ledger: Pick<JobLedger, "due" | "requeued">, send: (job: HostedJob) => Promise<unknown>, now: Date = new Date(), limit = 50): Promise<number> {
  let n = 0;
  for (const job of await ledger.due(now, limit)) {
    await send(job);
    await ledger.requeued(job.jobId);
    n++;
  }
  return n;
}

/** Keeps `weft-ops` small: the cron sweep calls this once a day (design 9.1 lifecycle, D1 storage). */
export async function pruneOps(db: D1Like, now: Date = new Date(), keep: { jobsDays?: number; failedDays?: number; metricsDays?: number; catalogDays?: number } = {}): Promise<void> {
  const before = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM jobs WHERE updated_at < ?").bind(before(keep.jobsDays ?? 7)),
    db.prepare("DELETE FROM failed_jobs WHERE failed_at < ?").bind(before(keep.failedDays ?? 30)),
    db.prepare("DELETE FROM metrics_daily WHERE day < ?").bind(before(keep.metricsDays ?? 90).slice(0, 10)),
    db.prepare("DELETE FROM run_catalog WHERE day < ?").bind(before(keep.catalogDays ?? 90).slice(0, 10)),
  ]);
}
