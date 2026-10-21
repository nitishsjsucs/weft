// The after-commit jobs outbox (docs/cloudflare/design.md 3.4). A command whose result needs OCR or an embedding
// appends an `outbox` row inside its own savepoint, so the row commits and rolls back with the command. After the
// outer commit the slot sends each row to its queue and deletes it (CompanyDO, cf4-worker); consumers do the I/O and
// write back through a hidden service command (hosted/commands.ts). The writer is on only when the platform gives an
// onOutbox callback: Node has none, so no Node command ever appends a row and the hosted tables stay empty there.
// jobsFor is the only mapping from a committed command to its jobs (cf6-extras' extrasOutboxJobs wraps it).
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { expenses, outbox, uploads, type DbTx } from "@weft/db";
import type { WeftCommand } from "@weft/core";
import type { HostedJob, HostedJobKind } from "../../../contracts/src/ext/cf-extras";

/** The job body without the envelope fields the writer fills in (jobId, slot, gen). */
export type HostedJobDraft = HostedJob extends infer J ? (J extends HostedJob ? Omit<J, "jobId" | "slot" | "gen" | "v"> : never) : never;

export interface OutboxWorld { slot: string; gen: number }

/** Outbox row ids: random, never a counter, so a job row never moves an id sequence a digest pins. */
export const outboxId = (): string => `obx_${randomBytes(8).toString("hex")}`;

/** Content type by file name, for the OCR consumer (the uploads table keeps no content type); the same map as
 * @weft/cf-extras' contentTypeOfName. */
export function contentTypeOf(fileName: string): string {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(fileName)?.[1]?.toLowerCase() ?? "";
  const map: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", txt: "text/plain", md: "text/plain" };
  return map[ext] ?? "application/octet-stream";
}

/** The commands the mapping looks at; every other command costs nothing. */
export const OUTBOX_COMMANDS: ReadonlySet<string> = new Set(["expenses.submit", "expenses.resubmit", "notices.upload", "memory.write_note"]);
/** A note's kind in the vector metadata (the same rule as @weft/cf-extras' noteKindOfPath). */
export function noteKindOfPath(path: string): string {
  if (path.startsWith("knowledge/procedures/")) return "procedure";
  if (path.startsWith("knowledge/decisions/")) return "decision";
  return path.split("/")[0] || "note";
}

/** Appends one job row in `tx` and returns its id (the job's idempotency key). Bodies stay far under 128 KB. */
export async function appendOutbox(tx: DbTx, world: OutboxWorld, draft: HostedJobDraft, now: string): Promise<string> {
  const id = outboxId();
  const job = { v: 1, ...draft, jobId: id, slot: world.slot, gen: world.gen } as HostedJob;
  const body = JSON.stringify(job);
  if (body.length > 120_000) throw new Error(`outbox job ${draft.kind} is ${body.length} bytes; the queue limit is 128 KB`);
  await tx.insert(outbox).values({ id, kind: draft.kind, body, createdAt: now });
  return id;
}

/** Rows not yet sent, oldest first (the slot's flush reads these after the outer commit). */
export async function pendingOutbox(tx: DbTx): Promise<{ id: string; kind: HostedJobKind; job: HostedJob }[]> {
  const rows = await tx.select().from(outbox).orderBy(outbox.createdAt, outbox.id);
  return rows.map((r) => ({ id: r.id, kind: r.kind as HostedJobKind, job: JSON.parse(r.body) as HostedJob }));
}

/** Deletes a row once its queue send succeeded. */
export async function ackOutbox(tx: DbTx, id: string): Promise<void> {
  await tx.delete(outbox).where(eq(outbox.id, id));
}

async function receiptJob(tx: DbTx, expenseId: unknown): Promise<HostedJobDraft | null> {
  if (typeof expenseId !== "string") return null;
  const [x] = await tx.select({ id: expenses.id, uploadId: expenses.receiptUploadId }).from(expenses).where(eq(expenses.id, expenseId)).limit(1);
  if (!x?.uploadId) return null;
  const [u] = await tx.select().from(uploads).where(eq(uploads.id, x.uploadId)).limit(1);
  if (!u) return null;
  return { kind: "ocr.receipt", uploadId: u.id, expenseId: x.id, sha256: u.sha256, storagePath: u.storagePath, contentType: contentTypeOf(u.fileName) };
}

/**
 * The jobs one successful command asks for, read from its input and result inside its savepoint (reads only, no I/O,
 * so the IO_IN_TX guard holds):
 * - a newly attached receipt on a claim (expenses.submit, expenses.resubmit): OCR of the receipt;
 * - a new uploaded notice (notices.upload, not a duplicate): OCR of the scan;
 * - a memory note (memory.write_note) while semantic recall is on: its embedding in the slot's namespace, untrusted
 *   when the writing run was tainted or the note is a human decision note (as the lexical recall decides). With
 *   recall off no embedding job is queued, so no embedding neurons are spent.
 */
export async function jobsFor(tx: DbTx, world: OutboxWorld, def: Pick<WeftCommand, "name">, input: unknown, data: unknown, ctx: { tainted: boolean; semanticRecall: boolean }): Promise<HostedJobDraft[]> {
  if (!OUTBOX_COMMANDS.has(def.name)) return [];
  const i = (input ?? {}) as Record<string, unknown>;
  const d = (data ?? {}) as Record<string, unknown>;
  switch (def.name) {
    case "expenses.submit":
    case "expenses.resubmit": {
      if (!i.receipt) return [];
      const j = await receiptJob(tx, d.expense_id);
      return j ? [j] : [];
    }
    case "notices.upload": {
      if (d.duplicate === true || typeof d.notice_id !== "string" || typeof d.upload_id !== "string") return [];
      const [u] = await tx.select().from(uploads).where(eq(uploads.id, d.upload_id)).limit(1);
      if (!u) return [];
      return [{ kind: "ocr.notice", uploadId: u.id, noticeId: d.notice_id, sha256: u.sha256, storagePath: u.storagePath, contentType: contentTypeOf(u.fileName) }];
    }
    case "memory.write_note": {
      if (!ctx.semanticRecall || typeof d.path !== "string" || typeof d.commit !== "string" || !/^[0-9a-f]{40}$/.test(d.commit)) return [];
      const tainted = ctx.tainted || d.path.startsWith("knowledge/decisions/");
      return [{ kind: "embed.memory", namespace: world.slot, notes: [{ path: d.path, commit: d.commit, tainted, kind: noteKindOfPath(d.path) }] }];
    }
    default:
      return [];
  }
}
