import { ReportResult, type ProposalStatus, type RunStepRow } from "@weft/contracts";
import { humanDates, humanTimes } from "../format";

/** Tool names arrive in wire form (`payroll__explain_flags`); the UI shows the dotted command name. */
export function toolLabel(name: string | null): string | null {
  return name ? name.replace(/__/g, ".") : null;
}

/**
 * Chip text for a step: the tool outcome's summary (or a proposal's title) when the tool returned one, else the tool
 * name (SPEC 9.6). The API stores tool results as `{ output, outcome }`; a bare `{ summary }` is accepted too. Times
 * in the text read in Pacific time ("settles Fri, Oct 30, 6:00 AM PT") and plain dates as days ("Nov 1, 2025 to Oct 26"),
 * never as raw ISO.
 */
export function stepSummary(s: RunStepRow): string {
  const r = s.result as { summary?: unknown; outcome?: { summary?: unknown; title?: unknown; refusal?: { message?: unknown } } } | null;
  const o = r && typeof r === "object" ? r.outcome : undefined;
  for (const v of [o?.summary, o?.title, o?.refusal?.message, r && typeof r === "object" ? r.summary : undefined]) {
    if (typeof v === "string" && v.trim()) return humanDates(humanTimes(v));
  }
  return toolLabel(s.toolName) ?? s.kind.replace("_", " ");
}
export function isChipStep(s: RunStepRow): boolean { return s.kind === "tool_call"; }
export function outcomeTone(o: RunStepRow["outcome"]): "ok" | "pending" | "refused" | "error" | "none" {
  if (!o) return "none";
  if (o === "ok") return "ok";
  if (o.startsWith("pending:")) return "pending";
  if (o.startsWith("refused:")) return "refused";
  return "error";
}

/** The proposal a step filed: its outcome is written once, as `pending:<proposalId>`, when the call files it. */
export function proposalIdOf(o: RunStepRow["outcome"]): string | null {
  return o && o.startsWith("pending:") ? o.slice("pending:".length) || null : null;
}

export type StepTone = "ok" | "pending" | "declined" | "refused" | "error" | "none";
/** How a decided proposal reads on its step line; the same words as the approval card's outcome. */
const DECIDED: Record<Exclude<ProposalStatus, "pending">, { tone: StepTone; note: string }> = {
  executed: { tone: "ok", note: "approved and done" },
  approved: { tone: "ok", note: "approved" },
  failed: { tone: "error", note: "approved, but it failed when it ran" },
  denied: { tone: "declined", note: "denied" },
  dismissed: { tone: "declined", note: "dismissed" },
  expired: { tone: "declined", note: "expired before anyone decided" },
  superseded: { tone: "declined", note: "replaced by a newer proposal" },
};

/**
 * A step's live state. The stored outcome is the call-time record and never changes, so a step that filed a proposal
 * reads the proposal's current status (from the run trace, or a decision the viewer just made) and says
 * "waiting for approval" only while nobody has decided it.
 */
export function stepState(o: RunStepRow["outcome"], statusOf: (proposalId: string) => ProposalStatus | undefined): { tone: StepTone; note: string | null; proposalId: string | null } {
  const proposalId = proposalIdOf(o);
  if (proposalId) {
    const live = statusOf(proposalId);
    if (live && live !== "pending") return { ...DECIDED[live], proposalId };
    return { tone: "pending", note: "waiting for approval", proposalId };
  }
  const tone = outcomeTone(o);
  const note = tone === "refused" ? `refused, ${o!.slice("refused:".length).toLowerCase().replaceAll("_", " ")}` : tone === "error" ? o : tone === "ok" ? "ok" : null;
  return { tone, note, proposalId: null };
}

/** Wave 3: a reports.query step's chart, inline when the result was small, else the artifact the executor saved. */
export type ReportRef = { stepN: number; report: ReportResult } | { stepN: number; artifactRef: string };
export function reportOf(s: RunStepRow): ReportRef | null {
  if (s.kind !== "tool_call" || toolLabel(s.toolName) !== "reports.query" || s.outcome !== "ok") return null;
  const o = (s.result as { outcome?: { ok?: boolean; data?: unknown; artifactRef?: string | null } } | null)?.outcome;
  if (!o?.ok) return null;
  const inline = ReportResult.safeParse(o.data);
  if (inline.success) return { stepN: s.n, report: inline.data };
  return typeof o.artifactRef === "string" && o.artifactRef.startsWith("art_") ? { stepN: s.n, artifactRef: o.artifactRef } : null;
}
export function ranToolsLine(steps: RunStepRow[]): string | null {
  const n = steps.filter(isChipStep).length;
  return n > 0 ? `Ran ${n} ${n === 1 ? "tool" : "tools"}` : null;
}
