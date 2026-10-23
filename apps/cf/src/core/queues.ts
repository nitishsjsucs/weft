// Queue consumers (design 3.1, 7.1 and 10): weft-jobs (OCR, embeddings, exports) and weft-render (PDF, concurrency
// 1) dispatch each message to the extras handler for its kind; a handler that throws retries the message (the
// queue's retry delay and max_retries apply, then weft-dlq). weft-dlq records each dead letter (D1 failed_jobs,
// through the extras module's handler when it has one) and logs it. The consumers never evaluate @weft/*. Handlers
// are idempotent on redelivery, keyed by the job id (the outbox row id).
import { QUEUES, type HostedJob } from "../shared/contracts";
import type { CoreEnv } from "../shared/env";
import { logError, logEvent } from "../shared/log";
import { deadLetterHandler, jobHandler } from "./extras-port";
import { recordFailedJob } from "./failed-jobs";

const KNOWN_KINDS = new Set(["ocr.receipt", "ocr.notice", "embed.memory", "export.world", "render.pdf"]);

function isJob(body: unknown): body is HostedJob {
  const b = body as Partial<HostedJob> | null;
  return !!b && typeof b === "object" && b.v === 1 && typeof b.kind === "string" && KNOWN_KINDS.has(b.kind) && typeof b.jobId === "string" && typeof b.slot === "string" && Number.isInteger(b.gen);
}

export async function handleQueue(batch: MessageBatch<unknown>, env: CoreEnv): Promise<{ acked: number; retried: number; dead: number }> {
  let acked = 0, retried = 0, dead = 0;
  if (batch.queue === QUEUES.dead) {
    for (const m of batch.messages) {
      const job = m.body as Partial<HostedJob> | null;
      try {
        const h = deadLetterHandler();
        if (h) await h(m.body, env, { queue: batch.queue, attempts: m.attempts, id: m.id });
        else await recordFailedJob(env, { jobId: String(job?.jobId ?? crypto.randomUUID()), kind: String(job?.kind ?? "unknown"), slot: job?.slot ?? null, gen: job?.gen ?? null, queue: QUEUES.dead, attempts: m.attempts, code: "DEAD_LETTER", message: "retries exhausted" });
        logEvent("job.dead", { kind: job?.kind ?? "unknown", slot: job?.slot ?? null, gen: job?.gen ?? null, attempts: m.attempts });
        m.ack();
        dead += 1;
      } catch (e) {
        logError("job.dead.record", e, { kind: job?.kind ?? "unknown" });
        m.retry();
        retried += 1;
      }
    }
    return { acked, retried, dead };
  }
  for (const m of batch.messages) {
    if (!isJob(m.body)) {
      logEvent("job.malformed", { queue: batch.queue });
      m.ack();
      acked += 1;
      continue;
    }
    const job = m.body;
    const h = jobHandler(job.kind);
    if (!h) {
      logEvent("job.unhandled", { kind: job.kind, slot: job.slot, gen: job.gen, outcome: "acked" });
      m.ack();
      acked += 1;
      continue;
    }
    const t0 = Date.now();
    try {
      await h(job, env);
      logEvent("job.done", { kind: job.kind, slot: job.slot, gen: job.gen, ms: Date.now() - t0, attempts: m.attempts });
      m.ack();
      acked += 1;
    } catch (e) {
      logError("job.failed", e, { kind: job.kind, slot: job.slot, gen: job.gen, attempts: m.attempts });
      m.retry();
      retried += 1;
    }
  }
  return { acked, retried, dead };
}
