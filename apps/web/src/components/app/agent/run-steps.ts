import type { RunStepRow } from "@weft/contracts";
import { humanTimes } from "../format";

/** Tool names arrive in wire form (`payroll__explain_flags`); the UI shows the dotted command name. */
export function toolLabel(name: string | null): string | null {
  return name ? name.replace(/__/g, ".") : null;
}

/**
 * Chip text for a step: the tool outcome's summary (or a proposal's title) when the tool returned one, else the tool
 * name (SPEC 9.6). The API stores tool results as `{ output, outcome }`; a bare `{ summary }` is accepted too. Times
 * in the text read in Pacific time ("settles Fri, Oct 30, 6:00 AM PT"), never as raw ISO.
 */
export function stepSummary(s: RunStepRow): string {
  const r = s.result as { summary?: unknown; outcome?: { summary?: unknown; title?: unknown; refusal?: { message?: unknown } } } | null;
  const o = r && typeof r === "object" ? r.outcome : undefined;
  for (const v of [o?.summary, o?.title, o?.refusal?.message, r && typeof r === "object" ? r.summary : undefined]) {
    if (typeof v === "string" && v.trim()) return humanTimes(v);
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
