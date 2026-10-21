// Email expense submission (S5, docs/wave4.md). Owner: w4-parity-agent.
// expenses.intake_email is a system record (svc_sim): it accepts mail only from a worker's work address on file,
// stores the attached receipt as an upload, and creates one submitted expense with source "email" that the normal
// policy checks and the wave 3 review routine pick up. Unknown senders and mail without a receipt bounce. The
// subject and body are the employee's own words: they become the business purpose, which expenses.get already marks
// untrusted, so the review run that reads them is tainted as in wave 3.
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ExpenseCategory, type ExpenseIntakeStatus } from "@weft/contracts";
import { expenseIntake, expenses, uploads, workers, type Db, type DbTx } from "@weft/db";
import { riskOf, writeCommand } from "../demo/define";
import { getExpenseRow, writeChecks } from "../expenses/store";

export const EXPENSES_INBOX = "expenses@larkspur.example";
const EXAMPLE_ADDR = /^[^@\s]+@([a-z0-9-]+\.)*example$/i;

const Receipt = z.object({
  file_name: z.string().min(1).max(120), fixture: z.string().min(1).max(60), bytes: z.number().int().min(1), sha256: z.string().length(64),
  storage_path: z.string().regex(/^(uploads\/|blob:)/), merchant: z.string().min(1).max(120), category: ExpenseCategory,
  amount_cents: z.number().int().min(1), transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();
const IntakeInput = z.object({
  message_ref: z.string().startsWith("imsg_"), from: z.string().min(3).max(200), subject: z.string().max(200), body: z.string().max(4000),
  receipt: Receipt.optional(),
}).strict();
type IntakeInput = z.infer<typeof IntakeInput>;

/** The business purpose from the employee's words: subject, else the first body line; clipped, never empty. */
export function purposeOf(subject: string, body: string): string {
  const s = subject.replace(/^\s*(re|fwd?|expense|receipt)\s*:\s*/i, "").trim();
  const line = body.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return (s || line || "Emailed receipt").slice(0, 200);
}

async function workerByAddress(tx: DbTx, companyId: string, from: string) {
  const addr = from.trim().toLowerCase();
  const [w] = await tx.select().from(workers).where(and(eq(workers.companyId, companyId), sql`lower(${workers.workEmail}) = ${addr}`)).limit(1);
  return w && w.status !== "terminated" ? w : null;
}

export const intakeEmail = writeCommand<IntakeInput>({
  name: "expenses.intake_email", summary: "Turn an emailed receipt into a submitted expense (system only)",
  description: "System only: records one inbound expense email. From a worker's work address with a receipt it stores the upload and creates a submitted expense with source email; an unknown sender or a missing receipt bounces; the same message twice is a duplicate.",
  input: IntakeInput, domain: "people", needs: "view", effect: "write", risk: riskOf("R1"), approval: "never", access: "system_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const [seen] = await tx.select().from(expenseIntake).where(eq(expenseIntake.messageRef, i.message_ref)).limit(1);
    if (seen) return { data: { intake_id: seen.id, status: "duplicate" as ExpenseIntakeStatus, expense_id: seen.expenseId, first_status: seen.status }, summary: `Message ${i.message_ref} was already received as ${seen.id}` };
    const id = await deps.newId("exi_");
    const w = await workerByAddress(tx, ctx.companyId, i.from);
    const row = { id, companyId: ctx.companyId, source: "email", fromAddress: i.from.trim().toLowerCase().slice(0, 200), workerId: w?.id ?? null, messageRef: i.message_ref, receivedAt: ctx.now };
    const bounce = async (status: ExpenseIntakeStatus, why: string) => {
      await tx.insert(expenseIntake).values({ ...row, uploadId: null, status, expenseId: null });
      // A bounce goes back only to a simulated (*.example) address; anything else is recorded and dropped.
      if (EXAMPLE_ADDR.test(i.from.trim())) {
        await deps.sims.email.send({ to: i.from.trim(), from: EXPENSES_INBOX, subject: `Not filed: ${i.subject || "your expense email"}`.slice(0, 200), body: `${why}\n\nThis is the Weft expenses inbox for Larkspur Robotics (demo). Nothing was filed.`, kind: "generic", relatedRef: id });
      }
      return { data: { intake_id: id, status, expense_id: null }, summary: `Bounced ${i.message_ref}: ${status}`, events: [{ type: "email.expense_received", subjectRef: id, payload: { intake_id: id } }] };
    };
    if (!w) return bounce("bounced_unknown_sender", "We only accept expenses from a work email address on file. Send it again from your work address.");
    if (!i.receipt) return bounce("bounced_no_receipt", "Your email had no receipt we could read. Attach the receipt (PDF or photo) and send it again.");

    const r = i.receipt;
    const uploadId = await deps.newId("upl_");
    await tx.insert(uploads).values({ id: uploadId, workerId: w.id, purpose: "receipt", fileName: r.file_name, storagePath: r.storage_path, bytes: r.bytes, sha256: r.sha256, createdAt: ctx.now });
    const expenseId = await deps.newId("exp_");
    await tx.insert(expenses).values({
      id: expenseId, companyId: ctx.companyId, workerId: w.id, category: r.category, merchant: r.merchant, amountCents: r.amount_cents, currency: "USD",
      transactionDate: r.transaction_date, submittedAt: ctx.now, businessPurpose: purposeOf(i.subject, i.body), attendees: null, milesX10: null, tripRef: null,
      preApprovalRef: null, receiptUploadId: uploadId,
      // The fixture's extract stands in for OCR (deferred past wave 4), so the receipt checks run as for a portal claim.
      receiptExtractJson: JSON.stringify({ totalCents: r.amount_cents, date: r.transaction_date, merchant: r.merchant }), status: "submitted", checksJson: "[]", source: "email",
    });
    const checks = await writeChecks(tx, (await getExpenseRow(tx, ctx.companyId, expenseId))!);
    await tx.insert(expenseIntake).values({ ...row, uploadId, status: "created", expenseId });
    return {
      data: { intake_id: id, status: "created" as ExpenseIntakeStatus, expense_id: expenseId, worker_id: w.id, checks: checks.checks.map((c) => ({ rule: c.rule, severity: c.severity })) },
      summary: `Filed ${expenseId} from an emailed receipt (${r.category}, ${r.amount_cents} cents)`,
      events: [
        { type: "email.expense_received", subjectRef: id, payload: { intake_id: id } },
        { type: "expense.submitted", subjectRef: expenseId, payload: { expense_id: expenseId, worker_id: w.id } },
      ],
    };
  },
});

export async function listIntake(db: Db | DbTx, companyId: string, status?: string | null) {
  const rows = await db.select().from(expenseIntake).where(status ? and(eq(expenseIntake.companyId, companyId), eq(expenseIntake.status, status)) : eq(expenseIntake.companyId, companyId)).orderBy(desc(expenseIntake.id)).limit(100);
  return rows.map((r) => ({ id: r.id, source: r.source, fromAddress: r.fromAddress, workerId: r.workerId, messageRef: r.messageRef, uploadId: r.uploadId, status: r.status, expenseId: r.expenseId, receivedAt: r.receivedAt }));
}
