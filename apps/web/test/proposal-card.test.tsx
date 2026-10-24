// The Inbox card says who proposed a change: the agent, a routine or a named person (Vic's off-cycle bonus was
// labeled "Agent's note" although they wrote the reason themselves). Rendered to static markup, so no DOM is needed.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Proposal } from "@weft/contracts";
import { ProposalCard } from "../src/components/app/inbox/proposal-card";
import { noteLabel, proposerOf } from "../src/components/app/inbox/proposer";
import { principalName } from "../src/components/app/refs";

const base: Proposal = {
  id: "prp_0100", companyId: "cmp_larkspur", kind: "action", command: "payroll.propose_off_cycle", args: {}, argsHash: "h", subjectRef: "wrk_0042", subjectHash: "s",
  risk: "R4", moneyCents: 161_475, reversible: false, headline: "Off-cycle pay (bonus) for 1 worker", diff: [], content: [], evidence: [],
  agentNote: "bonus", taintedBy: null, proposerRunId: null, routineRunId: null, onBehalfOf: "usr_dana", supersedes: null,
  createdAt: "2026-10-26T15:30:00.000Z", expiresAt: "2026-10-29T15:30:00.000Z", status: "pending",
  decidedBy: null, decidedAt: null, decisionCode: null, decisionNote: null, executedActionSeq: null,
};

const DANA = principalName("usr_dana");
const card = (over: Partial<Proposal>) => renderToStaticMarkup(<ProposalCard p={{ ...base, ...over }} />);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

describe("proposerOf", () => {
  it("reads a person, the agent or a routine from the proposer fields", () => {
    expect(proposerOf(base)).toEqual({ kind: "person", principalId: "usr_dana" });
    expect(proposerOf({ ...base, proposerRunId: "run_0007" })).toEqual({ kind: "agent", runId: "run_0007" });
    expect(proposerOf({ ...base, proposerRunId: "run_0001", routineRunId: "rtr_0001" })).toEqual({ kind: "routine", routineRunId: "rtr_0001", runId: "run_0001" });
    expect(proposerOf({ ...base, routineRunId: "rtr_0002" })).toEqual({ kind: "routine", routineRunId: "rtr_0002", runId: null });
  });

  it("an agent suggestion or an agent principal is the agent even without a run; nothing recorded is unknown", () => {
    expect(proposerOf({ ...base, kind: "suggestion", onBehalfOf: null })).toEqual({ kind: "agent", runId: null });
    expect(proposerOf({ ...base, onBehalfOf: "agt_main" })).toEqual({ kind: "agent", runId: null });
    expect(proposerOf({ ...base, onBehalfOf: null })).toEqual({ kind: "unknown" });
  });

  it("labels the note by its author", () => {
    expect(noteLabel(proposerOf(base), principalName)).toBe(`Note from ${DANA}`);
    expect(noteLabel(proposerOf({ ...base, proposerRunId: "run_0007" }), principalName)).toBe("Note from the agent");
    expect(noteLabel(proposerOf({ ...base, proposerRunId: "run_0001", routineRunId: "rtr_0001" }), principalName)).toBe("Note from the routine");
    expect(noteLabel({ kind: "unknown" }, principalName)).toBe("Note");
  });
});

describe("ProposalCard proposer labels", () => {
  it("a person's off-cycle reason is that person's note, never the agent's, and the card names who proposed it", () => {
    const t = text(card({}));
    expect(DANA).toContain("Vic");
    expect(t).toContain(`Note from ${DANA} bonus`);
    expect(t).not.toMatch(/agent's note|note from the agent/i);
    expect(t).toContain(`Proposed by ${DANA}`);
    expect(t).not.toContain("No run recorded");
  });

  it("an agent run's note is the agent's, with a link to the run", () => {
    const html = card({ proposerRunId: "run_0007", agentNote: "Payroll has used 3.4% since Jan 1." });
    const t = text(html);
    expect(t).toContain("Note from the agent Payroll has used 3.4% since Jan 1.");
    expect(t).toContain("Proposed by Weft agent");
    expect(html).toContain('href="/app/runs/run_0007"');
  });

  it("a routine run's note is the routine's, with the routine run and a link to the agent run", () => {
    const html = card({ proposerRunId: "run_0001", routineRunId: "rtr_0001", agentNote: "Template reply." });
    const t = text(html);
    expect(t).toContain("Note from the routine Template reply.");
    expect(t).toContain("Proposed by Routine rtr_0001");
    expect(t).not.toMatch(/note from the agent/i);
    expect(html).toContain('href="/app/runs/run_0001"');
  });

  it("no note, no note block", () => {
    expect(text(card({ agentNote: null }))).not.toMatch(/Note from/);
  });
});
