// The hidden write-back commands for OCR (design 5.4). Registered only on the durable platform, through the
// executor's `extraCommands` option, so Node's registry and its count assertions are unchanged; system only (the
// `svc_jobs` principal), so they are never on an agent surface, never exposed over MCP and on no allowlist. They run
// inside the slot's executor transaction like any system record (an action row, the hash chain), and they only
// attach what was read: they never classify a notice, decide an expense or start a run.
//
// The receipt extract lands in `expenses.receipt_extract_json`, which expenses.list and expenses.get already mark
// untrusted (`expenses.*.receipt_extract`), so a run that reads it is tainted; the policy checks rerun so a total or
// date that disagrees with the claim shows as RECEIPT_MISMATCH. The notice scan is kept beside the parser's extract
// (`extracted_json.scan`, which the agent's notice reads never surface) and its text becomes the body of an uploaded
// notice that had none, which notices.get marks untrusted (`notice.body`). Track cf6-extras.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { DomainRefusal, expenses as exp, notFound, writeCommand, type WeftCommand } from "@weft/core";
import { expenses, notices } from "@weft/db";
import { HIDDEN_SERVICE_COMMANDS, type AttachReceiptExtractArgs, type AttachScanExtractArgs } from "@weft/cf-extras";

const JobId = z.string().min(1).max(64);
const Model = z.string().min(1).max(80);
const Neurons = z.number().min(0).max(10_000);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const ReceiptExtract = z.object({
  merchant: z.string().max(80).nullable(), date: IsoDate.nullable(), totalCents: z.number().int().min(0).max(100_000_000).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(), confidence: z.number().min(0).max(1),
}).strict();
const NoticeScan = z.object({
  formCode: z.string().max(40).nullable(), period: z.string().max(7).nullable(), effectiveFrom: IsoDate.nullable(), accountNumber: z.string().max(30).nullable(),
  confidence: z.number().min(0).max(1), text: z.string().max(8000),
}).strict();

const ReceiptInput = z.object({ job_id: JobId, expense_id: z.string().startsWith("exp_"), upload_id: z.string().startsWith("upl_"), extract: ReceiptExtract.nullable(), model: Model, neurons: Neurons }).strict();
const ScanInput = z.object({ job_id: JobId, notice_id: z.string().startsWith("ntc_"), upload_id: z.string().startsWith("upl_"), extract: NoticeScan.nullable(), model: Model, neurons: Neurons }).strict();

/** What a write-back reports in `data.status`. */
export type WriteBackStatus = "attached" | "already" | "skipped";

/** The stored receipt extract: the shape the expense policy reads, plus where it came from. */
export interface StoredReceiptExtract { totalCents: number | null; date: string | null; merchant: string | null; currency: string | null; confidence: number; source: "ocr"; model: string; ocrJobId: string; read: boolean }

const parse = (json: string | null): Record<string, unknown> | null => {
  if (!json) return null;
  try { const v = JSON.parse(json) as unknown; return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; }
};

export const attachReceiptExtractCmd: WeftCommand<AttachReceiptExtractArgs> = writeCommand<AttachReceiptExtractArgs>({
  name: HIDDEN_SERVICE_COMMANDS.receiptExtract,
  summary: "System: attach the fields read from an expense's uploaded receipt.",
  description: "Hosted only (svc_jobs, after the OCR job): stores the merchant, date, total, currency and confidence read from the expense's receipt upload as its receipt extract and reruns the policy checks. Idempotent by job id; a replaced receipt or an existing extract is left alone. The extract is untrusted.",
  input: ReceiptInput as z.ZodType<AttachReceiptExtractArgs>, domain: "payroll", needs: "edit", effect: "write", risk: () => "R1", approval: "never", access: "system_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const r = await exp.getExpenseRow(deps.tx, ctx.companyId, i.expense_id);
    if (!r) throw notFound("expense", i.expense_id);
    const done = (status: WriteBackStatus, reason: string | null) => ({ data: { expense_id: r.id, upload_id: i.upload_id, status, reason }, summary: `Receipt extract for ${r.id}: ${status}${reason ? ` (${reason})` : ""}` });
    if (r.receiptUploadId !== i.upload_id) return done("skipped", "receipt_replaced");
    const prior = parse(r.receiptExtractJson);
    if (prior?.ocrJobId === i.job_id) return done("already", null);
    if (prior && prior.source !== "ocr") return done("skipped", "has_extract");
    const x = i.extract;
    const stored: StoredReceiptExtract = {
      totalCents: x?.totalCents ?? null, date: x?.date ?? null, merchant: x?.merchant ?? null, currency: x?.currency ?? null, confidence: x?.confidence ?? 0,
      source: "ocr", model: i.model, ocrJobId: i.job_id, read: x !== null,
    };
    await deps.tx.update(expenses).set({ receiptExtractJson: JSON.stringify(stored) }).where(and(eq(expenses.id, r.id), eq(expenses.companyId, ctx.companyId)));
    // A total or date that disagrees with the claim becomes a RECEIPT_MISMATCH check while the item awaits review.
    if (exp.DECIDABLE.includes(r.status as never)) await exp.writeChecks(deps.tx, (await exp.getExpenseRow(deps.tx, ctx.companyId, r.id))!);
    return done("attached", x ? null : "unreadable");
  },
});

export const attachScanExtractCmd: WeftCommand<AttachScanExtractArgs> = writeCommand<AttachScanExtractArgs>({
  name: HIDDEN_SERVICE_COMMANDS.noticeExtract,
  summary: "System: attach the fields read from an uploaded notice scan.",
  description: "Hosted only (svc_jobs, after the OCR job): keeps the form code, period, effective date, account number and confidence read from an uploaded notice's scan beside its extract, and its text as the body when it had none. It never classifies or acts on the notice. Idempotent by job id; the scan text is untrusted.",
  input: ScanInput as z.ZodType<AttachScanExtractArgs>, domain: "tax", needs: "edit", effect: "write", risk: () => "R1", approval: "never", access: "system_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const [n] = await deps.tx.select().from(notices).where(and(eq(notices.companyId, ctx.companyId), eq(notices.id, i.notice_id))).limit(1);
    if (!n) throw notFound("notice", i.notice_id);
    const done = (status: WriteBackStatus, reason: string | null) => ({ data: { notice_id: n.id, upload_id: i.upload_id, status, reason }, summary: `Scan extract for ${n.id}: ${status}${reason ? ` (${reason})` : ""}` });
    if (n.source !== "upload" || n.uploadId !== i.upload_id) return done("skipped", "upload_mismatch");
    // notices.ingest_upload writes the extract first (svc_events on notice.uploaded); the job retries until it has.
    if (n.kind === "unclassified") throw new DomainRefusal("DOMAIN_NOT_READ_YET", `${n.id} has not been read yet; try again shortly`, null, null);
    const prior = parse(n.extractedJson);
    const priorScan = prior?.scan as { jobId?: unknown } | undefined;
    if (priorScan?.jobId === i.job_id) return done("already", null);
    const x = i.extract;
    const scan = { source: "ocr", jobId: i.job_id, model: i.model, read: x !== null, formCode: x?.formCode ?? null, period: x?.period ?? null, effectiveFrom: x?.effectiveFrom ?? null, accountNumber: x?.accountNumber ?? null, confidence: x?.confidence ?? 0 };
    const body = n.bodyText.trim() ? n.bodyText : (x?.text ?? "");
    await deps.tx.update(notices).set({ extractedJson: JSON.stringify({ ...(prior ?? {}), scan }), bodyText: body }).where(eq(notices.id, n.id));
    return done("attached", x ? null : "unreadable");
  },
});

/** The commands CompanyDO passes as `extraCommands` on the durable platform. */
export const EXTRAS_COMMANDS: readonly WeftCommand[] = [attachReceiptExtractCmd, attachScanExtractCmd];
/** The `svc_jobs` allowlist: exactly the hidden write-backs, both R1 system records. */
export const SVC_JOBS_ALLOWLIST: readonly string[] = EXTRAS_COMMANDS.map((c) => c.name);
/** Refusal codes a queue handler retries instead of recording as failed. */
export const RETRYABLE_WRITE_BACK_CODES: ReadonlySet<string> = new Set(["DOMAIN_NOT_READ_YET", "LEASE_HELD", "INTERNAL"]);
