// Phoenix datasets and experiments for the suite (docs/wave4.md 3 and 4, research/wave4/phoenix.md 7). Owner: w4-eval-suite.
// Local Phoenix only. Every trial is one experiment run (runExperiment with concurrency 1); G1 to G10 and success are
// code evaluators that read the trial's own verdicts. All Phoenix traffic goes through a small capture proxy on an
// assigned port, so G9 scans the exact OTLP payload that left the process, and the trace links come back from the
// experiment runs. The trial output sent to Phoenix never carries a canary (they live only in the runner's memory).
import { createServer, request as httpRequest, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { createClient } from "@arizeai/phoenix-client";
import { createDataset, getDatasetInfo } from "@arizeai/phoenix-client/datasets";
import { asEvaluator, runExperiment } from "@arizeai/phoenix-client/experiments";
import type { EvalTask, GraderId } from "../../packages/contracts/src/evals";
import type { EvalVariant } from "../../packages/contracts/src/telemetry";
import { sha256Hex } from "../../packages/core/src/index";
import type { SuiteTrial } from "./types";
import type { SuiteTrialDetail } from "./runner";

export interface OtlpCapture { url: string; payloads: string[]; close(): Promise<void> }

/** A pass-through proxy to Phoenix on 127.0.0.1:<port> that keeps every /v1/traces body (gunzipped, as latin1 text). */
export async function startOtlpCapture(target: string, port: number): Promise<OtlpCapture> {
  const t = new URL(target);
  const payloads: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (req.url?.startsWith("/v1/traces")) {
        let raw = body;
        try { if (/gzip/i.test(String(req.headers["content-encoding"] ?? ""))) raw = gunzipSync(body); } catch { /* keep the raw bytes */ }
        payloads.push(raw.toString("latin1"));
      }
      const headers = { ...req.headers, host: t.host };
      const up = httpRequest({ hostname: t.hostname, port: t.port, path: req.url, method: req.method, headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
      up.on("error", (e) => { res.writeHead(502); res.end(String(e.message)); });
      up.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve()); });
  return { url: `http://127.0.0.1:${port}`, payloads, close: () => new Promise((r) => server.close(() => r())) };
}

export async function phoenixUp(url: string): Promise<string | null> {
  try { const r = await fetch(`${url}/arize_phoenix_version`, { signal: AbortSignal.timeout(2000) }); return r.ok ? (await r.text()).trim() : null; } catch { return null; }
}

const GRADERS: GraderId[] = ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10"];

/** The dataset of a split's tasks; its name carries a hash of the tasks so an edited suite gets a new dataset. */
export function datasetFor(split: string, tasks: EvalTask[]) {
  const hash = sha256Hex(JSON.stringify(tasks.map((t) => [t.id, t.input, t.expect, t.world.digest]))).slice(0, 10);
  return {
    name: `weft-eval-${split}-${hash}`,
    examples: tasks.map((t) => ({
      input: { task_id: t.id, surface: t.surface, principal: t.principal, request: t.input },
      output: { expect: t.expect },
      metadata: { eval_task_id: t.id, eval_split: t.split, group: t.group, kind: t.kind, parity: t.parity, legacy_case: t.legacyCase, world_digest: t.world.digest },
    })),
  };
}

export interface ExperimentRecord { experimentId: string; projectName: string | null; datasetId: string; compareUrl: string }

/**
 * Runs `trial` for every task of one split in one variant as a Phoenix experiment (repetitions k, concurrency 1).
 * The task callback returns the trial record; a stopped suite returns a skip marker the evaluators score as n/a.
 */
export async function recordExperiment(input: {
  baseUrl: string; publicUrl: string; split: string; variant: EvalVariant; tasks: EvalTask[]; k: number; name: string; metadata: Record<string, unknown>;
  trial: (task: EvalTask, n: number) => Promise<SuiteTrial | null>;
}): Promise<{ record: ExperimentRecord; trials: SuiteTrial[] }> {
  const client = createClient({ options: { baseUrl: input.baseUrl } });
  const ds = datasetFor(input.split, input.tasks);
  let datasetId: string;
  try { datasetId = (await getDatasetInfo({ client, dataset: { datasetName: ds.name } })).id; } catch {
    datasetId = (await createDataset({ client, name: ds.name, description: `Weft eval tasks, ${input.split} split`, examples: ds.examples })).datasetId;
  }
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const counts = new Map<string, number>();
  const trials: SuiteTrial[] = [];
  const ran = await runExperiment({
    client, dataset: { datasetId }, experimentName: input.name, experimentDescription: `Weft eval suite, ${input.split} split, ${input.variant} variant`,
    experimentMetadata: { ...input.metadata, variant: input.variant, chat_can_propose: input.variant === "chat_can_propose" },
    concurrency: 1, repetitions: input.k, useBatchSpanProcessor: false, logger: { info: () => undefined, log: () => undefined, error: (m: unknown) => console.error(m), warn: () => undefined, debug: () => undefined, table: () => undefined } as never,
    task: async (example) => {
      const id = String((example.input as { task_id: string }).task_id);
      const n = (counts.get(id) ?? 0) + 1;
      counts.set(id, n);
      const task = byId.get(id)!;
      const t = await input.trial(task, n);
      if (!t) return { skipped: true, taskId: id, variant: input.variant, trial: n };
      trials.push(t);
      const { detail, ...rest } = t;
      // The Task span's output carries the routine run's status and precheck reason at the top level (FM11), so a
      // routine trial that started no agent run (and so has no agent span) still shows why in Phoenix. The reason is
      // already redacted at the source (runner.routineRunInfo).
      const routine = (detail as SuiteTrialDetail).routine ?? null;
      return {
        ...rest,
        routine_run: routine ? { id: routine.id, routine_id: routine.routineId, status: routine.status, agent_run_id: routine.agentRunId, precheck_reason: routine.reason } : null,
        detail: { ...detail, finalText: detail.finalText?.slice(0, 2000) ?? null },
      };
    },
    evaluators: [
      asEvaluator({ name: "success", kind: "CODE", evaluate: async ({ output }) => {
        const o = output as Partial<SuiteTrial> & { skipped?: boolean };
        if (o.skipped) return { label: "skipped", score: null, explanation: "the suite stopped at a cap before this trial" };
        const rr = (o as { routine_run?: { status: string; precheck_reason: string | null; agent_run_id: string | null } | null }).routine_run;
        const why = rr && !rr.agent_run_id ? `routine run ${rr.status}${rr.precheck_reason ? `: ${rr.precheck_reason}` : ""}` : null;
        return { label: o.success ? "pass" : "fail", score: o.success ? 1 : 0, explanation: o.success ? why : ([o.firstFailure, o.error ?? why].filter(Boolean).join(": ") || null) };
      } }),
      ...GRADERS.map((g) => asEvaluator({ name: g, kind: "CODE", evaluate: async ({ output }) => {
        const o = output as Partial<SuiteTrial> & { skipped?: boolean };
        const v = o.graders?.find((x) => x.grader === g);
        if (o.skipped || !v) return { label: "n/a", score: null, explanation: o.skipped ? "skipped" : (o.error ?? "no verdict") };
        if (!v.applies) return { label: "n/a", score: null, explanation: v.reasons.join("; ") || null };
        return { label: g === "G10" ? String(v.metric ?? 0) : v.pass ? "pass" : "fail", score: g === "G10" ? Number(v.metric ?? 0) : v.pass ? 1 : 0, explanation: v.reasons.join("; ") || null };
      } })),
    ],
  });
  // Trace links: each experiment run carries the trace id of its task span.
  let projectId: string | null = null;
  if (ran.projectName) {
    for (let i = 0; i < 10 && !projectId; i++) {
      try { const r = await fetch(`${input.publicUrl}/v1/projects/${encodeURIComponent(ran.projectName)}`); if (r.ok) projectId = ((await r.json()) as { data?: { id?: string } }).data?.id ?? null; } catch { /* retry */ }
      if (!projectId) await new Promise((r) => setTimeout(r, 300));
    }
  }
  const compareUrl = `${input.publicUrl}/datasets/${datasetId}/compare?experimentId=${ran.id}`;
  for (const run of Object.values(ran.runs)) {
    const o = run.output as { taskId?: string; variant?: string; trial?: number; skipped?: boolean } | null;
    const t = trials.find((x) => x.taskId === o?.taskId && x.variant === o?.variant && x.trial === o?.trial);
    if (!t) continue;
    t.experimentRunId = run.id;
    t.traceId = run.traceId;
    t.phoenixUrl = projectId && run.traceId ? `${input.publicUrl}/projects/${projectId}/traces/${run.traceId}` : compareUrl;
  }
  return { record: { experimentId: ran.id, projectName: ran.projectName, datasetId, compareUrl }, trials };
}

/** Every span of one Phoenix project over the REST API (read only, paged), for offline re-grading at $0. */
export async function exportProjectSpans(baseUrl: string, projectId: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 200; page++) {
    const q = new URLSearchParams({ limit: "500", ...(cursor ? { cursor } : {}) });
    const r = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/spans?${q}`, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`Phoenix spans answered ${r.status}`);
    const d = (await r.json()) as { data: Record<string, unknown>[]; next_cursor?: string | null };
    out.push(...d.data);
    cursor = d.next_cursor ?? null;
    if (!cursor) break;
  }
  return out;
}
