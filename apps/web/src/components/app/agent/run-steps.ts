import type { RunStepRow } from "@weft/contracts";

/** Chip text for a step: the outcome summary when the tool returned one, else the tool name (SPEC 9.6). */
export function stepSummary(s: RunStepRow): string {
  const r = s.result as { summary?: unknown } | null;
  if (r && typeof r === "object" && typeof r.summary === "string") return r.summary;
  if (s.toolName) return s.toolName;
  return s.kind.replace("_", " ");
}
export function isChipStep(s: RunStepRow): boolean { return s.kind === "tool_call"; }
export function outcomeTone(o: RunStepRow["outcome"]): "ok" | "pending" | "refused" | "error" | "none" {
  if (!o) return "none";
  if (o === "ok") return "ok";
  if (o.startsWith("pending:")) return "pending";
  if (o.startsWith("refused:")) return "refused";
  return "error";
}
