// One decide call for every surface that shows a proposal (the Inbox card, the agent panel card, the chat simulator
// card): the same POST /v1/proposals/:id/<decision> route, so decide() runs once per click and the CAS in harness 5.5
// guards double clicks and races between surfaces.
import type { DecisionResult } from "@weft/contracts";
import { client } from "@/lib/api/hooks";

export type Decision = "approve" | "deny" | "dismiss" | "start";
export function decideProposal(id: string, decision: Decision, body?: { reasonCode: string | null; note: string | null }): Promise<DecisionResult> {
  return client.post(`/v1/proposals/:id/${decision}` as "/v1/proposals/:id/approve", { params: { id }, body: body ?? {} }) as Promise<DecisionResult>;
}
