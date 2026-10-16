// Document reads for the person view's library and the documents.* commands (w2-onboarding).
import { and, asc, eq } from "drizzle-orm";
import type { DocumentStatus, WorkerDocument } from "@weft/contracts";
import { documents, signatures, type DbTx } from "@weft/db";

export type DocumentRow = typeof documents.$inferSelect;

export function toDocumentDto(d: DocumentRow): WorkerDocument {
  return {
    id: d.id, companyId: d.companyId, workerId: d.workerId, offerId: d.offerId, kind: d.kind as WorkerDocument["kind"], title: d.title,
    status: d.status as WorkerDocument["status"], sha256: d.sha256, createdAt: d.createdAt, sentAt: d.sentAt, signedAt: d.signedAt,
  };
}

export async function listWorkerDocuments(tx: DbTx, companyId: string, workerId: string, status?: DocumentStatus): Promise<DocumentRow[]> {
  const where = status
    ? and(eq(documents.companyId, companyId), eq(documents.workerId, workerId), eq(documents.status, status))
    : and(eq(documents.companyId, companyId), eq(documents.workerId, workerId));
  return tx.select().from(documents).where(where).orderBy(asc(documents.id));
}

export async function getDocument(tx: DbTx, companyId: string, id: string): Promise<DocumentRow | null> {
  const [d] = await tx.select().from(documents).where(and(eq(documents.companyId, companyId), eq(documents.id, id))).limit(1);
  return d ?? null;
}

export async function signatureOf(tx: DbTx, documentId: string) {
  const [s] = await tx.select().from(signatures).where(eq(signatures.documentId, documentId)).limit(1);
  return s ?? null;
}
