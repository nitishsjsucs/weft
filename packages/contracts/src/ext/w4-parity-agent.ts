// Additive contracts for w4-parity-agent (docs/wave4.md section 7 rule 2). Owner: w4-parity-agent.
// The portal question box's response and test ids, shared by the route, the component and the GP20 e2e spec.

/** POST /v1/portal/agent/runs: the route table's { runId, threadId, handoffId } plus the topic, status and answer. */
export interface PortalAskResult {
  runId: string | null; threadId: string | null; handoffId: string | null;
  /** PortalTopic as classified by code. */
  topic: string;
  /** done, failed, refused, escalated or running (the run outlived the wait), or handed_off for a human-only topic. */
  status: string;
  /** The run's final answer (redacted), the fixed hand-off line, or null while the run is still going. */
  answer: string | null;
}

/** data-testid values of the portal question box (apps/web/src/components/portal/w4-ask.tsx). */
export const W4_ASK_TID = {
  section: "portal-ask", input: "portal-ask-input", submit: "portal-ask-submit", answer: "portal-ask-answer",
  handoff: "portal-ask-handoff", error: "portal-ask-error", suggestion: "portal-ask-suggestion",
} as const;
