// Offline re-grade of a saved suite run with today's G5 (round 2, FG1 item 3). Owner: w4-eval-suite. $0: no model call.
// A saved result file keeps each trial's verdicts, final text and trace id; the trial's tool calls, results and
// request-trust decision come back from the run's own spans in the local Phoenix (or a saved span export). The trial
// evidence rebuilt from them is enough for G5 alone; every other verdict is kept as saved, so the re-graded success
// separates the grader change from harness changes. It also checks G5 against the guard's own span on real traces.
//   tsx evals/suite/graders/regrade.ts <suite.json> (--spans <export.json> | --phoenix <url> --project <id>) [--out <file>]
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadTasks } from "../loader";
import { exportProjectSpans } from "../phoenix";
import type { EvalTask, EvStep, SuiteTrial, TrialEvidence } from "../types";
import { g5 } from "./index";

type Span = { name: string; span_kind: string; start_time: string; context: { trace_id: string }; attributes: Record<string, unknown> };
const parse = (v: unknown): unknown => { if (typeof v !== "string") return v ?? null; try { return JSON.parse(v); } catch { return v; } };

export interface Regraded {
  taskId: string; variant: string; trial: number; surface: string;
  before: { success: boolean; g5: boolean; reasons: string[] };
  after: { success: boolean; g5: boolean; reasons: string[]; groundedBy: { request: string[]; clock: string[] } | null };
  /** The loop's own guard verdict on the final answer (its last grounding.check span), for chat runs. */
  guard: boolean | null;
  /** True when a tool span's output did not parse (the export truncated it); the re-grade is then a lower bound. */
  partial: boolean;
}

/** Rebuilds the evidence G5 reads for one saved trial from its trace's spans. */
export function evidenceFromSpans(t: SuiteTrial, spans: Span[]): { ev: TrialEvidence; guard: boolean | null; partial: boolean } {
  const mine = spans.filter((s) => s.context.trace_id === t.traceId);
  const main = t.runIds[0] ?? null;
  const ofMain = mine.filter((s) => s.attributes["metadata.run_id"] === main).sort((a, b) => Number(a.attributes["weft.step_n"] ?? 0) - Number(b.attributes["weft.step_n"] ?? 0) || a.start_time.localeCompare(b.start_time));
  let partial = false;
  const steps: EvStep[] = [];
  const base = { runId: main ?? "", parentN: null, outcome: null, result: null, native: null, costUsdMicros: 0, usage: null, timings: null, toolArgs: null, toolName: null };
  for (const s of ofMain) {
    const n = Number(s.attributes["weft.step_n"] ?? 0);
    if (s.span_kind === "TOOL") {
      const outcome = parse(s.attributes["output.value"]);
      if (typeof outcome === "string") partial = true;
      steps.push({ ...base, n, stage: "dispatch", kind: "tool_call", toolName: String(s.attributes["tool.name"] ?? s.name), toolArgs: parse(s.attributes["input.value"]), outcome: String(s.attributes["weft.outcome"] ?? "ok"), result: { outcome } });
    } else if (s.name === "assemble") {
      const r = parse(s.attributes["output.value"]);
      if (r && typeof r === "object") steps.push({ ...base, n, stage: "assemble", kind: "context", result: r });
    }
  }
  const detail = t.detail as SuiteTrial["detail"] & { routine?: { id: string } | null };
  const summary = detail.finalText ?? null;
  // The saved record says whether the receipt was shown and how many repairs ran; the rows are rebuilt to match.
  steps.push({ ...base, n: 9998, stage: "model", kind: "model_call", native: { text: detail.groundingFallback ? `${summary ?? ""} (model answer differed)` : summary ?? "" } });
  for (let i = 0; i < t.groundingRepairs; i++) steps.push({ ...base, n: 9990 + i, stage: "post", kind: "notice", result: { attrs: { code: "UNGROUNDED" } } });
  const checks = mine.filter((s) => s.name === "grounding.check" && s.attributes["metadata.run_id"] === main);
  const guard = checks.length ? checks.sort((a, b) => a.start_time.localeCompare(b.start_time)).at(-1)!.attributes["weft.grounded"] === true : null;
  const ev: TrialEvidence = {
    mainRunId: main, runs: main ? [{ id: main, kind: "main", parentRunId: null, routineRunId: detail.routine?.id ?? null, status: "done", terminalReason: "DONE", tainted: false, taintedBy: null, stepsUsed: t.steps, costUsd: t.costUsd, summary }] : [],
    steps, actions: [], proposals: [], priorProposals: [], messages: [], memory: { headBefore: null, headAfter: null, commits: [], changed: [], texts: [] },
    otlp: [], canaries: [], registry: () => null, endState: [], wallMs: t.wallMs, error: null,
  };
  return { ev, guard, partial };
}

export function regrade(trials: SuiteTrial[], tasks: Map<string, EvalTask>, spans: Span[]): Regraded[] {
  const out: Regraded[] = [];
  for (const t of trials) {
    const task = tasks.get(t.taskId);
    const old = t.graders.find((g) => g.grader === "G5");
    if (!task || !old) continue;
    const expect = task.expect[t.variant as keyof typeof task.expect]!;
    const { ev, guard, partial } = evidenceFromSpans(t, spans);
    const v = g5(ev, expect, task);
    const others = t.graders.filter((g) => g.grader !== "G5" && g.grader !== "G10").every((g) => !g.applies || g.pass);
    out.push({
      taskId: t.taskId, variant: t.variant, trial: t.trial, surface: task.surface,
      before: { success: t.success, g5: old.pass, reasons: old.reasons },
      after: { success: others && v.pass && !t.error, g5: v.pass, reasons: v.reasons, groundedBy: v.groundedBy ?? null },
      guard, partial,
    });
  }
  return out;
}

async function main(argv: string[]): Promise<void> {
  const file = argv[0];
  if (!file) throw new Error("usage: regrade.ts <suite.json> (--spans <file> | --phoenix <url> --project <id>) [--out <file>]");
  const flag = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] ?? null : null; };
  const saved = JSON.parse(readFileSync(file, "utf8")) as { trials: SuiteTrial[]; harnessSha: string };
  const spansFile = flag("--spans");
  const spans = (spansFile ? JSON.parse(readFileSync(spansFile, "utf8")) : await exportProjectSpans(flag("--phoenix") ?? "http://127.0.0.1:6206", flag("--project") ?? "")) as Span[];
  const tasks = new Map(loadTasks(["dev"]).map((l) => [l.task.id, l.task] as const));
  const rows = regrade(saved.trials.filter((t) => t.split === "dev"), tasks, spans);
  const n = (f: (r: Regraded) => boolean) => rows.filter(f).length;
  const summary = {
    source: file, harnessSha: saved.harnessSha, trials: rows.length,
    successBefore: n((r) => r.before.success), successAfter: n((r) => r.after.success),
    g5Before: n((r) => r.before.g5), g5After: n((r) => r.after.g5),
    flipped: rows.filter((r) => r.before.success !== r.after.success).map((r) => `${r.taskId} ${r.before.success ? "pass" : "FAIL"} -> ${r.after.success ? "pass" : "FAIL"}`),
    guardAgreement: { compared: rows.filter((r) => r.guard !== null).length, disagree: rows.filter((r) => r.guard !== null && r.guard !== !r.after.reasons.some((x) => x.startsWith("grounding:"))).map((r) => r.taskId) },
    groundedOnlyBy: { request: rows.reduce((s, r) => s + (r.after.groundedBy?.request.length ?? 0), 0), clock: rows.reduce((s, r) => s + (r.after.groundedBy?.clock.length ?? 0), 0) },
    partial: rows.filter((r) => r.partial).map((r) => r.taskId),
  };
  const out = flag("--out");
  if (out) writeFileSync(out, JSON.stringify({ summary, rows }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
