// A run step that filed a proposal reads the proposal's live status: "waiting for approval" only until someone
// decides it, then the decision (the stored `pending:<id>` outcome is the call-time record and never changes).
import { describe, expect, it } from "vitest";
import type { ProposalStatus, RunStatus } from "@weft/contracts";
import { proposalIdOf, stepState } from "../src/components/app/agent/run-steps";
import { needsRefresh } from "../src/lib/api/sse";

const live = (m: Record<string, ProposalStatus>) => (id: string) => m[id];

describe("stepState", () => {
  it("waits only while the proposal is pending or not read yet", () => {
    expect(proposalIdOf("pending:prp_0021")).toBe("prp_0021");
    expect(proposalIdOf("ok")).toBeNull();
    expect(stepState("pending:prp_0021", live({}))).toEqual({ tone: "pending", note: "waiting for approval", proposalId: "prp_0021" });
    expect(stepState("pending:prp_0021", live({ prp_0021: "pending" })).note).toBe("waiting for approval");
  });

  it("shows the decision once the proposal is decided", () => {
    expect(stepState("pending:prp_0021", live({ prp_0021: "executed" }))).toEqual({ tone: "ok", note: "approved and done", proposalId: "prp_0021" });
    expect(stepState("pending:prp_0021", live({ prp_0021: "approved" })).note).toBe("approved");
    expect(stepState("pending:prp_0021", live({ prp_0021: "denied" }))).toMatchObject({ tone: "declined", note: "denied" });
    expect(stepState("pending:prp_0021", live({ prp_0021: "expired" }))).toMatchObject({ tone: "declined" });
    expect(stepState("pending:prp_0021", live({ prp_0021: "failed" }))).toMatchObject({ tone: "error" });
  });

  it("keeps the other outcomes as they were", () => {
    expect(stepState("ok", live({}))).toEqual({ tone: "ok", note: "ok", proposalId: null });
    expect(stepState("refused:UNAVAILABLE", live({}))).toMatchObject({ tone: "refused", note: "refused, unavailable" });
    expect(stepState(null, live({}))).toMatchObject({ tone: "none", note: null });
  });
});

describe("needsRefresh", () => {
  const run = (status: RunStatus) => ({ status }) as never;
  const trace = (statuses: ProposalStatus[]) => ({ proposals: statuses.map((status, i) => ({ id: `prp_${i}`, status })) }) as never;
  it("re-reads a run on a decision while it is unfinished or one of its proposals is undecided", () => {
    expect(needsRefresh({ run: run("waiting"), trace: null })).toBe(true);
    expect(needsRefresh({ run: run("done"), trace: trace(["pending"]) })).toBe(true);
    expect(needsRefresh({ run: run("done"), trace: trace(["executed"]) })).toBe(false);
    expect(needsRefresh({ run: null, trace: null })).toBe(false);
  });
});
