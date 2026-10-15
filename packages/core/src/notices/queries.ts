// Notice reads shared by notices.* commands and the /v1/notices routes.
import { and, asc, eq } from "drizzle-orm";
import { NoticeExtract, type Notice } from "@weft/contracts";
import { notices, type DbTx } from "@weft/db";

export type NoticeRow = typeof notices.$inferSelect;

export function parseExtract(json: string | null): NoticeExtract | null {
  if (!json) return null;
  const r = NoticeExtract.safeParse(JSON.parse(json));
  return r.success ? r.data : null;
}

export function toNoticeDto(n: NoticeRow, withBody: boolean): Notice {
  return {
    id: n.id, agency: n.agency as Notice["agency"], kind: n.kind as Notice["kind"], formCode: n.formCode, title: n.title, receivedAt: n.receivedAt,
    respondBy: n.respondBy, status: n.status as Notice["status"], taxAccountId: n.taxAccountId, fileName: n.fileName,
    ...(withBody ? { bodyText: n.bodyText } : {}), extracted: parseExtract(n.extractedJson),
    resolution: n.resolutionJson ? (JSON.parse(n.resolutionJson) as Record<string, unknown>) : null, responseConfirmation: n.responseConfirmation,
  };
}

export async function listNotices(tx: DbTx, companyId: string, status?: string): Promise<NoticeRow[]> {
  return tx.select().from(notices).where(status ? and(eq(notices.companyId, companyId), eq(notices.status, status)) : eq(notices.companyId, companyId)).orderBy(asc(notices.id));
}

export async function getNotice(tx: DbTx, companyId: string, id: string): Promise<NoticeRow | null> {
  const [n] = await tx.select().from(notices).where(and(eq(notices.companyId, companyId), eq(notices.id, id))).limit(1);
  return n ?? null;
}

export interface NoticeDraft { n: number; created_at: string; body: string; note: string; tainted_by: string | null }
export function parseDrafts(json: string): NoticeDraft[] {
  try { const v = JSON.parse(json); return Array.isArray(v) ? (v as NoticeDraft[]) : []; } catch { return []; }
}
