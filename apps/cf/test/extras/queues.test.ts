// The extras' queue consumers (design 3.4 and 5.4): every handler is idempotent on redelivery, a job for an older
// generation is dropped, failures a retry cannot fix are recorded at once, transient ones retry with backoff, and
// weft-dlq records what ran out of retries. A job a daily share refuses retries briefly, is parked until the next UTC
// day and sent again by the cron; a render that fails for good leaves the marker the PDF route reads. The slot is
// faked behind the CompanyDO seam here; slot.test.ts runs the same jobs against a real world.
import { describe, expect, it } from "vitest";
import { d1JobLedger, EMBEDDING_MODEL, memoryNeuronBudget, OCR_MODEL, pdfFailureKey, pdfObjectKey, renderPdfHtml, sha256Hex, type HostedJob, type MessageBatchLike } from "@weft/cf-extras";
import { extrasCron } from "../../src/extras/cron";
import { BUDGET_RETRIES, exportObjectKey, handleExtrasBatch, retryDelaySeconds, STALE_GENERATION } from "../../src/extras/queues";
import { batch, embeddingHandler, fakeAi, fakeBrowser, fakeImages, fakeSlot, fakeVectorize, FLAGS_ON, jobDeps, memoryR2, message, TINY_JPEG } from "./helpers";

// 290 prompt and 41 completion tokens: ceil(290 x 0.031876 + 41 x 0.050488) = 12 neurons.
const ocrReply = () => ({ response: JSON.stringify({ merchant: "Corner Deli (demo)", date: "2026-10-22", total: "41.38", currency: "USD", confidence: 0.91 }), usage: { prompt_tokens: 290, completion_tokens: 41 } });
async function receiptJob(o: Partial<Extract<HostedJob, { kind: "ocr.receipt" }>> = {}) {
  const sha = await sha256Hex(TINY_JPEG);
  return { v: 1 as const, kind: "ocr.receipt" as const, jobId: "obx_0001", slot: "slot-1", gen: 3, uploadId: "upl_0042", expenseId: "exp_0201", sha256: sha, storagePath: `blob:${sha}`, contentType: "image/jpeg", ...o };
}
const run = (deps: Parameters<typeof handleExtrasBatch>[1], queue: string, ...msgs: ReturnType<typeof message>[]) => handleExtrasBatch(batch(queue, msgs) as MessageBatchLike<unknown>, deps);

describe("OCR jobs", () => {
  it("read once, write back once, and a redelivery does nothing", async () => {
    const slot = fakeSlot();
    const job = await receiptJob();
    slot.blobs.set(job.storagePath, TINY_JPEG);
    const ai = fakeAi({ [OCR_MODEL]: ocrReply });
    const images = fakeImages();
    const deps = jobDeps({ "slot-1": slot }, { ai, images });
    const first = message(job);
    await run(deps, "weft-jobs", first);
    expect(first.acked).toBe(1);
    expect(slot.writeBacks).toEqual([{ command: "expenses.attach_receipt_extract", args: { job_id: "obx_0001", expense_id: "exp_0201", upload_id: "upl_0042", extract: { merchant: "Corner Deli (demo)", date: "2026-10-22", totalCents: 4138, currency: "USD", confidence: 0.91 }, model: OCR_MODEL, neurons: 12 } }]);
    const again = message(job, 1);
    await run(deps, "weft-jobs", again);
    expect(again.acked).toBe(1);
    expect(ai.calls).toHaveLength(1);
    expect(images.transforms).toHaveLength(2);
    expect(slot.writeBacks).toHaveLength(1);
    expect(deps.db.rows("jobs")).toMatchObject([{ job_id: "obx_0001", state: "done", outcome: "attached", result_json: null }]);
    expect(deps.metrics.points.map((p) => p.tags?.outcome)).toEqual(["attached", "repeat:attached"]);
    // The neurons were charged to the lease's visitor and the world.
    expect(deps.logs.every((l) => !JSON.stringify(l).includes("Corner Deli"))).toBe(true);
  });

  it("a write-back that fails after the read retries without a second model call", async () => {
    const slot = fakeSlot();
    const job = await receiptJob();
    slot.blobs.set(job.storagePath, TINY_JPEG);
    const ai = fakeAi({ [OCR_MODEL]: ocrReply });
    const deps = jobDeps({ "slot-1": slot }, { ai });
    slot.reply = () => ({ ok: false, code: "INTERNAL", message: "object reset", retryable: true });
    const m1 = message(job, 1);
    await run(deps, "weft-jobs", m1);
    expect(m1.retried).toEqual([{ delaySeconds: 5 }]);
    expect(m1.acked).toBe(0);
    expect(deps.db.rows("jobs")).toMatchObject([{ state: "read" }]);
    slot.reply = () => ({ ok: true, status: "attached", reason: null });
    const m2 = message(job, 2);
    await run(deps, "weft-jobs", m2);
    expect(m2.acked).toBe(1);
    expect(ai.calls).toHaveLength(1);
    expect(slot.writeBacks).toHaveLength(2);
    expect(deps.db.rows("jobs")).toMatchObject([{ state: "done", result_json: null }]);
  });

  it("names the job's generation in the write-back, and finishes as stale when the world refuses it (a reset moved on)", async () => {
    const slot = fakeSlot();
    const job = await receiptJob();
    slot.blobs.set(job.storagePath, TINY_JPEG);
    const deps = jobDeps({ "slot-1": slot }, { ai: fakeAi({ [OCR_MODEL]: ocrReply }) });
    // The world was at generation 3 when the job started and is at 4 by the write-back (the OCR read took a while).
    slot.reply = () => ({ ok: false, code: STALE_GENERATION, message: "a job of generation 3 for generation 4", retryable: false });
    const m = message(job);
    await run(deps, "weft-jobs", m);
    expect(slot.gens).toEqual([3]);
    expect(m.acked).toBe(1);
    expect(m.retried).toEqual([]);
    expect(deps.db.rows("jobs")).toMatchObject([{ job_id: "obx_0001", state: "done", outcome: "stale" }]);
    expect(deps.db.rows("failed_jobs")).toEqual([]);
  });

  it("an unreadable or unsupported upload writes back a null extract; the kill flag skips it", async () => {
    const slot = fakeSlot();
    const pdfBytes = new TextEncoder().encode("%PDF-1.7 a scanned receipt");
    const pdfJob = await receiptJob({ jobId: "obx_pdf", sha256: await sha256Hex(pdfBytes), storagePath: `blob:${await sha256Hex(pdfBytes)}` });
    slot.blobs.set(pdfJob.storagePath, pdfBytes);
    const deps = jobDeps({ "slot-1": slot }, { ai: fakeAi({ [OCR_MODEL]: ocrReply }) });
    await run(deps, "weft-jobs", message(pdfJob));
    expect(slot.writeBacks[0]!.args).toMatchObject({ job_id: "obx_pdf", extract: null, neurons: 0 });
    expect(deps.db.rows("jobs")[0]).toMatchObject({ outcome: "attached:OCR_UNSUPPORTED" });

    const off = jobDeps({ "slot-1": slot }, { flags: async () => ({ ...FLAGS_ON, ocr: false }) });
    const job = await receiptJob({ jobId: "obx_off" });
    slot.blobs.set(job.storagePath, TINY_JPEG);
    const m = message(job);
    await run(off, "weft-jobs", m);
    expect(m.acked).toBe(1);
    expect(off.db.rows("jobs")[0]).toMatchObject({ outcome: "skipped:OCR_DISABLED" });
    expect(slot.writeBacks).toHaveLength(1);
  });

  it("drops a job for an older generation, and records bad input, a missing blob or a refused write-back as failed", async () => {
    const slot = fakeSlot({ gen: 4 });
    const deps = jobDeps({ "slot-1": slot }, { ai: fakeAi({ [OCR_MODEL]: ocrReply }) });
    const stale = message(await receiptJob());
    await run(deps, "weft-jobs", stale);
    expect(stale.acked).toBe(1);
    expect(deps.db.rows("jobs")[0]).toMatchObject({ state: "done", outcome: "stale" });

    slot.world.gen = 3;
    const missing = message(await receiptJob({ jobId: "obx_missing" }));
    const invalid = message({ v: 1, kind: "ocr.receipt", jobId: "obx_bad", slot: "slot-1", gen: 3 }, 1, "msg_bad");
    await run(deps, "weft-jobs", missing, invalid);
    expect(missing.acked + invalid.acked).toBe(2);
    const failed = Object.fromEntries(deps.db.rows("failed_jobs").map((r) => [r.job_id, r.code]));
    expect(failed).toEqual({ obx_missing: "BLOB_MISSING", obx_bad: "JOB_INVALID" });

    const job = await receiptJob({ jobId: "obx_refused" });
    slot.blobs.set(job.storagePath, TINY_JPEG);
    slot.reply = () => ({ ok: false, code: "DOMAIN_NOT_FOUND", message: "No expense exp_0201 in this company", retryable: false });
    const refused = message(job);
    await run(deps, "weft-jobs", refused);
    expect(refused.acked).toBe(1);
    expect(deps.db.rows("failed_jobs").find((r) => r.job_id === "obx_refused")).toMatchObject({ code: "WRITE_BACK_REFUSED" });
    expect(deps.metrics.points.filter((p) => p.name === "job.dead")).toHaveLength(3);
  });

  it("a notice scan writes back through notices.attach_scan_extract", async () => {
    const slot = fakeSlot();
    const sha = await sha256Hex(TINY_JPEG);
    slot.blobs.set(`blob:${sha}`, TINY_JPEG);
    // No usage in the reply: the read settles at its worst case, a 2,500-token reply included.
    const ai = fakeAi({ [OCR_MODEL]: () => ({ response: JSON.stringify({ formCode: "DE 2088", period: "2026", effectiveFrom: "2027-01-01", accountNumber: "123-4567-8", confidence: 0.9, text: "Rate notice" }) }) });
    const deps = jobDeps({ "slot-1": slot }, { ai });
    await run(deps, "weft-jobs", message({ v: 1, kind: "ocr.notice", jobId: "obx_n1", slot: "slot-1", gen: 3, uploadId: "upl_0009", noticeId: "ntc_0011", sha256: sha, storagePath: `blob:${sha}`, contentType: "image/jpeg" }));
    expect(slot.writeBacks).toEqual([{ command: "notices.attach_scan_extract", args: { job_id: "obx_n1", notice_id: "ntc_0011", upload_id: "upl_0009", extract: { formCode: "DE 2088", period: "2026", effectiveFrom: "2027-01-01", accountNumber: "123-4567-8", confidence: 0.9, text: "Rate notice" }, model: OCR_MODEL, neurons: 162 } }]);
  });

  it("a read the OCR share refuses retries briefly, then waits for the next UTC day, when the cron sends it again", async () => {
    const slot = fakeSlot();
    const job = await receiptJob({ jobId: "obx_budget" });
    slot.blobs.set(job.storagePath, TINY_JPEG);
    const ai = fakeAi({ [OCR_MODEL]: ocrReply });
    let now = new Date("2026-10-26T15:30:00Z");
    const spent = memoryNeuronBudget({ agent: 4000, ocr: 20, embeddings: 200, dictation: 300 });
    const deps = jobDeps({ "slot-1": slot }, { ai, neurons: spent, now: () => now });
    // The first deliveries retry shortly: an open reservation may settle in seconds.
    for (let a = 1; a < BUDGET_RETRIES; a++) {
      const m = message(job, a);
      await run(deps, "weft-jobs", m);
      expect(m.retried).toEqual([{ delaySeconds: retryDelaySeconds(a) }]);
    }
    const parked = message(job, BUDGET_RETRIES);
    await run(deps, "weft-jobs", parked);
    expect(parked.acked).toBe(1);
    expect(deps.db.rows("jobs")).toMatchObject([{ job_id: "obx_budget", state: "deferred", outcome: "deferred:OCR_BUDGET", not_before: "2026-10-27T00:01:00.000Z" }]);
    expect(ai.calls).toHaveLength(0);
    expect(deps.db.rows("failed_jobs")).toHaveLength(0);
    // A redelivery before then does nothing, and the cron sends nothing yet.
    const early = message(job, 1);
    await run(deps, "weft-jobs", early);
    expect(early.acked).toBe(1);
    expect(deps.metrics.points.at(-1)!.tags!.outcome).toBe("repeat:deferred");
    const sent: HostedJob[] = [];
    const queue = { async send(b: HostedJob) { sent.push(b); } };
    expect(await extrasCron({ OPS: deps.db, JOBS: queue, RENDER: queue }, now, () => {})).toEqual({ requeued: 0, pruned: false });
    // After 00:00 UTC the share is new: the cron sends the job again once, and it reads and writes back.
    now = new Date("2026-10-27T00:05:00Z");
    expect(await extrasCron({ OPS: deps.db, JOBS: queue, RENDER: queue }, now, () => {})).toEqual({ requeued: 1, pruned: true });
    expect(await extrasCron({ OPS: deps.db, JOBS: queue, RENDER: queue }, now, () => {})).toMatchObject({ requeued: 0 });
    expect(sent).toEqual([job]);
    expect(deps.db.rows("jobs")[0]).toMatchObject({ state: "requeued" });
    const fresh = jobDeps({ "slot-1": slot }, { db: deps.db, ai, now: () => now });
    const again = message(sent[0], 1);
    await run(fresh, "weft-jobs", again);
    expect(again.acked).toBe(1);
    expect(ai.calls).toHaveLength(1);
    expect(slot.writeBacks).toHaveLength(1);
    expect(fresh.db.rows("jobs")[0]).toMatchObject({ state: "done", outcome: "attached", result_json: null, not_before: null });
  });

  it("a requeued job whose send was lost is sent again an hour later, and a done job never is", async () => {
    const deps = jobDeps({});
    const job = await receiptJob({ jobId: "obx_lost" });
    const t0 = new Date("2026-10-27T00:15:00Z");
    const ledger = d1JobLedger(deps.db, () => t0);
    await ledger.defer(job, "2026-10-27T00:01:00.000Z", "deferred:OCR_BUDGET");
    await ledger.requeued(job.jobId);
    expect(await ledger.due(new Date("2026-10-27T00:45:00Z"), 10)).toEqual([]);
    expect(await ledger.due(new Date("2026-10-27T01:16:00Z"), 10)).toEqual([job]);
    await ledger.done(job.jobId, job.kind, "attached");
    await ledger.defer(job, "2026-10-27T00:01:00.000Z", "deferred:OCR_BUDGET");
    expect(await ledger.due(new Date("2026-10-28T00:00:00Z"), 10)).toEqual([]);
    expect(deps.db.rows("jobs")[0]).toMatchObject({ state: "done" });
  });

  it("retries a transient model failure with backoff", async () => {
    const slot = fakeSlot();
    const job = await receiptJob();
    slot.blobs.set(job.storagePath, TINY_JPEG);
    const deps = jobDeps({ "slot-1": slot }, { ai: fakeAi({ [OCR_MODEL]: () => { throw new Error("3040: capacity"); } }) });
    const m = message(job, 3);
    await run(deps, "weft-jobs", m);
    expect(m.retried).toEqual([{ delaySeconds: 20 }]);
    expect(deps.db.rows("jobs")).toHaveLength(0);
    expect([retryDelaySeconds(1), retryDelaySeconds(2), retryDelaySeconds(9)]).toEqual([5, 10, 300]);
  });
});

describe("embedding, export and render jobs", () => {
  const C = "c".repeat(40);
  it("a memory read that fails retries instead of finishing empty, and a note's own frontmatter decides its trust", async () => {
    const slot = fakeSlot();
    const vectors = fakeVectorize();
    const ai = fakeAi({ [EMBEDDING_MODEL]: embeddingHandler });
    const deps = jobDeps({ "slot-1": slot }, { ai, vectors });
    const job = { v: 1, kind: "embed.memory", jobId: "obx_e9", slot: "slot-1", gen: 3, namespace: "slot-1", notes: [{ path: "knowledge/facts/b.md", commit: C, tainted: false, kind: "knowledge" }] };
    const read = slot.extrasMemoryText;
    slot.extrasMemoryText = async () => { throw new Error("the object is resetting"); };
    const m1 = message(job, 1);
    await run(deps, "weft-jobs", m1);
    expect(m1.retried).toHaveLength(1);
    expect(deps.db.rows("jobs")).toHaveLength(0);
    slot.extrasMemoryText = read;
    slot.memory.set(`${C}:knowledge/facts/b.md`, "---\nid: \"b\"\ntainted_by: \"notice:ntc_0001\"\n---\n# Vendor claim\n\nThe vendor says payday moved.\n");
    await run(deps, "weft-jobs", message(job, 2));
    expect([...vectors.vectors.values()][0]!.metadata).toMatchObject({ path: "knowledge/facts/b.md", tainted: true });
  });

  it("embeds into the slot's own namespace with deterministic ids, records them for the reset, and repeats nothing", async () => {
    const slot = fakeSlot();
    slot.memory.set(`${C}:knowledge/facts/a.md`, "---\nid: \"a\"\n---\n# Payday rule\n\nPayday moves earlier before a bank holiday.\n");
    const vectors = fakeVectorize();
    const ai = fakeAi({ [EMBEDDING_MODEL]: embeddingHandler });
    const recorded: unknown[][] = [];
    const deps = jobDeps({ "slot-1": slot }, { ai, vectors, recordVectorIds: async (...a) => { recorded.push(a); } });
    const job = { v: 1, kind: "embed.memory", jobId: "obx_e1", slot: "slot-1", gen: 3, namespace: "slot-1", notes: [{ path: "knowledge/facts/a.md", commit: C, tainted: false, kind: "knowledge" }, { path: "knowledge/facts/gone.md", commit: C, tainted: false, kind: "knowledge" }] };
    await run(deps, "weft-jobs", message(job), message(job));
    expect(ai.calls).toHaveLength(1);
    expect(vectors.vectors.size).toBe(1);
    expect([...vectors.vectors.values()][0]).toMatchObject({ namespace: "slot-1", metadata: { path: "knowledge/facts/a.md", commit: C, gen: 3, tainted: false, kind: "knowledge" } });
    expect(recorded).toEqual([["slot-1", 3, [...vectors.vectors.keys()]]]);
    // A slot can never write into the shared seed namespace, and nothing is embedded while recall is off.
    const seedJob = message({ ...job, jobId: "obx_e2", namespace: "seed-snap1" });
    await run(deps, "weft-jobs", seedJob);
    expect(deps.db.rows("failed_jobs")).toMatchObject([{ job_id: "obx_e2", code: "JOB_INVALID" }]);
    const off = jobDeps({ "slot-1": slot }, { ai, vectors, flags: async () => ({ ...FLAGS_ON, recallSemantic: false }) });
    await run(off, "weft-jobs", message({ ...job, jobId: "obx_e3" }));
    expect(off.db.rows("jobs")[0]).toMatchObject({ outcome: "skipped:RECALL_OFF" });
    expect(ai.calls).toHaveLength(1);
  });

  it("stores an export once under its world, generation and job", async () => {
    const slot = fakeSlot();
    const files = memoryR2();
    const deps = jobDeps({ "slot-1": slot }, { files });
    const job = { v: 1, kind: "export.world", jobId: "obx_x1", slot: "slot-1", gen: 3, what: "memory", requestedBy: "usr_dana" };
    await run(deps, "weft-jobs", message(job));
    await deps.ledger.done("obx_x1", "export.world", "stored");
    await run(jobDeps({ "slot-1": slot }, { files }), "weft-jobs", message(job));
    const key = exportObjectKey({ slot: "slot-1", gen: 3, jobId: "obx_x1", what: "memory" });
    expect(key).toBe("exports/slot-1/g3/memory-obx_x1.fast-import");
    expect(files.puts).toBe(1);
    expect(files.objects.get(key)!.meta).toEqual({ slot: "slot-1", gen: "3", what: "memory", requestedBy: "usr_dana" });
    expect(slot.gens).toEqual([3]);
  });

  it("finishes an export as stale, with no retry and no file stored, when the world refuses its generation", async () => {
    const slot = fakeSlot();
    const files = memoryR2();
    const deps = jobDeps({ "slot-1": slot }, { files });
    // A reset moved the world on after the job's generation was checked: CompanyDO answers its stale outcome.
    slot.extrasExport = async (_what, gen) => { slot.gens.push(gen); return { ok: false, code: STALE_GENERATION, message: "a job of generation 3 for generation 4", retryable: false }; };
    const m = message({ v: 1, kind: "export.world", jobId: "obx_x2", slot: "slot-1", gen: 3, what: "world", requestedBy: "usr_dana" });
    await run(deps, "weft-jobs", m);
    expect(m.acked).toBe(1);
    expect(m.retried).toEqual([]);
    expect(files.puts).toBe(0);
    expect(slot.gens).toEqual([3]);
    expect(deps.db.rows("jobs")).toMatchObject([{ job_id: "obx_x2", state: "done", outcome: "stale" }]);
    expect(deps.db.rows("failed_jobs")).toEqual([]);
  });

  it("renders a PDF through a browser that loads nothing, then serves the cached copy on redelivery", async () => {
    const slot = fakeSlot();
    const files = memoryR2();
    const browser = fakeBrowser({ extraRequests: ["http://169.254.169.254/"] });
    const html = renderPdfHtml({ kind: "offer_letter", companyName: "Larkspur Labs (demo)", documentId: "doc_0007", title: "Offer letter", bodyText: "Dear Noor (demo)", sha256: "a".repeat(64), status: "sent", sentAt: null, signature: null });
    const job = { v: 1, kind: "render.pdf", jobId: "obx_p1", slot: "slot-1", gen: 3, pdf: "offer_letter", subjectId: "doc_0007", sha256: await sha256Hex(html), html };
    const deps = jobDeps({ "slot-1": slot }, { files, launch: browser.launch });
    await run(deps, "weft-render", message(job));
    await run(jobDeps({ "slot-1": slot }, { files, launch: browser.launch }), "weft-render", message({ ...job, jobId: "obx_p2" }));
    expect(browser.log.launches).toBe(1);
    expect(browser.log.requests.every((r) => r.aborted && !r.continued)).toBe(true);
    expect(files.objects.has(`w/slot-1/g3/pdf/${job.sha256}.pdf`)).toBe(true);
    expect(deps.db.rows("jobs")[0]).toMatchObject({ outcome: "rendered" });
    const tampered = message({ ...job, jobId: "obx_p3", sha256: "f".repeat(64) });
    await run(deps, "weft-render", tampered);
    expect(deps.db.rows("failed_jobs")).toMatchObject([{ job_id: "obx_p3", code: "PDF_KEY_MISMATCH" }]);
    // A render that failed for good leaves the marker the PDF route answers with.
    const marker = files.objects.get(pdfFailureKey(pdfObjectKey({ scope: "world", slot: "slot-1", gen: 3, sha256: "f".repeat(64) })))!;
    expect(marker.meta).toMatchObject({ code: "PDF_KEY_MISMATCH" });
    expect(JSON.parse(new TextDecoder().decode(marker.bytes))).toMatchObject({ code: "PDF_KEY_MISMATCH", jobId: "obx_p3" });
  });
});

describe("dead letters", () => {
  it("records each in failed_jobs once, keyed by job id", async () => {
    const deps = jobDeps({});
    const body = await receiptJob({ jobId: "obx_dead" });
    await run(deps, "weft-dlq", message(body, 6), message(body, 6), message("not json", 6, "msg_x"));
    expect(deps.db.rows("failed_jobs").map((r) => [r.job_id, r.code, r.queue, r.attempts])).toEqual([["obx_dead", "DEAD_LETTER", "weft-dlq", 6], ["msg:msg_x", "DEAD_LETTER", "weft-dlq", 6]]);
  });

  it("a render that ran out of retries marks its PDF key as failed", async () => {
    const files = memoryR2();
    const deps = jobDeps({}, { files });
    const html = "<!doctype html><p>stub</p>";
    const job = { v: 1, kind: "render.pdf", jobId: "obx_pdead", slot: "slot-1", gen: 3, pdf: "pay_stub", subjectId: "pyc_0001", sha256: await sha256Hex(html), html };
    await run(deps, "weft-dlq", message(job, 6));
    expect(files.objects.get(pdfFailureKey(pdfObjectKey({ scope: "world", slot: "slot-1", gen: 3, sha256: job.sha256 })))!.meta).toMatchObject({ code: "DEAD_LETTER" });
  });
});
