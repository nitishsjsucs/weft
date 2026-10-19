// Narrow cards: a before and after pair never breaks around its "to", and a row that changes nothing is left out.
import { describe, expect, it } from "vitest";
import { idleMoneyRow, splitChange } from "../src/components/app/card-rows";
import { splitColumns, tableColumns } from "../src/components/app/reports/reports-view";

describe("card rows", () => {
  it("splits a change into two unbreakable halves", () => {
    expect(splitChange("$356.01 to $157.06")).toEqual(["$356.01", "to $157.06"]);
    expect(splitChange("Draft → Submitted")).toEqual(["Draft", "→ Submitted"]);
    expect(splitChange("$5,489.93")).toBeNull();
    expect(splitChange("Receipts over $75 need an itemized receipt to be attached to the claim")).toBeNull();
  });
  it("drops a payroll row that goes from unscheduled to unpaid", () => {
    expect(idleMoneyRow("not scheduled", "not paid")).toBe(true);
    expect(idleMoneyRow("Not scheduled", "not paid")).toBe(true);
    expect(idleMoneyRow("not scheduled", "pr_2026_10_30, reimbursement outside gross")).toBe(false);
  });
});

describe("reports table columns", () => {
  const chart = { x: { key: "period", label: "Month" }, series: [{ key: "gross_cents", label: "Gross pay", unit: "cents" }, { key: "employer_taxes_cents", label: "Employer taxes", unit: "cents" }] } as never;
  const rows = [{ period: "2026-10", period_label: "Oct 2026 (to date)", period_start: "2026-10-01", period_end: "2026-10-26", to_date: 1, runs: 2, workers_paid: 47, hires: 1, departures: 0, gross_cents: 1, employer_taxes_cents: 2, total_cents: 3, total_display: "$0.03" }];
  it("puts the total first, never shows the to-date flag, and moves the counts to their own table", () => {
    const cols = tableColumns(chart, rows);
    expect(cols.map((c) => c.key)).toEqual(["total_cents", "gross_cents", "employer_taxes_cents", "runs", "workers_paid", "hires", "departures"]);
    const { main, counts } = splitColumns(chart, cols);
    expect(main.map((c) => c.key)).toEqual(["total_cents", "gross_cents", "employer_taxes_cents"]);
    expect(counts.map((c) => c.key)).toEqual(["runs", "workers_paid", "hires", "departures"]);
  });
});
