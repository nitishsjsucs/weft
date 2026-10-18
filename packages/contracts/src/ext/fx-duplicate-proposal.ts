// Additive contracts for the duplicate-proposal fix group (wave 4 follow-up, docs/evals/model-comparison.md "Failures
// common to every setup"). Owner: fix/duplicate-proposal.
//
// The executor's equivalent-proposal check: a gated call whose command, subject and arguments match a proposal that is
// still open, or that a person decided recently, files nothing new. An open match comes back as the existing proposal
// (the pending_approval envelope plus `existing` and `note`, which the model reads in the function output); a recent
// decision comes back as a DOMAIN_DUPLICATE_PROPOSAL refusal that names the proposal, its status and when it was decided.
import type { ToolOutcome } from "../commands";

/** The refusal code for a call that repeats a proposal a person approved, executed, denied or dismissed recently. */
export const DUPLICATE_PROPOSAL_CODE = "DOMAIN_DUPLICATE_PROPOSAL" as const;

/** The pending_approval envelope for a call that matched an open proposal: proposalId is that proposal's id. */
export type ExistingProposalOutcome = Extract<ToolOutcome, { status: "pending_approval" }> & { existing: true; note: string };

export function isExistingProposalOutcome(o: unknown): o is ExistingProposalOutcome {
  return !!o && typeof o === "object" && (o as { status?: unknown }).status === "pending_approval" && (o as { existing?: unknown }).existing === true;
}
