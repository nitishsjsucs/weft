// The evidence a chat answer is checked against, built from one run's own step rows (harness 4.8). The loop's guard
// and the eval suite's G5 grader both call runEvidence, so they grade an answer with the same evidence and reach the
// same verdict (round 1 analysis R1: G5 had graded with the tool results alone).
//
// The rows are read structurally (the run store's RunStepRow and the eval suite's EvStep both fit), so this package
// still imports nothing. It reads three kinds of row:
// - the context pack (kind "context", result.pack true): the person's request, between <request> tags and escaped
//   by the pack, and the run clock, on its "now: <ISO instant>" line;
// - the first assemble row that carries result.requestTrusted (stage "assemble", kind "context"; the pack row has the
//   same stage and kind but no decision): the loop's decision that the run was untainted before its first model
//   step. Without it the request is not evidence (a routine run, or a run tainted before it began);
// - tool_call rows: a done outcome gives its result, a pending one its proposal id and title, and every string in
//   the call's arguments is an echo. The run feed update (comms.post_update) is model-authored prose: it gives
//   neither a result nor an echo.
import type { CheckOptions } from "./check";

/** The fields of a run step that evidence reads. */
export interface EvidenceStep {
  stage?: string | null;
  kind: string;
  toolName?: string | null;
  toolArgs?: unknown;
  result?: unknown;
}

export interface RunEvidence {
  /** What the check's second argument takes: each done result, and each proposal a call opened. */
  results: unknown[];
  /** What the check's third argument takes: the trusted request, the run clock and the run's echoed arguments. */
  opts: CheckOptions & { request: string | null; now: string | null; echoes: Set<string> };
}

export interface RunEvidenceOptions {
  /** The clock to use when the pack has no "now:" line (the loop's clock, or the trial world's). */
  now?: string | null;
}

/** Tools whose calls are model-authored text, not reads: never evidence and never echoes. Wire or dotted names. */
export const MODEL_AUTHORED_TOOLS: ReadonlySet<string> = new Set(["comms.post_update"]);

const dotted = (name: string) => name.replace("__", ".");

/** The pack escapes the request (agent context.ts escapeTagText); grounding reads the words as the person wrote them. */
export function unescapeTagText(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function stringsOf(v: unknown, out: Set<string>): void {
  if (typeof v === "string") out.add(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) stringsOf(x, out);
}

/**
 * The loop's stored decision on whether the request is evidence: the first assemble row that carries one, or null when
 * none does yet. The context pack row has the same stage and kind, and never carries it.
 */
export function requestTrustOf(steps: Iterable<EvidenceStep>): boolean | null {
  for (const s of steps) {
    const v = s.stage === "assemble" && s.kind === "context" ? (s.result as { requestTrusted?: unknown } | null)?.requestTrusted : undefined;
    if (typeof v === "boolean") return v;
  }
  return null;
}

/** The fields of a tool outcome (contracts ToolOutcome) that evidence keeps. */
interface Outcome { ok?: unknown; status?: unknown; resultId?: unknown; data?: unknown; summary?: unknown; actionSeq?: unknown; proposalId?: unknown; title?: unknown }

/**
 * The evidence of one run, from its step rows in order. Pass only that run's rows: a trial's other runs (a digest,
 * a routine) are not this answer's evidence.
 */
export function runEvidence(steps: Iterable<EvidenceStep>, o: RunEvidenceOptions = {}): RunEvidence {
  const rows = [...steps];
  const pack = rows.find((s) => s.kind === "context" && (s.result as { pack?: unknown } | null)?.pack === true);
  const text = typeof (pack?.result as { text?: unknown } | undefined)?.text === "string" ? (pack!.result as { text: string }).text : "";
  const trusted = requestTrustOf(rows) === true;
  const request = trusted ? unescapeTagText(/<request>([\s\S]*?)<\/request>/.exec(text)?.[1] ?? "") : null;
  const now = /^now: (\S+)$/m.exec(text)?.[1] ?? o.now ?? null;

  const results: unknown[] = [];
  const echoes = new Set<string>();
  for (const r of rows) {
    if (r.kind !== "tool_call") continue;
    if (r.toolName && MODEL_AUTHORED_TOOLS.has(dotted(r.toolName))) continue;
    stringsOf(r.toolArgs, echoes);
    const out = (r.result as { outcome?: Outcome } | null)?.outcome;
    if (out?.ok !== true) continue;
    if (out.status === "done") results.push({ resultId: out.resultId, data: out.data, summary: out.summary, actionSeq: out.actionSeq });
    else results.push({ proposalId: out.proposalId, title: out.title });
  }
  return { results, opts: { request, now, echoes } };
}
