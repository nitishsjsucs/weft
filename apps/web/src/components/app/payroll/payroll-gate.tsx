"use client";
// Payroll for people whose grants close it (a manager has payroll: none): the API refuses every pay run and paycheck
// read for them, so the page says so plainly instead of showing an error or the Run review now and Submit controls.
import type { ReactNode } from "react";
import { DomainGate } from "../domain-gate";

export function PayrollGate({ children }: { children: ReactNode }) {
  return <DomainGate domain="payroll" title="Payroll" subtitle="Pay runs and paychecks are not shared with your role. A payroll admin can answer questions about pay." testid="payroll-no-access">{children}</DomainGate>;
}
