// The extras' queue consumers (design 3.4, 5.4, 7.1 and 10): weft-jobs (OCR, embeddings, exports), weft-render
// (PDF, concurrency 1) and weft-dlq. cf4-worker's queue() dispatch calls handleExtrasBatch. Every handler is
// idempotent on redelivery through the D1 job ledger: a done job is acknowledged again without work, an OCR read is
// kept until its write-back lands (so a redelivery never pays for a second model call), vector ids are
// deterministic, and R2 objects are keyed by content or job id. A job for an older generation of its world is dropped.
// Errors a retry cannot fix are recorded in failed_jobs at once; the rest retry with backoff and, after max_retries,
// arrive on weft-dlq. A job a daily neuron share refuses retries a few times (an open reservation may free up), then
// is parked in the ledger until the next UTC day, when the cron sends it again (extrasCron). A render that fails for
// good leaves a marker beside its PDF key, so the PDF route answers with the failure instead of 202. Track cf6-extras.
import {
  codeOf, createDocumentRenderer, createNoticeOcr, createReceiptOcr, ExtrasError, HIDDEN_SERVICE_COMMANDS, indexNotes, isRetryable, isUntrustedNote, messageOf, nextUtcDayStart,
  OCR_MODEL, parseJob, pdfFailureKey, pdfObjectKey, QUEUES, R2_PREFIXES, sha256Hex,
  type AiGatewayOption, type BrowserLauncher, type DailyCounters, type ExtrasFlags, type HostedJob, type ImagesLike, type JobLedger, type MessageBatchLike,
  type MetricsSink, type NeuronBudget, type NoticeScanExtract, type NoteToIndex, type QueueMessageLike, type R2BucketLike, type ReceiptOcrExtract, type VectorizeLike,
  type WorkersAiBindingLike,
} from "@weft/cf-extras";
import type { AigMetadata } from "../../../../packages/contracts/src/ext/cf-agent";
import { hostedWorldId } from "../../../../packages/contracts/src/ext/cf-hosted";
import type { SlotExtrasPort, SlotWorldInfo } from "./ports";

export interface ExtrasJobDeps {
  ai: WorkersAiBindingLike | null;
  images: ImagesLike | null;
  vectors: VectorizeLike | null;
  launch: BrowserLauncher | null;
  files: R2BucketLike;
  ledger: JobLedger;
  /** Browser time (the Lobby's daily counter). */
  counters: DailyCounters;
  neurons: NeuronBudget;
  flags: () => Promise<ExtrasFlags>;
  slots: (slot: string) => SlotExtrasPort;
  /** The Lobby records slot vector ids so a reset deletes them by id. */
  recordVectorIds?: (slot: string, gen: number, ids: string[]) => Promise<void>;
  metrics: MetricsSink;
  gatewayFor: (meta: AigMetadata) => AiGatewayOption | null;
  log?: (evt: Record<string, unknown>) => void;
  now?: () => Date;
}

type Outcome = string;
interface OcrRead { extract: ReceiptOcrExtract | NoticeScanExtract | null; model: string; neurons: number; code: string | null }

/** A world's refusal of a job from another generation than its own (CompanyDO.extrasWriteBack and extrasExport). */
export const STALE_GENERATION = "STALE_GENERATION";

/** Retry delay: 5 s, 10 s, 20 s and so on, at most 5 minutes. */
export const retryDelaySeconds = (attempts: number): number => Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));

/** A job a daily share refused retries this many deliveries (an open reservation may free up) before it is parked. */
export const BUDGET_RETRIES = 3;

/** The R2 key of a world or memory export: per world, generation and job, under `exports/` (3-day lifecycle). */
export const exportObjectKey = (j: { slot: string; gen: number; jobId: string; what: "memory" | "world" }): string =>
  `${R2_PREFIXES.exports}${j.slot}/g${j.gen}/${j.what}-${j.jobId.replace(/[^A-Za-z0-9_-]/g, "")}.${j.what === "memory" ? "fast-import" : "json"}`;

const kindOf = (body: unknown): string => (body && typeof body === "object" && typeof (body as { kind?: unknown }).kind === "string" ? String((body as { kind: string }).kind).slice(0, 32) : "unknown");
const refOf = (body: unknown) => {
  const b = (body && typeof body === "object" ? body : {}) as { jobId?: unknown; slot?: unknown; gen?: unknown };
  return { jobId: typeof b.jobId === "string" ? b.jobId : null, slot: typeof b.slot === "string" ? b.slot.slice(0, 32) : null, gen: typeof b.gen === "number" ? b.gen : null };
};

export async function handleExtrasBatch(batch: MessageBatchLike<unknown>, deps: ExtrasJobDeps): Promise<void> {
  for (const msg of batch.messages) await handleMessage(batch.queue, msg, deps);
}

async function handleMessage(queue: string, msg: QueueMessageLike<unknown>, deps: ExtrasJobDeps): Promise<void> {
  const ref = refOf(msg.body);
  const log = (evt: Record<string, unknown>) => deps.log?.({ evt: "extras.job", queue, msgId: msg.id, attempts: msg.attempts, ...evt });
  try {
    if (queue === QUEUES.dead) {
      await deps.ledger.failed({ jobId: ref.jobId ?? `msg:${msg.id}`, kind: kindOf(msg.body), slot: ref.slot, gen: ref.gen, queue, attempts: msg.attempts, code: "DEAD_LETTER", message: "retries exhausted" });
      await markRenderFailed(msg.body, "DEAD_LETTER", deps, log);
      deps.metrics.emit({ name: "job.dead", value: 1, slot: ref.slot ?? undefined, tags: { kind: kindOf(msg.body) } });
      log({ outcome: "dead_letter", kind: kindOf(msg.body) });
      msg.ack();
      return;
    }
    const parsed = parseJob(msg.body);
    if (!parsed.ok) throw new ExtrasError("JOB_INVALID", parsed.message);
    const job = parsed.job;
    const t0 = Date.now();
    const outcome = await runJob(job, deps, msg.attempts);
    deps.metrics.emit({ name: "job.done", value: Date.now() - t0, slot: job.slot, tags: { kind: job.kind, outcome } });
    log({ outcome, kind: job.kind, slot: job.slot, gen: job.gen });
    msg.ack();
  } catch (e) {
    if (isRetryable(e)) {
      log({ outcome: "retry", code: codeOf(e), message: messageOf(e) });
      msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
      return;
    }
    try {
      await deps.ledger.failed({ jobId: ref.jobId ?? `msg:${msg.id}`, kind: kindOf(msg.body), slot: ref.slot, gen: ref.gen, queue, attempts: msg.attempts, code: codeOf(e), message: messageOf(e) });
    } catch (le) {
      // The ledger itself failed: retry, so the failure is recorded on a later delivery.
      log({ outcome: "retry", code: "LEDGER", message: messageOf(le) });
      msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
      return;
    }
    await markRenderFailed(msg.body, codeOf(e), deps, log);
    deps.metrics.emit({ name: "job.dead", value: 1, slot: ref.slot ?? undefined, tags: { kind: kindOf(msg.body), code: codeOf(e) } });
    log({ outcome: "failed", code: codeOf(e), message: messageOf(e) });
    msg.ack();
  }
}

/** A render job that failed for good leaves a marker the PDF route reads, so the visitor sees the failure. */
async function markRenderFailed(body: unknown, code: string, deps: ExtrasJobDeps, log: (evt: Record<string, unknown>) => void): Promise<void> {
  const parsed = parseJob(body);
  if (!parsed.ok || parsed.job.kind !== "render.pdf") return;
  const j = parsed.job;
  const at = (deps.now?.() ?? new Date()).toISOString();
  try {
    await deps.files.put(pdfFailureKey(pdfObjectKey({ scope: "world", slot: j.slot, gen: j.gen, sha256: j.sha256 })), JSON.stringify({ code, at, jobId: j.jobId }), {
      httpMetadata: { contentType: "application/json" }, customMetadata: { code: code.slice(0, 40), at },
    });
  } catch (e) {
    log({ outcome: "marker_failed", code: "R2", message: messageOf(e) });
  }
}

/** Runs one job; returns its outcome word. Throws ExtrasError (not retryable) or anything else (retryable). */
export async function runJob(job: HostedJob, deps: ExtrasJobDeps, attempts = 1): Promise<Outcome> {
  const rec = await deps.ledger.get(job.jobId);
  if (rec && (rec.state === "done" || rec.state === "failed")) return `repeat:${rec.outcome}`;
  // A redelivery of a job that is parked: the cron sends it again when it is due.
  if (rec?.state === "deferred" && rec.notBefore && Date.parse(rec.notBefore) > (deps.now?.() ?? new Date()).getTime()) return "repeat:deferred";
  const port = deps.slots(job.slot);
  const world = await port.extrasWorld();
  if (world.gen !== job.gen || world.slot !== job.slot) {
    await deps.ledger.done(job.jobId, job.kind, "stale");
    return "stale";
  }
  switch (job.kind) {
    case "ocr.receipt":
    case "ocr.notice": return runOcr(job, deps, port, world, rec?.state === "read" ? (rec.result as OcrRead) : null, attempts);
    case "embed.memory": return runEmbed(job, deps, port, world, attempts);
    case "export.world": return runExport(job, deps, port);
    case "render.pdf": return runRender(job, deps);
  }
}

/**
 * A daily share refused the job: retry it shortly for the first few deliveries (an open reservation may settle), then
 * park it until the next UTC day, when the share is new and the cron sends it again.
 */
async function waitForBudget(job: HostedJob, deps: ExtrasJobDeps, attempts: number, code: string): Promise<Outcome> {
  if (attempts < BUDGET_RETRIES) throw new ExtrasError("BUDGET_WAIT", `${code}: waiting for the daily share`, true);
  await deps.ledger.defer(job, nextUtcDayStart(deps.now?.() ?? new Date()), `deferred:${code}`);
  return `deferred:${code}`;
}

async function runOcr(job: Extract<HostedJob, { kind: "ocr.receipt" | "ocr.notice" }>, deps: ExtrasJobDeps, port: SlotExtrasPort, world: SlotWorldInfo, saved: OcrRead | null, attempts: number): Promise<Outcome> {
  let read = saved;
  if (!read) {
    if (!(await deps.flags()).ocr) { await deps.ledger.done(job.jobId, job.kind, "skipped:OCR_DISABLED"); return "skipped:OCR_DISABLED"; }
    if (!deps.ai) throw new ExtrasError("BINDING_MISSING", "the AI binding is not configured");
    const bytes = await port.extrasBlob(job.storagePath);
    if (!bytes) throw new ExtrasError("BLOB_MISSING", `${job.storagePath} is not stored in ${job.slot}`);
    if ((await sha256Hex(bytes)) !== job.sha256) throw new ExtrasError("BLOB_MISMATCH", "the upload's bytes do not match the job");
    const ocrDeps = {
      ai: deps.ai, images: deps.images, neurons: deps.neurons, enabled: () => true,
      gateway: deps.gatewayFor({ slot: job.slot, gen: job.gen, run: null, kind: "ocr", visitor: world.lease?.visitor ?? null }),
      charge: { world: hostedWorldId(job), visitor: world.lease?.visitor ?? null, ipHash: world.lease?.ipHash ?? null },
    };
    const r = job.kind === "ocr.receipt"
      ? await createReceiptOcr(ocrDeps).read({ bytes, contentType: job.contentType, sha256: job.sha256 })
      : await createNoticeOcr(ocrDeps).read({ bytes, contentType: job.contentType, sha256: job.sha256 });
    if (!r.ok && r.code === "OCR_BUDGET") return waitForBudget(job, deps, attempts, r.code);
    // The kill flag drops the read: nothing queues behind a switched-off extra.
    if (!r.ok && r.code === "OCR_DISABLED") { await deps.ledger.done(job.jobId, job.kind, `skipped:${r.code}`); return `skipped:${r.code}`; }
    read = r.ok ? { extract: r.extract, model: r.model, neurons: r.neurons, code: null } : { extract: null, model: OCR_MODEL, neurons: 0, code: r.code };
    await deps.ledger.saveRead(job.jobId, job.kind, read);
  }
  // The job's generation goes with the write-back: the world refuses it once a reset moved on (the read above may
  // have taken long enough for one), so the previous visitor's extract never lands in the next visitor's world.
  const out = job.kind === "ocr.receipt"
    ? await port.extrasWriteBack({ command: HIDDEN_SERVICE_COMMANDS.receiptExtract, args: { job_id: job.jobId, expense_id: job.expenseId, upload_id: job.uploadId, extract: read.extract as ReceiptOcrExtract | null, model: read.model, neurons: read.neurons } }, job.gen)
    : await port.extrasWriteBack({ command: HIDDEN_SERVICE_COMMANDS.noticeExtract, args: { job_id: job.jobId, notice_id: job.noticeId, upload_id: job.uploadId, extract: read.extract as NoticeScanExtract | null, model: read.model, neurons: read.neurons } }, job.gen);
  if (!out.ok && out.code === STALE_GENERATION) {
    await deps.ledger.done(job.jobId, job.kind, "stale");
    return "stale";
  }
  if (!out.ok) throw new ExtrasError("WRITE_BACK_REFUSED", `${out.code}: ${out.message}`, out.retryable);
  const outcome = `${out.status}${read.code ? `:${read.code}` : ""}`;
  await deps.ledger.done(job.jobId, job.kind, outcome);
  return outcome;
}

async function runEmbed(job: Extract<HostedJob, { kind: "embed.memory" }>, deps: ExtrasJobDeps, port: SlotExtrasPort, world: SlotWorldInfo, attempts: number): Promise<Outcome> {
  // A slot indexes into its own namespace only; the shared seed namespace is written once per snapshot by the operator.
  if (job.namespace !== job.slot) throw new ExtrasError("JOB_INVALID", `a slot job may not write to namespace ${job.namespace}`);
  if (!(await deps.flags()).recallSemantic) { await deps.ledger.done(job.jobId, job.kind, "skipped:RECALL_OFF"); return "skipped:RECALL_OFF"; }
  if (!deps.ai || !deps.vectors) throw new ExtrasError("BINDING_MISSING", "the AI or Vectorize binding is not configured");
  const notes: NoteToIndex[] = [];
  // A read that fails (the slot is busy or resetting) throws and the job retries; only a note missing at its
  // commit is left out.
  for (const n of job.notes) {
    const text = await port.extrasMemoryText(n.path, n.commit);
    // The note's own frontmatter decides its trust too, whatever the job said.
    if (text !== null) notes.push({ ...n, tainted: n.tainted || isUntrustedNote(n.path, text), text });
  }
  if (notes.length === 0) { await deps.ledger.done(job.jobId, job.kind, "empty"); return "empty"; }
  let res: Awaited<ReturnType<typeof indexNotes>>;
  try {
    res = await indexNotes({
      ai: deps.ai, vectors: deps.vectors, neurons: deps.neurons,
      gateway: deps.gatewayFor({ slot: job.slot, gen: job.gen, run: null, kind: "embed", visitor: world.lease?.visitor ?? null }),
      charge: { world: hostedWorldId(job), visitor: world.lease?.visitor ?? null, ipHash: world.lease?.ipHash ?? null },
    }, { namespace: job.namespace, gen: job.gen, notes });
  } catch (e) {
    if (e instanceof ExtrasError && e.code === "EMBED_BUDGET") return waitForBudget(job, deps, attempts, e.code);
    throw e;
  }
  await deps.recordVectorIds?.(job.slot, job.gen, res.ids);
  const outcome = `indexed:${res.chunks}`;
  await deps.ledger.done(job.jobId, job.kind, outcome);
  return outcome;
}

async function runExport(job: Extract<HostedJob, { kind: "export.world" }>, deps: ExtrasJobDeps, port: SlotExtrasPort): Promise<Outcome> {
  const key = exportObjectKey(job);
  if (!(await deps.files.head(key))) {
    const out = await port.extrasExport(job.what, job.gen);
    await deps.files.put(key, out.bytes, { httpMetadata: { contentType: out.contentType }, customMetadata: { slot: job.slot, gen: String(job.gen), what: job.what, requestedBy: job.requestedBy.slice(0, 64) } });
  }
  await deps.ledger.done(job.jobId, job.kind, "stored");
  return "stored";
}

async function runRender(job: Extract<HostedJob, { kind: "render.pdf" }>, deps: ExtrasJobDeps): Promise<Outcome> {
  if (!deps.launch) throw new ExtrasError("BINDING_MISSING", "the Browser binding is not configured");
  const renderer = createDocumentRenderer({ files: deps.files, launch: deps.launch, counters: deps.counters, enabled: async () => (await deps.flags()).pdf });
  const r = await renderer.render({ kind: job.pdf, html: job.html, key: { scope: "world", slot: job.slot, gen: job.gen, sha256: job.sha256 } });
  const outcome = r.cached ? "cached" : "rendered";
  await deps.ledger.done(job.jobId, job.kind, outcome);
  return outcome;
}
