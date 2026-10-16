// Learned preferences (harness 18 item 5): counts and the latest reason code per person and proposal kind,
// deterministic, reason codes only (notes are untrusted). Owner: w2-memory.
import { describe, expect, it } from "vitest";
import { approvalsDoc, type DecisionRow } from "../../src/memory/preferences";

const row = (p: Partial<DecisionRow>): DecisionRow => ({ deciderId: "usr_dana", deciderName: "Dana Whitfield", kind: "tax.update_rate", outcome: "approved", reasonCode: null, decidedAt: "2026-10-20T10:00:00.000Z", proposalId: "prp_0001", ...p });

describe("approval preferences", () => {
  it("counts outcomes per person and kind with the latest reason", () => {
    const d = approvalsDoc([
      row({ proposalId: "prp_0002", outcome: "denied", reasonCode: "wrong_rate", decidedAt: "2026-10-22T10:00:00.000Z" }),
      row({}),
      row({ deciderId: "usr_mika", deciderName: "Mika Tran", kind: "payroll.submit", proposalId: "prp_0003", decidedAt: "2026-10-21T10:00:00.000Z" }),
    ], "2026-10-26")!;
    expect(d.path).toBe("knowledge/preferences/approvals.md");
    expect(d.body).toContain("- tax.update_rate: approved 1, denied 1, edited 0, dismissed 0; latest denied (reason wrong_rate) (2026-10-22, src: proposal:prp_0002)");
    expect(d.body.indexOf("## Dana Whitfield (usr_dana)")).toBeLessThan(d.body.indexOf("## Mika Tran (usr_mika)"));
    expect(d.body).toContain("never changes permissions or grants");
    expect(d.frontmatter).toMatchObject({ type: "preference", updated: "2026-10-22" });
    expect(approvalsDoc([...[row({}), row({ proposalId: "prp_0002", outcome: "denied", decidedAt: "2026-10-22T10:00:00.000Z" })].reverse()], "x")!.body)
      .toBe(approvalsDoc([row({}), row({ proposalId: "prp_0002", outcome: "denied", decidedAt: "2026-10-22T10:00:00.000Z" })], "x")!.body);
    expect(approvalsDoc([], "2026-10-26")).toBeNull();
  });

  it("dates a decision by the company's calendar day, not the UTC one", () => {
    // 2026-10-23T02:30Z is Thu Oct 22, 7:30 PM PT.
    const d = approvalsDoc([row({ decidedAt: "2026-10-23T02:30:00.000Z" })], "2026-10-26")!;
    expect(d.body).toContain("latest approved (2026-10-22, src: proposal:prp_0001)");
    expect(d.frontmatter.updated).toBe("2026-10-22");
  });
});
