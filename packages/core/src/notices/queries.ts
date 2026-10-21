// Notice reads shared by notices.* commands and the /v1/notices routes.
import { and, asc, desc, eq, like, ne, or } from "drizzle-orm";
import { NoticeExtract, type Notice } from "@weft/contracts";
import { notices, proposals, type DbTx } from "@weft/db";
import { canonicalJson } from "../shared/canonical-json";

export type NoticeRow = typeof notices.$inferSelect;

/**
 * The parser's extract as stored, without the OCR scan the hosted write-back keeps beside it (`scan`, Weft on
 * Cloudflare, docs/cloudflare/design.md 5.4): null when nothing else is there. Readers that compare or cite the
 * parser's extract use this, so an OCR read never makes a letter look different or cite an extract it never had.
 */
export function parserExtractOf(json: string | null): Record<string, unknown> | unknown[] | string | null {
  if (!json) return null;
  let v: unknown;
  try { v = JSON.parse(json); } catch { return json; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return v as unknown[] | null;
  const { scan: _scan, ...rest } = v as Record<string, unknown>;
  return "scan" in (v as object) && Object.keys(rest).length === 0 ? null : rest;
}

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

/** Proposal statuses that mean the work on a notice is waiting on a person or under way. */
export const OPEN_PROPOSAL_STATUSES = ["pending", "approved"] as const;
export const NOTICE_PROPOSALS_MAX = 10;

export interface NoticeProposalRef { id: string; command: string | null; status: string; created_at: string }

/**
 * The proposals filed about a notice, newest first: its subject is the notice, or an argument names the notice id
 * (tax.update_rate's source_notice_id, notices.send_response's notice_id). Ids, commands and statuses only.
 */
export async function noticeProposals(tx: DbTx, companyId: string, noticeId: string, limit = NOTICE_PROPOSALS_MAX): Promise<NoticeProposalRef[]> {
  const rows = await tx.select({ id: proposals.id, command: proposals.command, status: proposals.status, createdAt: proposals.createdAt }).from(proposals)
    .where(and(eq(proposals.companyId, companyId), or(eq(proposals.subjectRef, noticeId), like(proposals.argsJson, `%${JSON.stringify(noticeId)}%`))))
    .orderBy(desc(proposals.createdAt), desc(proposals.id)).limit(limit);
  return rows.map((r) => ({ id: r.id, command: r.command, status: r.status, created_at: r.createdAt }));
}

/** A letter's identity: everything the parser read plus the exact body. Two rows with the same identity are one letter. */
function letterKey(n: NoticeRow): string {
  const extracted = parserExtractOf(n.extractedJson);
  const parts = { agency: n.agency, kind: n.kind, form: n.formCode, account: n.taxAccountId, extracted, body: n.bodyText };
  try { return canonicalJson(parts); } catch { return JSON.stringify(parts); }
}

/**
 * The earlier copy of the same letter, if one was stored before this notice (a mailing delivered twice, or a mailed
 * notice also uploaded): same agency, kind, form, matched account, parsed fields and body text. The earliest copy wins.
 */
export async function earlierCopyOf(tx: DbTx, companyId: string, n: NoticeRow): Promise<{ id: string; status: string; open_proposals: number } | null> {
  const same = await tx.select().from(notices).where(and(eq(notices.companyId, companyId), ne(notices.id, n.id), eq(notices.agency, n.agency), eq(notices.kind, n.kind), eq(notices.formCode, n.formCode)))
    .orderBy(asc(notices.receivedAt), asc(notices.id));
  const key = letterKey(n);
  const first = same.find((o) => (o.receivedAt < n.receivedAt || (o.receivedAt === n.receivedAt && o.id < n.id)) && o.taxAccountId === n.taxAccountId && letterKey(o) === key);
  if (!first) return null;
  const open = (await noticeProposals(tx, companyId, first.id, 50)).filter((p) => (OPEN_PROPOSAL_STATUSES as readonly string[]).includes(p.status)).length;
  return { id: first.id, status: first.status, open_proposals: open };
}
