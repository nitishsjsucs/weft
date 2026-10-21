// The hidden service commands of the hosted extras (docs/cloudflare/design.md 5.4): the OCR consumers write an
// extract back into the slot through these, as the system principal svc_jobs. This file is their only definition
// (cf2-platform and cf6-extras each wrote one; the integration kept one, here, where the executor's other writes
// live): they are registered only on the durable platform, through the executor's extraCommands option, so Node's
// registry and its count assertions are unchanged, and apps/cf/src/extras/slot re-exports them for the queue side.
// system_only (never an agent tool, never on MCP, on no allowlist but svc_jobs's), R1 system records with no
// approval. They only attach what was read: they never classify a notice, decide an expense or start a run.
//
// Each is idempotent on redelivery without writing: a repeat of the same job, a receipt replaced since the job was
// queued, an extract from another source and a notice upload that no longer matches are refused (DOMAIN_* codes)
// before anything is written, so the action log gains no second row; the consumer settles those refusals as
// "already" or "skipped" (apps/cf/src/extras/slot/port.ts writeBackOutcome). A scan that arrives before
// notices.ingest_upload read the upload is refused as DOMAIN_NOT_READ_YET, which the consumer retries.
//
// The receipt extract lands in `expenses.receipt_extract_json`, which expenses.list and expenses.get already mark
// untrusted (`expenses.*.receipt_extract`), so a run that reads it is tainted; the policy checks rerun while the claim
// awaits review, so a total or date that disagrees with it shows as RECEIPT_MISMATCH. The notice scan is kept beside
// the parser's extract (`extracted_json.scan`, which parseExtract strips, so no notice read surfaces it) and its text
// becomes the body of an uploaded notice that had none, which notices.get marks untrusted (`notice.body`).
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { DomainRefusal, expenses as expensesCore, notFound, writeCommand, type WeftCommand } from "@weft/core";
import { expenses, notices } from "@weft/db";
import { HIDDEN_SERVICE_COMMANDS, type AttachReceiptExtractArgs, type AttachScanExtractArgs } from "../../../contracts/src/ext/cf-extras";
import type { HostedSystemPrincipal } from "../../../contracts/src/ext/cf-platform";

/** The system principal the queue write-backs run as. */
export const JOBS_PRINCIPAL: HostedSystemPrincipal = "svc_jobs";
/** svc_jobs's exact allowlist: the two write-backs and nothing else. */
export const JOBS_ALLOWLIST: readonly string[] = [HIDDEN_SERVICE_COMMANDS.receiptExtract, HIDDEN_SERVICE_COMMANDS.noticeExtract];
/** At most this much scan text is kept on a notice (the notice body shown to people and, wrapped, to runs). */
export const MAX_SCAN_TEXT = 8_000;
/** The refusal a scan gets before notices.ingest_upload has read its upload; the consumer retries it. */
export const NOT_READ_YET = "DOMAIN_NOT_READ_YET" as const;

const JobId = z.string().min(1).max(64);
const Model = z.string().min(1).max(80);
const Neurons = z.number().min(0).max(10_000);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// The pipeline maps null to a missing key before parsing (nullToUndefined), so every nullable field is nullish here
// and run() reads it back as null.
const ReceiptExtract = z.object({
  merchant: z.string().max(80).nullish(), date: IsoDate.nullish(), totalCents: z.number().int().min(0).max(100_000_000).nullish(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullish(), confidence: z.number().min(0).max(1),
}).strict();
const NoticeScan = z.object({
  formCode: z.string().max(40).nullish(), period: z.string().max(7).nullish(), effectiveFrom: IsoDate.nullish(), accountNumber: z.string().max(30).nullish(),
  confidence: z.number().min(0).max(1), text: z.string().max(MAX_SCAN_TEXT),
}).strict();

const ReceiptInput = z.object({ job_id: JobId, expense_id: z.string().startsWith("exp_"), upload_id: z.string().startsWith("upl_"), extract: ReceiptExtract.nullish(), model: Model, neurons: Neurons }).strict();
const ScanInput = z.object({ job_id: JobId, notice_id: z.string().startsWith("ntc_"), upload_id: z.string().startsWith("upl_"), extract: NoticeScan.nullish(), model: Model, neurons: Neurons }).strict();

/** What an applied write-back reports in `data.status` (a repeat or a stale job is a refusal instead). */
export type WriteBackStatus = "attached";

/** The stored receipt extract: the shape the expense policy reads, plus where it came from. */
export interface StoredReceiptExtract { totalCents: number | null; date: string | null; merchant: string | null; currency: string | null; confidence: number; source: "ocr"; model: string; ocrJobId: string; read: boolean }
/** The stored notice scan, under `extracted_json.scan`. */
export interface StoredNoticeScan { source: "ocr"; jobId: string; model: string; read: boolean; formCode: string | null; period: string | null; effectiveFrom: string | null; accountNumber: string | null; confidence: number }

const parse = (json: string | null): Record<string, unknown> | null => {
  if (!json) return null;
  try { const v = JSON.parse(json) as unknown; return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; }
};
const refuse = (code: `DOMAIN_${string}`, message: string) => new DomainRefusal(code, message, null, null);

export const attachReceiptExtract: WeftCommand<AttachReceiptExtractArgs> = writeCommand<AttachReceiptExtractArgs>({
  name: HIDDEN_SERVICE_COMMANDS.receiptExtract,
  summary: "System: attach the fields read from an expense's uploaded receipt.",
  description: "Hosted only (svc_jobs, after the OCR job): stores the merchant, date, total, currency and confidence read from the expense's receipt upload as its receipt extract and reruns the policy checks. Refused when this job already ran, the receipt was replaced or another source filled the extract. The extract is untrusted.",
  input: ReceiptInput as z.ZodType<AttachReceiptExtractArgs>, domain: "payroll", needs: "edit", effect: "write", risk: () => "R1", approval: "never", access: "system_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const r = await expensesCore.getExpenseRow(deps.tx, ctx.companyId, i.expense_id);
    if (!r) throw notFound("expense", i.expense_id);
    if (r.receiptUploadId !== i.upload_id) throw refuse("DOMAIN_STALE_RECEIPT", `${r.id} carries ${r.receiptUploadId ?? "no receipt"} now, not ${i.upload_id}`);
    const prior = parse(r.receiptExtractJson);
    if (prior?.ocrJobId === i.job_id) throw refuse("DOMAIN_ALREADY_APPLIED", `Job ${i.job_id} already wrote the extract of ${r.id}`);
    if (prior && prior.source !== "ocr") throw refuse("DOMAIN_EXTRACT_PRESENT", `${r.id} already has a receipt extract from ${String(prior.source ?? "another source")}`);
    const x = i.extract ?? null;
    const stored: StoredReceiptExtract = {
      totalCents: x?.totalCents ?? null, date: x?.date ?? null, merchant: x?.merchant ?? null, currency: x?.currency ?? null, confidence: x?.confidence ?? 0,
      source: "ocr", model: i.model, ocrJobId: i.job_id, read: x !== null,
    };
    await deps.tx.update(expenses).set({ receiptExtractJson: JSON.stringify(stored) }).where(and(eq(expenses.id, r.id), eq(expenses.companyId, ctx.companyId)));
    // A total or date that disagrees with the claim becomes a RECEIPT_MISMATCH check while the item awaits review.
    if (expensesCore.DECIDABLE.includes(r.status as never)) await expensesCore.writeChecks(deps.tx, (await expensesCore.getExpenseRow(deps.tx, ctx.companyId, r.id))!);
    const reason = x ? null : "unreadable";
    return { data: { expense_id: r.id, upload_id: i.upload_id, status: "attached" satisfies WriteBackStatus, reason }, summary: `Receipt extract for ${r.id}: attached${reason ? ` (${reason})` : ""}` };
  },
});

export const attachScanExtract: WeftCommand<AttachScanExtractArgs> = writeCommand<AttachScanExtractArgs>({
  name: HIDDEN_SERVICE_COMMANDS.noticeExtract,
  summary: "System: attach the fields read from an uploaded notice scan.",
  description: "Hosted only (svc_jobs, after the OCR job): keeps the form code, period, effective date, account number and confidence read from an uploaded notice's scan beside its extract, and its text as the body when it had none. It never classifies or acts on the notice. Refused when this job already ran or the upload changed; the scan text is untrusted.",
  input: ScanInput as z.ZodType<AttachScanExtractArgs>, domain: "tax", needs: "edit", effect: "write", risk: () => "R1", approval: "never", access: "system_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const [n] = await deps.tx.select().from(notices).where(and(eq(notices.companyId, ctx.companyId), eq(notices.id, i.notice_id))).limit(1);
    if (!n) throw notFound("notice", i.notice_id);
    if (n.source !== "upload" || n.uploadId !== i.upload_id) throw refuse("DOMAIN_STALE_UPLOAD", `${n.id} is not the notice uploaded as ${i.upload_id}`);
    // notices.ingest_upload writes the extract first (svc_events on notice.uploaded); the job retries until it has.
    if (n.kind === "unclassified") throw refuse(NOT_READ_YET, `${n.id} has not been read yet; try again shortly`);
    const prior = parse(n.extractedJson);
    const priorScan = prior?.scan as { jobId?: unknown } | undefined;
    if (priorScan?.jobId === i.job_id) throw refuse("DOMAIN_ALREADY_APPLIED", `Job ${i.job_id} already wrote the scan extract of ${n.id}`);
    const x = i.extract ?? null;
    const scan: StoredNoticeScan = {
      source: "ocr", jobId: i.job_id, model: i.model, read: x !== null, formCode: x?.formCode ?? null, period: x?.period ?? null,
      effectiveFrom: x?.effectiveFrom ?? null, accountNumber: x?.accountNumber ?? null, confidence: x?.confidence ?? 0,
    };
    const body = n.bodyText.trim() ? n.bodyText : (x?.text ?? "");
    await deps.tx.update(notices).set({ extractedJson: JSON.stringify({ ...(prior ?? {}), scan }), bodyText: body }).where(and(eq(notices.id, n.id), eq(notices.companyId, ctx.companyId)));
    const reason = x ? null : "unreadable";
    return { data: { notice_id: n.id, upload_id: i.upload_id, status: "attached" satisfies WriteBackStatus, reason, body_filled: body !== n.bodyText }, summary: `Scan extract for ${n.id}: attached${reason ? ` (${reason})` : ""}` };
  },
});

/** The hidden service commands the durable platform registers through extraCommands. */
export function hostedServiceCommands(): WeftCommand[] {
  return [attachReceiptExtract as unknown as WeftCommand, attachScanExtract as unknown as WeftCommand];
}

