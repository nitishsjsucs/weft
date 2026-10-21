// After-commit jobs (design 3.4): validation of the queue message bodies, and the D1 job ledger that makes every
// handler idempotent on redelivery. Queues deliver at least once, so a handler records each job's progress in
// `jobs`: an OCR read that succeeded is kept until its write-back lands (a redelivery never pays for a second model
// call), and a finished job is acknowledged again without doing anything. Failures that retrying cannot fix go to
// `failed_jobs` at once; the rest retry and, after max_retries, reach `weft-dlq`, whose consumer records them too.
// Track cf6-extras.
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

export type JobState = "read" | "done" | "failed";
export interface JobRecord { state: JobState; outcome: string; result: unknown }
export interface FailedJob { jobId: string; kind: string; slot: string | null; gen: number | null; queue: string; attempts: number; code: string; message: string }

export interface JobLedger {
  get(jobId: string): Promise<JobRecord | null>;
  /** Keeps an intermediate result (an OCR read) until the job is done. */
  saveRead(jobId: string, kind: string, result: unknown): Promise<void>;
  /** Marks the job done and drops any intermediate result. */
  done(jobId: string, kind: string, outcome: string): Promise<void>;
  failed(f: FailedJob): Promise<void>;
}

export function d1JobLedger(db: D1Like, now: () => Date = () => new Date()): JobLedger {
  const at = () => now().toISOString();
  return {
    async get(jobId) {
      const r = await db.prepare("SELECT state, outcome, result_json FROM jobs WHERE job_id = ?").bind(jobId).first<{ state: JobState; outcome: string; result_json: string | null }>();
      if (!r) return null;
      let result: unknown = null;
      try { result = r.result_json ? JSON.parse(r.result_json) : null; } catch { result = null; }
      return { state: r.state, outcome: r.outcome, result };
    },
    async saveRead(jobId, kind, result) {
      await db.prepare("INSERT INTO jobs (job_id, kind, state, outcome, result_json, updated_at) VALUES (?, ?, 'read', '', ?, ?) ON CONFLICT (job_id) DO UPDATE SET state = 'read', result_json = excluded.result_json, updated_at = excluded.updated_at WHERE jobs.state = 'read'")
        .bind(jobId, kind, JSON.stringify(result), at()).run();
    },
    async done(jobId, kind, outcome) {
      await db.prepare("INSERT INTO jobs (job_id, kind, state, outcome, result_json, updated_at) VALUES (?, ?, 'done', ?, NULL, ?) ON CONFLICT (job_id) DO UPDATE SET state = 'done', outcome = excluded.outcome, result_json = NULL, updated_at = excluded.updated_at")
        .bind(jobId, kind, outcome.slice(0, 80), at()).run();
    },
    async failed(f) {
      await db.batch([
        db.prepare("INSERT INTO failed_jobs (job_id, kind, slot, gen, queue, attempts, code, message, failed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (job_id) DO UPDATE SET attempts = max(failed_jobs.attempts, excluded.attempts), code = excluded.code, message = excluded.message, failed_at = excluded.failed_at")
          .bind(f.jobId.slice(0, 64), f.kind.slice(0, 32), f.slot, f.gen, f.queue.slice(0, 32), f.attempts, f.code.slice(0, 40), f.message.slice(0, 300), at()),
        db.prepare("INSERT INTO jobs (job_id, kind, state, outcome, result_json, updated_at) VALUES (?, ?, 'failed', ?, NULL, ?) ON CONFLICT (job_id) DO UPDATE SET state = 'failed', outcome = excluded.outcome, result_json = NULL, updated_at = excluded.updated_at")
          .bind(f.jobId.slice(0, 64), f.kind.slice(0, 32), f.code.slice(0, 80), at()),
      ]);
    },
  };
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
