// The chart's range line and its partial month: one year reads once, a range across years keeps both, and the
// current month's bar is marked as to date (the tour's chart step and scenario 7).
import { describe, expect, it } from "vitest";
import { partialPeriod, rangeText } from "../src/components/app/agent/chart";

describe("chart range", () => {
  it("names the year once within a year and on both ends across years", () => {
    expect(rangeText("2026-01-01", "2026-10-26")).toBe("Jan 1 to Oct 26, 2026");
    expect(rangeText("2025-11-01", "2026-10-26")).toBe("Nov 1, 2025 to Oct 26, 2026");
  });
  it("marks the last period as to date only when the range stops inside it", () => {
    const rows = [{ period: "2026-09", period_label: "Sep 2026", period_end: "2026-09-30" }, { period: "2026-10", period_label: "Oct 2026", period_end: "2026-10-26" }];
    expect(partialPeriod({ to: "2026-10-26" }, rows)).toEqual({ key: "2026-10", label: "Oct 2026" });
    expect(partialPeriod({ to: "2026-09-30" }, rows.slice(0, 1))).toBeNull();
    expect(partialPeriod({ to: "2026-10-26" }, rows.slice(0, 1))).toBeNull();   // no row for the current month
  });
});
