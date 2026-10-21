// The hidden write-back commands for OCR (design 5.4), as the queue side sees them. Their one definition is the
// executor's (packages/executor/src/hosted/commands.ts): the durable platform registers them through extraCommands,
// so Node's registry and its count assertions are unchanged, and svc_jobs may run exactly these two. They are system
// only, never on an agent surface, never exposed over MCP and on no other allowlist. A repeat of the same job, a
// replaced receipt, an extract from another source or a notice upload that no longer matches is refused before
// anything is written (no second action row), and writeBackOutcome (./port.ts) settles those refusals as "already"
// or "skipped"; a scan that arrives before the upload was read is refused as DOMAIN_NOT_READ_YET and retried.
import type { WeftCommand } from "@weft/core";
import { attachReceiptExtract, attachScanExtract, hostedServiceCommands, JOBS_ALLOWLIST, NOT_READ_YET } from "@weft/executor";

export type { StoredNoticeScan, StoredReceiptExtract, WriteBackStatus } from "@weft/executor";

export const attachReceiptExtractCmd = attachReceiptExtract;
export const attachScanExtractCmd = attachScanExtract;
/** The commands the durable platform registers as extraCommands (cf2's durablePlatform adds them for every world). */
export const EXTRAS_COMMANDS: readonly WeftCommand[] = hostedServiceCommands();
/** The `svc_jobs` allowlist: exactly the hidden write-backs, both R1 system records. */
export const SVC_JOBS_ALLOWLIST: readonly string[] = JOBS_ALLOWLIST;
/** Refusal codes a queue handler retries instead of recording as failed. */
export const RETRYABLE_WRITE_BACK_CODES: ReadonlySet<string> = new Set([NOT_READ_YET, "LEASE_HELD", "INTERNAL"]);
