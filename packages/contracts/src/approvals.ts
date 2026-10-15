// Copied verbatim from research/harness.md section 13 (approvals.ts).
import type { RiskClass, Preview, ToolOutcome, HumanSession } from "./commands";
export type ProposalKind = "action" | "secret_request" | "routine_enable" | "suggestion";
export type ProposalStatus = "pending" | "approved" | "denied" | "expired" | "executed" | "failed" | "superseded" | "dismissed";

export interface Proposal {
  id: string; companyId: string; kind: ProposalKind;
  command: string | null; args: unknown | null; argsHash: string | null;
  subjectRef: string | null; subjectHash: string | null;
  risk: RiskClass | null; moneyCents: number | null; reversible: boolean;
  headline: string;                    // Preview.title
  diff: Preview["diff"]; content: Preview["content"]; evidence: Preview["evidence"];
  agentNote: string | null;            // plain text, <= 600 chars
  taintedBy: string | null;
  proposerRunId: string | null; routineRunId: string | null; onBehalfOf: string | null;
  supersedes: string | null;
  createdAt: string; expiresAt: string; status: ProposalStatus;
  decidedBy: string | null; decidedAt: string | null; decisionCode: string | null; decisionNote: string | null;
  executedActionSeq: number | null;    // unique
}

export type DecisionRefusal = "NOT_PENDING" | "AGENT_PRINCIPAL" | "SELF_APPROVAL" | "WRONG_ROLE" | "STALE_SUBJECT" | "EXPIRED" | "UI_SESSION_REQUIRED";
export interface DecisionInput { proposalId: string; decision: "approve" | "deny" | "dismiss" | "start"; reasonCode: string | null; note: string | null; session: HumanSession }
export type DecisionResult = { ok: true; proposal: Proposal; outcome: ToolOutcome | null } | { ok: false; code: DecisionRefusal; message: string };
/** Wake payload for the brain: structured only, never the free-text note. */
export interface ProposalDecided { proposalId: string; runId: string | null; status: ProposalStatus; actionSeq: number | null; deciderRole: string; reasonCode: string | null }
