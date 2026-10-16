import type { Proposal } from "@weft/contracts";

/**
 * Who put a proposal in the Inbox, read from its proposer fields. A routine run outranks the agent run it started; an
 * agent run (or an agent suggestion, or an agent principal) is the agent; with no run at all the change came from the
 * principal it was made for, a person in the app (an off-cycle bonus, a routine they drafted).
 */
export type Proposer =
  | { kind: "routine"; routineRunId: string; runId: string | null }
  | { kind: "agent"; runId: string | null }
  | { kind: "person"; principalId: string }
  | { kind: "unknown" };

export function proposerOf(p: Pick<Proposal, "kind" | "proposerRunId" | "routineRunId" | "onBehalfOf">): Proposer {
  if (p.routineRunId) return { kind: "routine", routineRunId: p.routineRunId, runId: p.proposerRunId };
  if (p.proposerRunId || p.kind === "suggestion" || p.onBehalfOf?.startsWith("agt_")) return { kind: "agent", runId: p.proposerRunId };
  if (p.onBehalfOf) return { kind: "person", principalId: p.onBehalfOf };
  return { kind: "unknown" };
}

/** The heading over a proposal's free-text note (the `agentNote` field holds whoever's reason came with it). */
export function noteLabel(who: Proposer, nameOf: (principalId: string) => string): string {
  switch (who.kind) {
    case "agent": return "Note from the agent";
    case "routine": return "Note from the routine";
    case "person": return `Note from ${nameOf(who.principalId)}`;
    case "unknown": return "Note";
  }
}
