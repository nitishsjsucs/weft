// The routine run summary a person reads: proposals before writes, and a cut list says how many it left out.
import { describe, expect, it } from "vitest";
import { ROUTINE_SUMMARY_PARTS, routineSummary } from "../src/loop";

describe("routineSummary", () => {
  it("lists proposals first and appends 'and N more' past the cap", async () => {
    const writes = Array.from({ length: 8 }, (_, i) => ({ resultId: `res_${i}`, summary: "Saved 1 of 1 expense explanations", actionSeq: 10 + i }));
    const proposals = Array.from({ length: 8 }, (_, i) => ({ proposalId: `prp_000${i}`, title: `Decide expense ${i}` }));
    const s = await routineSummary(async () => [...writes, ...proposals]);
    const parts = s.split("; ");
    expect(parts.slice(0, ROUTINE_SUMMARY_PARTS).every((p) => p.startsWith("Proposed "))).toBe(true);
    expect(s.endsWith("; and 8 more")).toBe(true);
  });
  it("keeps a short list whole and says so when nothing changed", async () => {
    expect(await routineSummary(async () => [{ resultId: "res_1", summary: "Saved", actionSeq: 3 }, { proposalId: "prp_0001", title: "Update CA SUI" }])).toBe("Proposed Update CA SUI (prp_0001); Saved (#3)");
    expect(await routineSummary(async () => [])).toBe("Checked; nothing needed a change.");
  });
});
