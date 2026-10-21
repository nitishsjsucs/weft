// Which committed commands need an after-commit job (design 3.4), for the executor's outbox writer on the durable
// platform: a receipt attached to an expense claim and an uploaded notice need OCR, and a memory note written while
// semantic recall is on needs an embedding. The writer calls this inside the command's own transaction (reads only,
// no I/O: the IO_IN_TX guard applies), appends one outbox row per job, and the slot sends them after the commit.
// PDF renders are not outbox jobs: they are enqueued on demand by the PDF route. Track cf6-extras.
import { eq } from "drizzle-orm";
import { expenses, uploads, type DbTx } from "@weft/db";
import { contentTypeOfName, isUntrustedNote, noteKindOfPath, type HostedJob } from "@weft/cf-extras";

/** One command that committed, as the outbox writer sees it. */
export interface CommittedCall { command: string; input: unknown; data: unknown }
export interface OutboxJobOptions {
  world: { slot: string; gen: number };
  newJobId: () => string;
  /** The memoized `recall.semantic` flag: off means no embedding jobs (and no embedding neurons). */
  semanticRecall: boolean;
}

/** Commands this mapping looks at; every other command costs nothing. */
export const OUTBOX_COMMANDS: ReadonlySet<string> = new Set(["expenses.submit", "expenses.resubmit", "notices.upload", "memory.write_note"]);

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export async function extrasOutboxJobs(tx: DbTx, call: CommittedCall, o: OutboxJobOptions): Promise<HostedJob[]> {
  if (!OUTBOX_COMMANDS.has(call.command)) return [];
  const input = obj(call.input), data = obj(call.data);
  const base = { v: 1 as const, slot: o.world.slot, gen: o.world.gen };
  const upload = async (id: unknown) => (typeof id === "string" ? (await tx.select().from(uploads).where(eq(uploads.id, id)).limit(1))[0] ?? null : null);

  if (call.command === "expenses.submit" || call.command === "expenses.resubmit") {
    // Only a newly attached receipt: a resubmit that keeps the old receipt keeps its extract.
    if (!input.receipt || typeof data.expense_id !== "string") return [];
    const [e] = await tx.select({ receiptUploadId: expenses.receiptUploadId }).from(expenses).where(eq(expenses.id, data.expense_id)).limit(1);
    const up = await upload(e?.receiptUploadId);
    if (!up) return [];
    return [{ ...base, kind: "ocr.receipt", jobId: o.newJobId(), uploadId: up.id, expenseId: data.expense_id, sha256: up.sha256, storagePath: up.storagePath, contentType: contentTypeOfName(up.fileName) }];
  }
  if (call.command === "notices.upload") {
    if (data.duplicate === true || typeof data.notice_id !== "string") return [];
    const up = await upload(data.upload_id);
    if (!up) return [];
    return [{ ...base, kind: "ocr.notice", jobId: o.newJobId(), uploadId: up.id, noticeId: data.notice_id, sha256: up.sha256, storagePath: up.storagePath, contentType: contentTypeOfName(up.fileName) }];
  }
  // memory.write_note
  if (!o.semanticRecall || typeof data.path !== "string" || typeof data.commit !== "string" || !/^[0-9a-f]{40}$/.test(data.commit)) return [];
  return [{ ...base, kind: "embed.memory", jobId: o.newJobId(), namespace: o.world.slot, notes: [{ path: data.path, commit: data.commit, tainted: isUntrustedNote(data.path, ""), kind: noteKindOfPath(data.path) }] }];
}
