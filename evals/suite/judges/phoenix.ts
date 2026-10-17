// Labels and verdicts as Phoenix span annotations (owner: w4-eval-heldout), over Phoenix's REST API on the local
// server only (research/wave4/phoenix.md section 8): GET /v1/projects/{project}/span_annotations?span_ids=... to
// export, POST /v1/span_annotations?sync=true to import. `fetch` is injectable so tests run with no server.
//
// Names: Nitish labels a run's root span with the categorical annotation `human.<judge id>` (label pass or fail,
// his critique as the explanation, annotator kind HUMAN). A judge's own verdict goes back as `llm.<judge id>`
// (annotator kind LLM, score 1 for pass and 0 for fail, metadata with the prompt version and whether it counts).
import { JudgeId } from "../../../packages/contracts/src/evals";
import type { JudgeLabel, Verdict } from "./validate";

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export const HUMAN_PREFIX = "human.";
export const LLM_PREFIX = "llm.";
const SPAN_BATCH = 50;

export interface PhoenixTarget { baseUrl: string; project: string; fetch?: Fetch }

/** Only a Phoenix on this machine: the label store is local and never a hosted account. */
export function assertLocal(baseUrl: string): string {
  const u = new URL(baseUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) throw new Error(`PHOENIX_NOT_LOCAL: ${u.hostname} is not a local Phoenix`);
  return u.origin;
}

interface SpanAnnotationRow {
  span_id: string;
  name: string;
  annotator_kind: string;
  result?: { label?: string | null; score?: number | null; explanation?: string | null } | null;
  metadata?: Record<string, unknown> | null;
}

async function getJson(f: Fetch, url: string): Promise<unknown> {
  const r = await f(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`PHOENIX_HTTP ${r.status}: GET ${new URL(url).pathname}`);
  return r.json();
}

/** Every span annotation on the given spans, following next_cursor. */
export async function readSpanAnnotations(t: PhoenixTarget, spanIds: readonly string[]): Promise<SpanAnnotationRow[]> {
  const f = t.fetch ?? (globalThis.fetch as unknown as Fetch);
  const origin = assertLocal(t.baseUrl);
  const out: SpanAnnotationRow[] = [];
  for (let i = 0; i < spanIds.length; i += SPAN_BATCH) {
    const batch = spanIds.slice(i, i + SPAN_BATCH);
    let cursor: string | null = null;
    do {
      const qs = new URLSearchParams();
      for (const id of batch) qs.append("span_ids", id);
      qs.set("limit", "1000");
      if (cursor) qs.set("cursor", cursor);
      const page = (await getJson(f, `${origin}/v1/projects/${encodeURIComponent(t.project)}/span_annotations?${qs}`)) as { data?: SpanAnnotationRow[]; next_cursor?: string | null };
      out.push(...(page.data ?? []));
      cursor = page.next_cursor ?? null;
    } while (cursor);
  }
  return out;
}

const judgeOf = (name: string, prefix: string): JudgeId | null => {
  if (!name.startsWith(prefix)) return null;
  const p = JudgeId.safeParse(name.slice(prefix.length));
  return p.success ? p.data : null;
};
const verdictOf = (r: SpanAnnotationRow): Verdict | null => {
  const l = (r.result?.label ?? "").toLowerCase();
  if (l === "pass" || l === "fail") return l;
  if (r.result?.score === 1) return "pass";
  if (r.result?.score === 0) return "fail";
  return null;
};

/** Phoenix to labels: one label per span and judge that Nitish annotated, with the judge's verdict joined in when
 * an `llm.<judge>` annotation sits on the same span. */
export async function exportLabels(t: PhoenixTarget, spanIds: readonly string[], meta: Readonly<Record<string, { traceId?: string | null; taskId?: string | null }>> = {}): Promise<JudgeLabel[]> {
  const rows = await readSpanAnnotations(t, spanIds);
  const llm = new Map<string, SpanAnnotationRow>();
  for (const r of rows) { const j = judgeOf(r.name, LLM_PREFIX); if (j && r.annotator_kind === "LLM") llm.set(`${j}|${r.span_id}`, r); }
  const out: JudgeLabel[] = [];
  for (const r of rows) {
    const judge = judgeOf(r.name, HUMAN_PREFIX);
    const human = verdictOf(r);
    if (!judge || !human || r.annotator_kind !== "HUMAN") continue;
    const j = llm.get(`${judge}|${r.span_id}`);
    const pv = j?.metadata?.prompt_version;
    out.push({
      id: r.span_id, judge, human, critique: r.result?.explanation ?? "", spanId: r.span_id,
      traceId: meta[r.span_id]?.traceId ?? null, taskId: meta[r.span_id]?.taskId ?? null,
      judgeVerdict: j ? verdictOf(j) : null, judgeReason: j?.result?.explanation ?? null, promptVersion: typeof pv === "string" ? pv : null,
    });
  }
  return out.sort((a, b) => (a.judge + a.id < b.judge + b.id ? -1 : 1));
}

export interface AnnotationWrite { spanId: string; name: string; annotatorKind: "HUMAN" | "LLM" | "CODE"; label: Verdict; explanation: string; metadata?: Record<string, unknown> }

/** Labels to Phoenix: Nitish's labels as HUMAN annotations and, where present, the judge verdicts as LLM ones. */
export function annotationsFor(labels: readonly JudgeLabel[]): AnnotationWrite[] {
  const out: AnnotationWrite[] = [];
  for (const l of labels) {
    if (!l.spanId) continue;
    out.push({ spanId: l.spanId, name: `${HUMAN_PREFIX}${l.judge}`, annotatorKind: "HUMAN", label: l.human, explanation: l.critique });
    if (l.judgeVerdict) out.push({ spanId: l.spanId, name: `${LLM_PREFIX}${l.judge}`, annotatorKind: "LLM", label: l.judgeVerdict, explanation: l.judgeReason ?? "", metadata: { prompt_version: l.promptVersion } });
  }
  return out;
}

/** POSTs annotations in batches; returns how many were written. */
export async function writeAnnotations(t: Omit<PhoenixTarget, "project">, writes: readonly AnnotationWrite[]): Promise<number> {
  const f = t.fetch ?? (globalThis.fetch as unknown as Fetch);
  const origin = assertLocal(t.baseUrl);
  let n = 0;
  for (let i = 0; i < writes.length; i += SPAN_BATCH) {
    const data = writes.slice(i, i + SPAN_BATCH).map((w) => ({
      span_id: w.spanId, name: w.name, annotator_kind: w.annotatorKind,
      result: { label: w.label, score: w.label === "pass" ? 1 : 0, explanation: w.explanation },
      metadata: w.metadata ?? {},
    }));
    const r = await f(`${origin}/v1/span_annotations?sync=true`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ data }) });
    if (!r.ok) throw new Error(`PHOENIX_HTTP ${r.status}: POST /v1/span_annotations (${(await r.text()).slice(0, 200)})`);
    n += data.length;
  }
  return n;
}
