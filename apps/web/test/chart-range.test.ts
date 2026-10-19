// The chart's range line and its partial month: one year reads once, a range across years keeps both, and the
// current month's bar is marked as to date (the tour's chart step and scenario 7).
import { describe, expect, it } from "vitest";
import { compactColumns, partialPeriod, periodLabel, rangeText, tickLabel, tickStep } from "../src/components/app/agent/chart";

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

describe("chart ticks", () => {
  const spec = { x: { key: "period", label: "Month" } } as never;
  const row = (p: string, l: string) => ({ period: p, period_label: l });
  it("names the month alone within a year and marks the partial period with an asterisk", () => {
    expect(tickLabel(spec, row("2026-09", "Sep 2026"), true, { key: "2026-10" })).toBe("Sep");
    expect(tickLabel(spec, row("2026-10", "Oct 2026 (to date)"), true, { key: "2026-10" })).toBe("Oct*");
    expect(tickLabel(spec, row("2025-11", "Nov 2025"), false)).toBe("Nov 2025");
    expect(periodLabel(spec, row("2026-10", "Oct 2026 (to date)"), { key: "2026-10" })).toBe("Oct 2026 (to date)");
    expect(partialPeriod({ to: "2026-10-26" }, [{ period: "2026-10", period_label: "Oct 2026 (to date)", period_end: "2026-10-26" }])).toEqual({ key: "2026-10", label: "Oct 2026" });
  });
  it("labels every tick when the band holds a label, else every other one counted back from the last", () => {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct*"];
    expect(tickStep(months, 545)).toBe(1);   // the Reports page at 1280
    expect(tickStep(months, 221)).toBe(2);   // the agent panel
    expect(tickStep([], 200)).toBe(1);
    expect(tickStep(Array.from({ length: 24 }, () => "Nov 2025"), 0)).toBe(3);   // long range, before the first measure
  });
  it("keeps the panel's table to the period, two series and their total", () => {
    const s = (key: string) => ({ key, label: key, unit: "cents" as const });
    expect(compactColumns({ kind: "stacked_bar", series: [s("a"), s("b"), s("c")] } as never).map((c) => c.key)).toEqual(["a", "b", "__total"]);
    expect(compactColumns({ kind: "line", series: [s("a"), s("b"), s("c")] } as never).map((c) => c.key)).toEqual(["a", "b"]);
  });
});
