// The Durable Object side of the extras (track cf6-extras), loaded inside CompanyDO after @weft/* is imported: the
// hidden OCR write-back commands (extraCommands and the svc_jobs allowlist), the slot port behind CompanyDO's
// extras RPC methods, the PDF route, the outbox mapping and the run catalog source. The semantic recall hook lives in
// apps/api/src/memory (attachSemanticRecall).
export { attachReceiptExtractCmd, attachScanExtractCmd, EXTRAS_COMMANDS, RETRYABLE_WRITE_BACK_CODES, SVC_JOBS_ALLOWLIST, type StoredReceiptExtract, type WriteBackStatus } from "./commands";
export { createSlotExtras, SVC_JOBS, WORLD_EXPORT_SKIP, worldExportJson, writeBackOutcome, type SlotExtrasDeps } from "./port";
export { handleHostedPdf, parsePdfPath, pdfDataFor, type PdfRouteDeps } from "./pdf-route";
export { extrasOutboxJobs, OUTBOX_COMMANDS, type CommittedCall, type OutboxJobOptions } from "./outbox";
export { catalogRowFor, runNeurons } from "./catalog";
