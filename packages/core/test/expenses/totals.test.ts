// Expense totals for agent reads (fix group read-figures): per person, category, band and pay run, as cents plus a
// display string, so an answer quotes a sum from the result instead of adding amounts itself.
import { describe, expect, it } from "vitest";
import { EXPENSE_TOTALS_BY, expenseTotals } from "../../src/expenses/totals";
import type { ExpenseRow } from "../../src/expenses/store";

const row = (id: string, workerId: string, category: string, amountCents: number, status: string, payrollRunId: string | null = null) =>
  ({ id, workerId, category, amountCents, status, payrollRunId }) as unknown as ExpenseRow;
const ROWS = [
  row("exp_1", "wrk_a", "travel", 52_010, "needs_review"),
  row("exp_2", "wrk_b", "meals", 8_640, "needs_review"),
  row("exp_3", "wrk_a", "mileage", 7_125, "needs_review"),
  row("exp_4", "wrk_c", "travel", 6_450, "scheduled", "pay_2"),
  row("exp_5", "wrk_b", "meals", 2_300, "paid", "pay_1"),
  row("exp_6", "wrk_c", "office", 3_275, "scheduled", "pay_2"),
];
const look = { workerRef: (id: string) => `Name ${id} (${id})`, payday: (id: string) => (id === "pay_1" ? "2026-10-15" : id === "pay_2" ? "2026-10-30" : null) };

describe("expenseTotals", () => {
  it("always returns the overall total of the rows it was given, and nothing else unless asked", () => {
    expect(expenseTotals(ROWS, [], look)).toEqual({ totals: { count: 6, amount_cents: 79_800, amount_display: "$798.00" } });
    expect(expenseTotals([], [], look)).toEqual({ totals: { count: 0, amount_cents: 0, amount_display: "$0.00" } });
  });

  it("sums per worker and per category, largest first, with the worker's name and short id", () => {
    const t = expenseTotals(ROWS, ["worker", "category"], look);
    expect(t.by_worker).toEqual([
      { worker: "Name wrk_a (wrk_a)", count: 2, amount_cents: 59_135, amount_display: "$591.35" },
      { worker: "Name wrk_b (wrk_b)", count: 2, amount_cents: 10_940, amount_display: "$109.40" },
      { worker: "Name wrk_c (wrk_c)", count: 2, amount_cents: 9_725, amount_display: "$97.25" },
    ]);
    expect((t.by_category as { category: string; amount_display: string }[]).map((c) => [c.category, c.amount_display])).toEqual([["travel", "$584.60"], ["meals", "$109.40"], ["mileage", "$71.25"], ["office", "$32.75"]]);
  });

  it("lists every band, zero included, and per pay run only the rows a run carries, with its payday", () => {
    const t = expenseTotals(ROWS, ["band", "payroll_run"], look);
    expect((t.by_band as { band: string; count: number; amount_display: string }[]).map((b) => [b.band, b.count, b.amount_display])).toEqual([
      ["needs_review", 3, "$677.75"], ["approved", 2, "$97.25"], ["paid_out", 1, "$23.00"], ["declined", 0, "$0.00"],
    ]);
    expect(t.by_payroll_run).toEqual([
      { payroll_run_id: "pay_2", payday: "2026-10-30", count: 2, amount_cents: 9_725, amount_display: "$97.25" },
      { payroll_run_id: "pay_1", payday: "2026-10-15", count: 1, amount_cents: 2_300, amount_display: "$23.00" },
    ]);
  });

  it("groupings come in a fixed order whatever order the call names them in", () => {
    expect(Object.keys(expenseTotals(ROWS, ["payroll_run", "worker"], look))).toEqual(["totals", "by_worker", "by_payroll_run"]);
    expect(Object.keys(expenseTotals(ROWS, [...EXPENSE_TOTALS_BY].reverse(), look))).toEqual(["totals", "by_worker", "by_category", "by_band", "by_payroll_run"]);
  });

  it("no grouping value is id shaped, so the executor never reads it as a record reference", () => {
    for (const v of EXPENSE_TOTALS_BY) expect(v).not.toMatch(/^[a-z]{2,5}_[A-Za-z0-9_]+$/);
  });
});
