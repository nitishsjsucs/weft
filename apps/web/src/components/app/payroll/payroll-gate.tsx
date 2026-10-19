"use client";
// Payroll for people whose grants close it (a manager has payroll: none): the API refuses every pay run and paycheck
// read for them, so the page says so plainly instead of showing an error or the Run review now and Submit controls.
import type { ReactNode } from "react";
import { useCan } from "@/lib/api/access";
import { PageBody, PageHeader } from "../page";

export function PayrollGate({ children }: { children: ReactNode }) {
  const can = useCan();
  if (can("payroll")) return <>{children}</>;
  return (
    <PageBody width="narrow">
      <div data-testid="payroll-no-access">
        <PageHeader title="Payroll" subtitle="Pay runs and paychecks are not shared with your role. A payroll admin can answer questions about pay." />
      </div>
    </PageBody>
  );
}
