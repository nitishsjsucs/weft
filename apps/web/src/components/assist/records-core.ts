// The records the page already holds (the useGet query cache), summarized for the cursor assistant: per query, its
// path, how many rows it holds and up to ten rows as an id with a few key fields. Only structured fields the app
// itself computes are kept (names of record, statuses, kinds, amounts as their display strings, dates); free text
// people typed (notes, purposes, bodies, messages, merchants) is never read, so it needs no untrusted wrapper.
import { ENTITY_RE, SCREEN_LIMITS, type RecordSummary } from "../../../../../packages/contracts/src/ext/assist";

/** Fields kept, in this order, when a row has them. */
export const RECORD_FIELDS = [
  "displayName", "workerName", "name", "headline", "status", "kind", "command", "risk", "band", "category", "reviewGroup", "workState", "department",
  "period", "periodStart", "periodEnd", "payday", "startAt", "endAt", "type", "role", "formCode", "trigger",
] as const;
/** Fields never read: text people typed, and model text. */
export const TYPED_FIELDS = new Set(["note", "notes", "purpose", "body", "text", "message", "description", "reason", "comment", "summary", "content", "answer", "question", "instructions", "agentNote", "decisionNote", "merchant", "memo", "explanation", "title"]);
/** Shell reads every page holds: they say nothing about this page. */
const SKIP = [/^\/v1\/(health|sim\/clock|stats|company|routines$)/, /^\/v1\/agent\/runs/];

function rowsOf(data: unknown): Record<string, unknown>[] {
  const arr = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray((data as { data?: unknown }).data) ? (data as { data: unknown[] }).data : data && typeof data === "object" ? [data] : [];
  return arr.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string" && ENTITY_RE.test((r as { id: string }).id));
}
const totalOf = (data: unknown, n: number): number => {
  const c = data && typeof data === "object" ? (data as { count?: unknown }).count : undefined;
  return typeof c === "number" && Number.isInteger(c) && c >= 0 ? c : n;
};

function fieldsOf(row: Record<string, unknown>, max: number, valueMax: number): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const add = (name: string, v: unknown) => {
    if (out.length >= max || TYPED_FIELDS.has(name)) return;
    const s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : v && typeof v === "object" && typeof (v as { display?: unknown }).display === "string" ? (v as { display: string }).display : null;
    if (s === null || !s.trim()) return;
    out.push({ name, value: s.replace(/\s+/g, " ").trim().slice(0, valueMax) });
  };
  for (const k of RECORD_FIELDS) if (k in row) add(k, row[k]);
  // Amounts the API sends as { cents, display } (gross, net, amount): their display string.
  for (const [k, v] of Object.entries(row)) if (/^[a-z][A-Za-z]*$/.test(k) && v && typeof v === "object" && typeof (v as { display?: unknown }).display === "string") add(k, v);
  return out;
}

export function summarizeRecords(entries: readonly { key: string; data: unknown }[], limits: typeof SCREEN_LIMITS.records = SCREEN_LIMITS.records): RecordSummary[] {
  const seen = new Set<string>();
  const out: (RecordSummary & { size: number })[] = [];
  for (const e of entries) {
    const source = e.key.split("?")[0]!.slice(0, 80);
    if (seen.has(source) || SKIP.some((r) => r.test(source))) continue;
    const rows = rowsOf(e.data);
    if (!rows.length) continue;
    seen.add(source);
    out.push({ source, count: totalOf(e.data, rows.length), size: rows.length, rows: rows.slice(0, limits.rows).map((r) => ({ id: r.id as string, fields: fieldsOf(r, limits.fields, limits.value) })) });
  }
  // The page's main lists first (most rows), then the rest, within the cap.
  return out.sort((a, b) => b.size - a.size).slice(0, limits.sources).map(({ size: _size, ...r }) => r);
}

/**
 * The name the page's own records give an entity ("Lena Brooks" for wrk_0026 or pay_2026_10_30:wrk_0026), or null:
 * a short label for what the pointer is on, instead of every word of its row.
 */
export function recordName(entries: readonly { key: string; data: unknown }[], entity: string): string | null {
  const ids = [entity, entity.split(":").pop()!];
  for (const e of entries) {
    for (const r of rowsOf(e.data)) {
      const hit = ids.includes(r.id as string) || (typeof r.workerId === "string" && ids.slice(1).includes(r.workerId) && entity.includes(":"));
      if (!hit) continue;
      for (const k of ["displayName", "workerName", "name", "headline"]) {
        const v = r[k];
        if (typeof v === "string" && v.trim()) return v.replace(/\s+/g, " ").trim().slice(0, 60);
      }
    }
  }
  return null;
}
