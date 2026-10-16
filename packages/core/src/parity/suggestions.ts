// Inbox suggestions written by parity commands (wave 3). Owner: w3-parity-routines. A suggestion is a proposal row of
// kind "suggestion": a person starts it (a chat run with its provenance) or dismisses it; it is never approved, never
// executes and posts no chat card. One pending suggestion per (command, subject): a newer one supersedes the older.
// proposer_run_id stays null so a pending suggestion never holds its routine run in waiting_approval; the routine run
// id and the evidence carry the provenance.
import { and, eq } from "drizzle-orm";
import { proposals, type DbTx } from "@weft/db";
import type { CommandDeps } from "../shared/deps";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";

export const SUGGESTION_TTL_MS = 72 * 3600_000;

export interface NewSuggestion {
  companyId: string; command: string; subjectRef: string; headline: string; content: { label: string; text: string }[];
  evidence: { label: string; ref: string }[]; domain: string; onBehalfOf: string | null; runId: string | null; routineRunId: string | null; taintedBy: string | null;
}

export async function upsertSuggestion(tx: DbTx, deps: Pick<CommandDeps, "newId">, now: string, s: NewSuggestion): Promise<{ id: string; supersedes: string | null }> {
  const prior = await tx.select({ id: proposals.id }).from(proposals)
    .where(and(eq(proposals.companyId, s.companyId), eq(proposals.kind, "suggestion"), eq(proposals.command, s.command), eq(proposals.subjectRef, s.subjectRef), eq(proposals.status, "pending")));
  let supersedes: string | null = null;
  for (const p of prior) {
    await tx.update(proposals).set({ status: "superseded", decidedAt: now, decisionCode: "SUPERSEDED" }).where(and(eq(proposals.id, p.id), eq(proposals.status, "pending")));
    supersedes = p.id;
  }
  const id = await deps.newId("prp_");
  const args = { subject: s.subjectRef };
  await tx.insert(proposals).values({
    id, companyId: s.companyId, kind: "suggestion", command: s.command, argsJson: JSON.stringify(args), argsHash: sha256Hex(canonicalJson(args)),
    subjectRef: s.subjectRef, subjectHash: sha256Hex(canonicalJson({ subject: s.subjectRef, content: s.content })), risk: null,
    headline: s.headline.slice(0, 200), diffJson: "[]", contentJson: JSON.stringify(s.content), evidenceJson: JSON.stringify(s.evidence),
    agentNote: null, taintedBy: s.taintedBy, proposerRunId: null, routineRunId: s.routineRunId, onBehalfOf: s.onBehalfOf, domain: s.domain,
    moneyCents: null, reversible: true, supersedes, createdAt: now, expiresAt: new Date(Date.parse(now) + SUGGESTION_TTL_MS).toISOString(),
    status: "pending", decidedBy: null, decidedAt: null, decisionCode: null, decisionNote: null, executedActionSeq: null,
  });
  return { id, supersedes };
}
