// Public Greenhouse job board reader (research/wave3/integrations-hr.md 1.6). Owner: w3-integrations-hr.
// GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs needs no key and holds no personal data. The parser keeps
// the fields Weft shows and normalizes metadata: a single_select value is a string, a multi_select value an array.
// Tests run on a hand-written fictional Larkspur fixture; only WEFT_LIVE_PUBLIC=1 makes a live read, sparingly.
import type { AtsJob } from "@weft/contracts";

export interface BoardMetadata { name: string; type: string; values: string[] }
export interface BoardJob extends AtsJob { internalJobId: string | null; requisitionId: string | null; metadata: BoardMetadata[] }

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Parses a board `jobs` response ({ jobs, meta }). Throws on a shape that is not a board listing. */
export function parseBoardJobs(body: unknown): { total: number; jobs: BoardJob[] } {
  const b = body as { jobs?: unknown; meta?: { total?: unknown } } | null;
  if (!b || !Array.isArray(b.jobs)) throw new Error("job board: expected { jobs: [] }");
  const jobs = b.jobs.map((raw): BoardJob => {
    const j = raw as Record<string, unknown>;
    if (typeof j.id !== "number" || typeof j.title !== "string") throw new Error("job board: a job without id or title");
    const md = Array.isArray(j.metadata) ? (j.metadata as Record<string, unknown>[]) : [];
    const metadata = md.map((m) => ({
      name: String(m.name ?? ""), type: String(m.value_type ?? ""),
      values: Array.isArray(m.value) ? (m.value as unknown[]).map(String) : m.value === null || m.value === undefined ? [] : [String(m.value)],
    }));
    const dept = metadata.find((m) => /department/i.test(m.name))?.values[0] ?? null;
    const office = metadata.find((m) => /location/i.test(m.name))?.values[0] ?? null;
    return {
      id: String(j.id), name: j.title, departmentName: dept, officeName: office, location: str((j.location as { name?: unknown } | null)?.name),
      updatedAt: new Date(String(j.updated_at)).toISOString(), url: str(j.absolute_url), internalJobId: j.internal_job_id === null || j.internal_job_id === undefined ? null : String(j.internal_job_id),
      requisitionId: str(j.requisition_id), metadata,
    };
  });
  const total = typeof b.meta?.total === "number" ? b.meta.total : jobs.length;
  return { total, jobs };
}

export const boardUrl = (token: string) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=false`;

/** One live read of a public board (no credentials). Callers gate it behind WEFT_LIVE_PUBLIC=1 in tests. */
export async function fetchBoardJobs(token: string, f: typeof fetch = fetch): Promise<{ total: number; jobs: BoardJob[] }> {
  const res = await f(boardUrl(token), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`job board ${token}: HTTP ${res.status}`);
  return parseBoardJobs(await res.json());
}
