"use client";
import { useState } from "react";
import { Button, Drawer } from "@weft/ui/components";
import { TID, TOTALS_FIELDS, type Totals } from "@weft/contracts";

export const TOTAL_LABEL: Record<(typeof TOTALS_FIELDS)[number], string> = {
  cashRequirement: "Cash requirement", grossPay: "Gross pay", netPay: "Net pay", reimbursements: "Reimbursements", workerTaxes: "Employee taxes",
  employerTaxes: "Company taxes", preTaxDeductions: "Pre-tax deductions", postTaxDeductions: "Post-tax deductions", workerBenefitContributions: "Employee benefit contributions",
  employerBenefitContributions: "Company benefit contributions", transactionFees: "Transaction fees (sim ACH)", totalCost: "Total cost",
};
const STRIP: (typeof TOTALS_FIELDS)[number][] = ["cashRequirement", "grossPay", "employerTaxes", "netPay"];

/**
 * What the totals count. They count every paycheck in the run, a blocked one too, while the submit leaves a blocked
 * paycheck out; the note says so by name, so "excluded as blocked" on the banner never reads as missing from these.
 */
export function totalsNote(count: number, blockedNames: string[]): string {
  const n = `${count} ${count === 1 ? "paycheck" : "paychecks"}`;
  if (!blockedNames.length) return `${n}.`;
  const who = blockedNames.length === 1 ? `${blockedNames[0]}'s blocked one` : `${blockedNames.length} blocked ones (${blockedNames.join(", ")})`;
  return `${n}, including ${who}. The submit leaves ${blockedNames.length === 1 ? "it" : "them"} out.`;
}

/** Totals strip (4 headline fields) with all 12 fields in a drawer (SPEC 7.4). */
export function TotalsStrip({ totals, count, blockedNames = [] }: { totals: Totals | null; count: number; blockedNames?: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="@container mb-6">
    <div data-testid={TID.payrollTotals} className="grid grid-cols-2 overflow-hidden rounded-xl border border-[var(--app-border)] bg-card shadow-xs @min-[820px]:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
      {STRIP.map((k, i) => (
        <div key={k} data-total={k} data-amount={totals?.[k].amount ?? ""} className={`flex min-w-0 flex-col gap-0.5 px-4 py-3 ${i % 2 ? "border-l" : ""} ${i >= 2 ? "border-t @min-[820px]:border-t-0" : ""} border-[var(--app-border)] @min-[820px]:border-l @min-[820px]:first:border-l-0`}>
          <span className="truncate text-1 text-gray-10">{TOTAL_LABEL[k]}</span>
          <span className="truncate text-4 font-semibold tabular">{totals ? totals[k].display : "-"}</span>
        </div>
      ))}
      <div className="col-span-2 flex items-center justify-center border-t border-[var(--app-border)] px-3 py-2 @min-[820px]:col-span-1 @min-[820px]:border-t-0 @min-[820px]:border-l">
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>All 12 totals</Button>
      </div>
      <Drawer open={open} onOpenChange={setOpen} title="Run totals" description={totalsNote(count, blockedNames)}>
        <dl data-testid="payroll-totals-all" className="flex flex-col">
          {TOTALS_FIELDS.map((k) => (
            <div key={k} data-total={k} data-amount={totals?.[k].amount ?? ""} className="flex items-center justify-between gap-3 border-b border-[var(--app-border)] py-2.5 text-2">
              <dt className="text-gray-11">{TOTAL_LABEL[k]}</dt>
              <dd className="font-medium tabular">{totals ? totals[k].display : "-"}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-1 text-gray-10">Net pay = gross pay - employee taxes - pre-tax and post-tax deductions. Total cost = gross pay + reimbursements + company taxes + company benefits + fees. Cash requirement equals total cost because Weft remits every deduction in the simulator.</p>
      </Drawer>
    </div>
    </div>
  );
}
