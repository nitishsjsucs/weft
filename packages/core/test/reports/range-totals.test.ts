// reports.query range totals (wave 3 integration, round 2). Live L7 asked for payroll cost by month; the model added
// the two months itself and the grounding check rejected the sum. The command now returns the range total of every
// money column, so the total a person asks for is a tool result and grounds.
import { describe, expect, it } from "vitest";
import { check } from "@weft/grounding";
import { rangeTotals } from "../../src/commands/reports";

const rows = [
  { period: "2026-09", gross_cents: 47_135_792, total_cents: 51_890_296, total_display: "$518,902.96", headcount: 48 },
  { period: "2026-10", gross_cents: 24_334_563, total_cents: 26_798_455, total_display: "$267,984.55", headcount: 47 },
];

describe("reports.query range_totals", () => {
  it("sums only the money columns, with display strings", () => {
    expect(rangeTotals(rows)).toEqual({ gross_cents: 71_470_355, gross_display: "$714,703.55", total_cents: 78_688_751, total_display: "$786,887.51" });
    expect(rangeTotals([])).toEqual({});
  });

  it("a sum the model quotes grounds against range_totals, and is refused without it", () => {
    const answer = "September cost $518,902.96 and October $267,984.55, so $786,887.51 in total.";
    expect(check(answer, [{ data: { rows } }]).offending).toEqual(["$786,887.51"]);
    expect(check(answer, [{ data: { rows, range_totals: rangeTotals(rows) } }]).ok).toBe(true);
  });
});
