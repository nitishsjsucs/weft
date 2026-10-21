// The hidden service commands of the hosted extras (docs/cloudflare/design.md 5.4): the OCR consumers write an
// extract back into the slot through these, as the system principal svc_jobs. They are registered only on the durable
// platform, through the executor's extraCommands option, so Node's registry and its count assertions are unchanged.
// system_only (never an agent tool, never on MCP, on no allowlist but svc_jobs's), R1 system records with no
// approval. Each is idempotent on redelivery: the job id rides inside the stored extract, and a repeat is refused as
// DOMAIN_ALREADY_APPLIED before anything is written, so the action log gains no second row. The extract text is
// untrusted (expenses.*.receipt_extract and notice.body are untrusted fields), so a run that reads it is tainted.
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { DomainRefusal, expenses as expensesCore, notFound, riskOf, writeCommand, type WeftCommand } from "@weft/core";
import { expenses, notices } from "@weft/db";
import { HIDDEN_SERVICE_COMMANDS, type AttachReceiptExtractArgs, type AttachScanExtractArgs } from "../../../contracts/src/ext/cf-extras";
import type { HostedSystemPrincipal } from "../../../contracts/src/ext/cf-platform";

/** The system principal the queue write-backs run as (an ext addition to the frozen SystemPrincipal union). */
export const JOBS_PRINCIPAL: HostedSystemPrincipal = "svc_jobs";
/** svc_jobs's exact allowlist: the two write-backs and nothing else. */
export const JOBS_ALLOWLIST: readonly string[] = [HIDDEN_SERVICE_COMMANDS.receiptExtract, HIDDEN_SERVICE_COMMANDS.noticeExtract];
/** At most this much OCR text is kept on a notice (the notice body shown to people and, wrapped, to runs). */
export const MAX_SCAN_TEXT = 20_000;

// The pipeline maps null to a missing key before parsing (nullToUndefined), so every nullable field is nullish here
// and run() reads it back as null.
const nullableText = (max: number) => z.string().max(max).nullish();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ReceiptExtractSchema = z.object({
  merchant: nullableText(200), date: date.nullish(), totalCents: z.number().int().min(0).max(100_000_000).nullish(), currency: z.string().regex(/^[A-Z]{3}$/).nullish(),
  confidence: z.number().min(0).max(1),
}).strict();
const ScanExtractSchema = z.object({
  formCode: nullableText(40), period: nullableText(20), effectiveFrom: date.nullish(), accountNumber: nullableText(40), confidence: z.number().min(0).max(1), text: z.string().max(200_000),
}).strict();
const jobFields = { job_id: z.string().regex(/^obx_[0-9a-f]{16}$/), upload_id: z.string().startsWith("upl_"), model: z.string().min(1).max(120), neurons: z.number().min(0).max(1_000_000) };
const ReceiptInput = z.object({ ...jobFields, expense_id: z.string().startsWith("exp_"), extract: ReceiptExtractSchema.nullish() }).strict() as unknown as z.ZodType<AttachReceiptExtractArgs>;
const ScanInput = z.object({ ...jobFields, notice_id: z.string().startsWith("ntc_"), extract: ScanExtractSchema.nullish() }).strict() as unknown as z.ZodType<AttachScanExtractArgs>;

const parse = (s: string | null): Record<string, unknown> | null => { if (!s) return null; try { const v = JSON.parse(s) as unknown; return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; } };
const already = (jobId: string, what: string) => new DomainRefusal("DOMAIN_ALREADY_APPLIED", `Job ${jobId} already wrote ${what}`, null, null);

const attachReceiptExtract = writeCommand<AttachReceiptExtractArgs>({
  name: HIDDEN_SERVICE_COMMANDS.receiptExtract as `expenses.${string}`,
  summary: "System: store the text read from an expense's receipt image.",
  description: "System command (svc_jobs, the hosted OCR consumer): stores the merchant, date and total read from the receipt the claim carries, then reruns the policy checks. Refused when the receipt changed since the job was queued, when another source already filled the extract, or when this job already ran.",
  input: ReceiptInput, domain: "people", needs: "edit", effect: "write", risk: riskOf("R1"), approval: "never", access: "system_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const row = await expensesCore.getExpenseRow(deps.tx, ctx.companyId, i.expense_id);
    if (!row) throw notFound("expense", i.expense_id);
    if (row.receiptUploadId !== i.upload_id) throw new DomainRefusal("DOMAIN_STALE_RECEIPT", `${row.id} carries ${row.receiptUploadId ?? "no receipt"} now, not ${i.upload_id}`, null, null);
    const prior = parse(row.receiptExtractJson);
    if (prior?.job_id === i.job_id) throw already(i.job_id, `the extract of ${row.id}`);
    if (prior) throw new DomainRefusal("DOMAIN_EXTRACT_PRESENT", `${row.id} already has a receipt extract from ${String(prior.source ?? "another source")}`, null, null);
    const x = i.extract ?? null;
    const stored = { totalCents: x?.totalCents ?? null, date: x?.date ?? null, merchant: x?.merchant ?? null, currency: x?.currency ?? null, confidence: x?.confidence ?? 0, readable: !!x, source: "ocr", model: i.model, job_id: i.job_id };
    await deps.tx.update(expenses).set({ receiptExtractJson: JSON.stringify(stored) }).where(and(eq(expenses.id, row.id), eq(expenses.companyId, ctx.companyId)));
    const res = await expensesCore.writeChecks(deps.tx, (await expensesCore.getExpenseRow(deps.tx, ctx.companyId, row.id))!);
    return {
      data: { expense_id: row.id, upload_id: i.upload_id, readable: !!x, checks: res.checks.map((c) => c.rule) },
      summary: x ? `Read the receipt of ${row.id}` : `The receipt of ${row.id} could not be read`,
    };
  },
});

const attachScanExtract = writeCommand<AttachScanExtractArgs>({
  name: HIDDEN_SERVICE_COMMANDS.noticeExtract as `notices.${string}`,
  summary: "System: store the text read from an uploaded notice scan.",
  description: "System command (svc_jobs, the hosted OCR consumer): keeps the fields read from an uploaded notice's scan beside its extract and, when the notice has no text yet, the scan text as its body. It never classifies the notice; a person or the scan sidecar does. Refused when the upload changed or this job already ran.",
  input: ScanInput, domain: "tax", needs: "edit", effect: "write", risk: riskOf("R1"), approval: "never", access: "system_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const [n] = await deps.tx.select().from(notices).where(and(eq(notices.companyId, ctx.companyId), eq(notices.id, i.notice_id))).limit(1);
    if (!n) throw notFound("notice", i.notice_id);
    if (n.source !== "upload" || n.uploadId !== i.upload_id) throw new DomainRefusal("DOMAIN_STALE_UPLOAD", `${n.id} is not the notice uploaded as ${i.upload_id}`, null, null);
    const prior = parse(n.extractedJson) ?? {};
    const ocr = parse(JSON.stringify(prior.ocr ?? null));
    if (ocr?.job_id === i.job_id) throw already(i.job_id, `the scan extract of ${n.id}`);
    const x = i.extract ?? null;
    const next = { ...prior, ocr: { formCode: x?.formCode ?? null, period: x?.period ?? null, effectiveFrom: x?.effectiveFrom ?? null, accountNumber: x?.accountNumber ?? null, confidence: x?.confidence ?? 0, readable: !!x, model: i.model, job_id: i.job_id } };
    const body = n.bodyText.trim() === "" && x ? x.text.slice(0, MAX_SCAN_TEXT) : n.bodyText;
    await deps.tx.update(notices).set({ extractedJson: JSON.stringify(next), bodyText: body }).where(eq(notices.id, n.id));
    return {
      data: { notice_id: n.id, upload_id: i.upload_id, readable: !!x, body_filled: body !== n.bodyText },
      summary: x ? `Read the scan of ${n.id}` : `The scan of ${n.id} could not be read`,
    };
  },
});

/** The hidden service commands the durable platform registers through extraCommands. */
export function hostedServiceCommands(): WeftCommand[] {
  return [attachReceiptExtract as unknown as WeftCommand, attachScanExtract as unknown as WeftCommand];
}
