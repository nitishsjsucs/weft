// Expense totals for agent reads (wave 4 fix group read-figures). People ask what the claims come to overall, per
// person, per category, per band or per pay run. The grounding check accepts a money figure only when a tool result
// holds it, and the model must never add amounts itself (harness 4.8: derived numbers come from tools), so
// expenses.list returns those sums as integer cents plus a display string: the overall total of the filtered rows
// always, and each grouping the call asks for with totals_by (so the default read stays under the observation cap).
import { ExpenseBand, formatCents } from "@weft/contracts";
import { bandOf, type ExpenseRow } from "./store";

export const EXPENSE_TOTALS_BY = ["worker", "category", "band", "payroll_run"] as const;
export type ExpenseTotalsBy = (typeof EXPENSE_TOTALS_BY)[number];

export interface MoneySum { count: number; amount_cents: number; amount_display: string }
export const sumOf = (rows: readonly Pick<ExpenseRow, "amountCents">[]): MoneySum => {
  const cents = rows.reduce((s, r) => s + r.amountCents, 0);
  return { count: rows.length, amount_cents: cents, amount_display: formatCents(cents) };
};

/** Groups rows by key; entries sort by amount, largest first, then by key, so the order is stable. */
function groupSums(rows: readonly ExpenseRow[], key: (r: ExpenseRow) => string): [string, MoneySum][] {
  const m = new Map<string, ExpenseRow[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return [...m.entries()].map(([k, rs]) => [k, sumOf(rs)] as [string, MoneySum]).sort(([a, x], [b, y]) => y.amount_cents - x.amount_cents || (a < b ? -1 : a > b ? 1 : 0));
}

export interface TotalsLookups { workerRef(workerId: string): string; payday(runId: string): string | null }

/**
 * The sums of one expenses.list result: `totals` over every row, then `by_<key>` for each requested grouping. By band
 * lists every band (zero included); by pay run lists only rows attached to a run, with that run's payday.
 */
export function expenseTotals(rows: readonly ExpenseRow[], by: readonly ExpenseTotalsBy[], look: TotalsLookups): { totals: MoneySum } & Record<string, unknown> {
  const out: { totals: MoneySum } & Record<string, unknown> = { totals: sumOf(rows) };
  for (const k of EXPENSE_TOTALS_BY.filter((x) => by.includes(x))) {
    if (k === "worker") out.by_worker = groupSums(rows, (r) => r.workerId).map(([id, s]) => ({ worker: look.workerRef(id), ...s }));
    if (k === "category") out.by_category = groupSums(rows, (r) => r.category).map(([category, s]) => ({ category, ...s }));
    if (k === "band") out.by_band = ExpenseBand.options.map((band) => ({ band, ...sumOf(rows.filter((r) => bandOf(r.status) === band)) }));
    if (k === "payroll_run") out.by_payroll_run = groupSums(rows.filter((r) => r.payrollRunId !== null), (r) => r.payrollRunId!).map(([id, s]) => ({ payroll_run_id: id, payday: look.payday(id), ...s }));
  }
  return out;
}
