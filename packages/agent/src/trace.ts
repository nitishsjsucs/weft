// Run trace (harness 10, SPEC 9.6): the run, its stage rows with timings, tokens, cache-hit ratio and USD. The brain
// sees proposals only through tool outcomes; apps/api enriches `proposals` from the executor's tables.
import type { RunStepRow, RunTrace, ToolOutcome } from "@weft/contracts";
import type { RunStore } from "./store";

export interface StageRow { n: number; stage: RunStepRow["stage"]; kind: RunStepRow["kind"]; ms: number; label: string; outcome: RunStepRow["outcome"] }

export interface TraceSummary {
  steps: number; modelCalls: number; toolCalls: number;
  tokens: { input: number; cached: number; cacheWrite: number; output: number; reasoning: number };
  cacheHitRatio: number | null; usd: number; modelMs: number; prefixHashes: string[];
  stages: StageRow[];
}

export function stageMs(s: RunStepRow): number {
  const t = s.timings;
  const r = (s.result ?? {}) as { ms?: number };
  switch (s.stage) {
    case "admission": return t?.admissionMs ?? 0;
    case "assemble": return t?.assembleMs ?? 0;
    case "model": return t?.modelMs ?? 0;
    case "dispatch": return t?.dispatchMs ?? 0;
    default: return r.ms ?? 0;
  }
}

/** Step chips (SPEC 9.6) come from tool names and each outcome's summary. */
export function stageLabel(s: RunStepRow): string {
  if (s.kind === "tool_call") {
    const o = (s.result as { outcome?: ToolOutcome } | null)?.outcome;
    if (o && o.ok && o.status === "done") return o.summary;
    if (o && o.ok) return `Proposed: ${o.title}`;
    if (o && !o.ok) return `${s.toolName}: ${o.refusal.code}`;
    return s.toolName ?? "tool";
  }
  if (s.kind === "model_call") return s.outcome === "ok" ? `Model step (attempt ${s.attempt})` : `Model step failed (attempt ${s.attempt})`;
  if (s.kind === "recite") return String((s.result as { plan?: string } | null)?.plan ?? "checklist");
  if (s.kind === "notice") return `Notice: ${(s.result as { attrs?: { code?: string } } | null)?.attrs?.code ?? "notice"}`;
  if (s.stage === "terminal") return `Finished: ${(s.result as { status?: string } | null)?.status ?? ""}`;
  return s.stage;
}

export function summarize(steps: RunStepRow[]): TraceSummary {
  const tokens = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  let usdMicros = 0;
  let modelMs = 0;
  const hashes = new Set<string>();
  for (const s of steps) {
    if (s.kind !== "model_call") continue;
    if (s.usage) for (const k of Object.keys(tokens) as (keyof typeof tokens)[]) tokens[k] += s.usage[k] ?? 0;
    usdMicros += s.costUsdMicros;
    modelMs += s.timings?.modelMs ?? 0;
    if (s.prefixHash) hashes.add(s.prefixHash);
  }
  return {
    steps: steps.length,
    modelCalls: steps.filter((s) => s.kind === "model_call").length,
    toolCalls: steps.filter((s) => s.kind === "tool_call").length,
    tokens,
    cacheHitRatio: tokens.input > 0 ? tokens.cached / tokens.input : null,
    usd: usdMicros / 1e6,
    modelMs,
    prefixHashes: [...hashes],
    stages: steps.map((s) => ({ n: s.n, stage: s.stage, kind: s.kind, ms: stageMs(s), label: stageLabel(s), outcome: s.outcome })),
  };
}

export async function buildTrace(store: RunStore, runId: string): Promise<RunTrace | null> {
  const run = await store.getRun(runId);
  if (!run) return null;
  const steps = await store.steps(runId);
  const actions: RunTrace["actions"] = [];
  for (const s of steps) {
    if (s.kind !== "tool_call") continue;
    const o = (s.result as { outcome?: ToolOutcome } | null)?.outcome;
    if (o && o.ok && o.status === "done" && o.actionSeq !== null) actions.push({ seq: o.actionSeq, command: s.toolName ?? "", summary: o.summary });
  }
  return { run, steps, proposals: [], actions, children: [] };
}
