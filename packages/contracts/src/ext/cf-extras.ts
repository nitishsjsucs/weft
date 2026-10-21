// Weft on Cloudflare, round 0 contract (track cf0-contracts; docs/cloudflare/design.md 4.1, 5.4, 7.1 and 10).
// Additive only. The visitor-facing extras, all off the harness path and each behind a KV flag: receipt and notice
// OCR, PDF rendering, semantic recall candidates, Help search, dictation, the run catalog and the metrics sink; the
// after-commit job messages that reach them through the outbox and Queues; and the hidden write-back commands.
// Implemented by cf6-extras (packages/cf-extras, apps/cf/src/extras); queue dispatch by cf4-worker; the outbox
// writer and the write-back commands by cf2-platform. Types, constants and pure helpers only.
import type { HostedProviderId } from "./cf-agent";
import type { DegradationLevel } from "./cf-hosted";

// Models --------------------------------------------------------------------------------------------------------

export const OCR_MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";
export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBEDDING_DIMS = 768;
export const DICTATION_MODEL = "@cf/openai/whisper-large-v3-turbo";
/** Needs a license agreement accepted on the account; never used. */
export const EXCLUDED_MODELS: readonly string[] = ["@cf/meta/llama-3.2-11b-vision-instruct"];
export const DICTATION_MAX_SECONDS = 30;
/** Receipt photos are normalized with the Images binding before OCR. */
export const OCR_MAX_EDGE_PX = 1024;

// Jobs ----------------------------------------------------------------------------------------------------------

/**
 * After-commit jobs (design 3.4). A command that needs OCR, an embedding, an export or a PDF appends an `outbox` row
 * (id, kind, body = JSON of the job, created_at) inside its own transaction; after the outer commit the slot sends
 * the job to its queue and deletes the row. Consumers do the I/O and write back through a hidden service command.
 * Every handler is idempotent on redelivery, keyed by `jobId` (the outbox row id). Bodies stay under 128 KB.
 */
export type HostedJob =
  | { v: 1; kind: "ocr.receipt"; jobId: string; slot: string; gen: number; uploadId: string; expenseId: string; sha256: string; storagePath: string; contentType: string }
  | { v: 1; kind: "ocr.notice"; jobId: string; slot: string; gen: number; uploadId: string; noticeId: string; sha256: string; storagePath: string; contentType: string }
  | { v: 1; kind: "embed.memory"; jobId: string; slot: string; gen: number; namespace: string; notes: { path: string; commit: string; tainted: boolean; kind: string }[] }
  | { v: 1; kind: "export.world"; jobId: string; slot: string; gen: number; what: "memory" | "world"; requestedBy: string }
  | { v: 1; kind: "render.pdf"; jobId: string; slot: string; gen: number; pdf: PdfKind; subjectId: string; sha256: string; html: string };
export type HostedJobKind = HostedJob["kind"];
/** Queue names (design 9.1). PDF rendering has its own queue at concurrency 1. */
export const QUEUES = { jobs: "weft-jobs", render: "weft-render", dead: "weft-dlq" } as const;
export const queueFor = (kind: HostedJobKind): string => (kind === "render.pdf" ? QUEUES.render : QUEUES.jobs);

/**
 * Hidden service commands, registered only on the durable platform through the executor's `extraCommands` option
 * (Node's registry and its count assertions stay unchanged). Never exposed over MCP and on no allowlist. Their
 * extract fields are untrusted: a run that reads them is tainted.
 */
export const HIDDEN_SERVICE_COMMANDS = { receiptExtract: "expenses.attach_receipt_extract", noticeExtract: "notices.attach_scan_extract" } as const;
export interface AttachReceiptExtractArgs { job_id: string; expense_id: string; upload_id: string; extract: ReceiptOcrExtract | null; model: string; neurons: number }
export interface AttachScanExtractArgs { job_id: string; notice_id: string; upload_id: string; extract: NoticeScanExtract | null; model: string; neurons: number }

// OCR -----------------------------------------------------------------------------------------------------------

export interface OcrInput { bytes: Uint8Array; contentType: string; sha256: string }
/** Read from a receipt image. The write-back maps it onto the expense's existing receipt extract
 * ({ totalCents, date, merchant }) and keeps the rest beside it. */
export interface ReceiptOcrExtract { merchant: string | null; date: string | null; totalCents: number | null; currency: string | null; confidence: number }
/** Read from an uploaded notice: the fields the compliance plan reads (w4-parity-compliance NoticePlan input) plus the text. */
export interface NoticeScanExtract { formCode: string | null; period: string | null; effectiveFrom: string | null; accountNumber: string | null; confidence: number; text: string }
export type OcrResult<T> =
  | { ok: true; extract: T; model: string; neurons: number }
  | { ok: false; code: "OCR_DISABLED" | "OCR_BUDGET" | "OCR_UNSUPPORTED" | "OCR_UNREADABLE"; message: string };
export interface ReceiptOcr { read(input: OcrInput): Promise<OcrResult<ReceiptOcrExtract>> }
export interface NoticeOcr { read(input: OcrInput): Promise<OcrResult<NoticeScanExtract>> }

// PDF -----------------------------------------------------------------------------------------------------------

export type PdfKind = "offer_letter" | "signed_agreement" | "pay_stub";
/** Where a rendered PDF lives in R2 `weft-files`: per world and generation, or shared for the seeded world. */
export type PdfKey = { scope: "world"; slot: string; gen: number; sha256: string } | { scope: "seed"; snapshot: string; sha256: string };
/** R2 prefixes; `w/` and `exports/` expire after 3 days (lifecycle rules). */
export const R2_PREFIXES = { world: "w/", seed: "seed/", exports: "exports/", help: "help/" } as const;
export function pdfObjectKey(k: PdfKey): string {
  return k.scope === "world" ? `w/${k.slot}/g${k.gen}/pdf/${k.sha256}.pdf` : `seed/${k.snapshot}/pdf/${k.sha256}.pdf`;
}
export interface RenderInput { kind: PdfKind; html: string; key: PdfKey }
export interface RenderResult { objectKey: string; bytes: number; cached: boolean; browserMs: number }
/** Weft HTML templates with escaped text, loaded with `page.setContent`; JavaScript off and every request aborted. */
export interface DocumentRenderer { render(input: RenderInput): Promise<RenderResult> }
/** Browser seconds Weft may use per UTC day (half of the 10 browser-minutes). */
export const BROWSER_SECONDS_PER_DAY = 300;

// Recall --------------------------------------------------------------------------------------------------------

/** Vectorize `weft-memory` metadata; indexes on gen, tainted and kind exist before the first upsert. */
export interface MemoryVectorMetadata { path: string; commit: string; gen: number; tainted: boolean; kind: string }
export const VECTOR_METADATA_INDEXES = ["gen", "tainted", "kind"] as const;
/** Namespaces: one shared by all worlds per snapshot, one per slot for notes written after a reset. */
export const seedNamespace = (snapshot: string): string => `seed-${snapshot}`;
export interface RecallQuery { text: string; slot: string; gen: number; snapshot: string; k: number; trustedOnly: boolean }
export interface RecallCandidate { path: string; commit: string; score: number; tainted: boolean; kind: string; namespace: string }
/**
 * Semantic candidates for the memory recall block, off by default (WEFT_SEMANTIC_RECALL=0, KV recall.semantic).
 * The hook re-reads each candidate from the slot's MemoryRepo at HEAD and keeps it only if its path and commit still
 * match, so citations stay path#L<line> at a real commit. memory.search stays a fixed-strings grep.
 */
export interface RecallSource { candidates(q: RecallQuery): Promise<RecallCandidate[]> }

// Help and dictation --------------------------------------------------------------------------------------------

export interface HelpHit { title: string; path: string; snippet: string; score: number }
export type HelpSearchResult =
  | { ok: true; hits: HelpHit[]; leftToday: number }
  | { ok: false; code: "HELP_DISABLED" | "HELP_DAILY_CAP"; message: string };
/** AI Search `weft-help` over R2 `help/`, capped at HOSTED_SETTINGS.helpQueriesPerDay. */
export interface HelpSearch { search(query: string): Promise<HelpSearchResult> }

export type DictationResult =
  | { ok: true; text: string; seconds: number; neurons: number }
  | { ok: false; code: "DICTATION_DISABLED" | "DICTATION_BUDGET" | "DICTATION_TOO_LONG" | "DICTATION_UNREADABLE"; message: string };
/** The text fills the composer and is never sent on its own. */
export interface Dictation { transcribe(input: { audio: Uint8Array; contentType: string }): Promise<DictationResult> }

// Run catalog, Platform page and metrics ------------------------------------------------------------------------

/** One hosted run outcome in D1 `weft-ops` (aggregates only ever reach visitors, never content). */
export interface RunCatalogRow {
  runId: string; slot: string; gen: number; provider: HostedProviderId; model: string; trigger: string;
  steps: number; grounded: boolean | null; costUsdMicros: number; neurons: number; latencyMs: number;
  status: string; terminalReason: string | null; endedAt: string;
}
export interface ModelComparisonRow {
  provider: HostedProviderId; model: string; runs: number; avgSteps: number; groundedRate: number | null;
  avgCostUsdMicros: number; avgNeurons: number; p50LatencyMs: number; outcomes: Record<string, number>;
}
export interface RunCatalog {
  record(row: RunCatalogRow): Promise<void>;
  compare(opts?: { days?: number }): Promise<ModelComparisonRow[]>;
}

/** The in-app Platform page: today's dollars against the caps, neurons, restores left, leases, dead letters and the
 * degradation level. */
export interface PlatformReadout {
  day: string;
  level: DegradationLevel;
  dollars: { spentUsd: number; dayCapUsd: number; runCapUsd: number };
  neurons: { used: number; cap: number };
  restoresLeft: number;
  leases: { active: number; pool: number; waitlist: number };
  deadLetters: number;
  lastSweepAt: string | null;
  /** Each daily share against its use, for the shares the Lobby tracks (DO rows written and read, DO and Worker requests). */
  shares: Record<string, { used: number; share: number }>;
}

export type MetricName = "run.started" | "run.ended" | "lease.started" | "lease.ended" | "reset.delta" | "reset.full" | "job.done" | "job.dead";
export interface MetricPoint { name: MetricName; value: number; slot?: string; visitor?: string; tags?: Record<string, string> }
/** D1 now; Analytics Engine once Nitish enables it (it stays undeclared until then). */
export interface MetricsSink { emit(point: MetricPoint): void }
