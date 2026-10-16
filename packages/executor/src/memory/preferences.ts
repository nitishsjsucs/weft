// Learned preferences (harness 18 item 5, Instinct's instinct/ folder): knowledge/preferences/approvals.md records,
// deterministically from decisions, which proposal kinds each person approves, denies, edits or dismisses, with
// counts and the latest reason code. It informs proposals only; it never changes permissions or grants. Human
// decision notes are untrusted free text, so only the structured reason code is kept. Decisions are dated by the
// company's calendar day (memory/time.ts).
import type { MemoryFrontmatter } from "@weft/contracts";
import type { DossierDoc } from "./dossiers";
import { companyDay } from "./time";

export const APPROVALS_PATH = "knowledge/preferences/approvals.md";
export type DecisionOutcome = "approved" | "denied" | "edited" | "dismissed";

export interface DecisionRow { deciderId: string; deciderName: string; kind: string; outcome: DecisionOutcome; reasonCode: string | null; decidedAt: string; proposalId: string }

const OUTCOMES: DecisionOutcome[] = ["approved", "denied", "edited", "dismissed"];
const safe = (s: string) => s.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 60);

export function approvalsDoc(rows: DecisionRow[], fallbackDate: string): DossierDoc | null {
  if (rows.length === 0) return null;
  const byPerson = new Map<string, DecisionRow[]>();
  for (const r of [...rows].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt) || a.proposalId.localeCompare(b.proposalId))) {
    byPerson.set(r.deciderId, [...(byPerson.get(r.deciderId) ?? []), r]);
  }
  const lines: string[] = ["# Approval preferences (learned)", "", "Counts of decisions by person and proposal kind. This informs proposals only; it never changes permissions or grants.", ""];
  const facts: { text: string; sourceRef: string }[] = [];
  for (const id of [...byPerson.keys()].sort()) {
    const mine = byPerson.get(id)!;
    lines.push(`## ${mine[0]!.deciderName.replace(/[[\]#\n]/g, "")} (${safe(id)})`, "");
    const kinds = [...new Set(mine.map((r) => r.kind))].sort();
    for (const k of kinds) {
      const rs = mine.filter((r) => r.kind === k);
      const counts = OUTCOMES.map((o) => `${o} ${rs.filter((r) => r.outcome === o).length}`).join(", ");
      const last = rs.at(-1)!;
      const text = `${safe(k)}: ${counts}; latest ${last.outcome}${last.reasonCode ? ` (reason ${safe(last.reasonCode)})` : ""}`;
      lines.push(`- ${text} (${companyDay(last.decidedAt)}, src: proposal:${safe(last.proposalId)})`);
      facts.push({ text, sourceRef: `proposal:${last.proposalId}` });
    }
    lines.push("");
  }
  const updated = rows.map((r) => companyDay(r.decidedAt)).sort().at(-1) ?? fallbackDate;
  const frontmatter: MemoryFrontmatter = { id: "pref-approvals", type: "preference", aliases: ["approval preferences"], links: [], sources: [...new Set(rows.map((r) => `proposal:${r.proposalId}`))].sort().slice(0, 40), status: null, updated, taintedBy: null };
  return { subjectRef: null, path: APPROVALS_PATH, frontmatter, body: lines.join("\n"), facts: facts.slice(0, 40) };
}
