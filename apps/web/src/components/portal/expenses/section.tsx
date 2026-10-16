"use client";
// Portal section (wave 3, docs/wave3.md). Owner: w3-expenses. My expenses: the employee's own claims with status, any
// note from the approver, and where each one is paid. The API scopes the list to the viewer's own worker.
import { Badge, Card, CardHeading, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { Receipt } from "lucide-react";
import type { W3ExpensesPage } from "../../../../../../packages/contracts/src/ext/w3-expenses";
import { useGet } from "@/lib/api/hooks";
import { CATEGORY_LABEL, STATUS_LABEL, STATUS_TONE, usd } from "../../app/expenses/labels";
import { fmtDate } from "../../app/format";

export function ExpensesPortalSection({ workerId }: { workerId: string; principal: string }) {
  const q = useGet("/v1/expenses", { query: { workerId, limit: 50 } });
  const rows = (q.data as W3ExpensesPage | undefined)?.data ?? [];
  if (!q.data || rows.length === 0) return null;
  return (
    <section data-testid="portal-expenses" className="mt-6">
      <CardHeading icon={<Receipt />}>My expenses</CardHeading>
      <Card className="overflow-hidden">
        <Table className="text-[13px]">
          <THead><TR><TH>Date</TH><TH>Category</TH><TH numeric>Amount</TH><TH>Status</TH></TR></THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.id} data-testid={`portal-expense-${r.id}`}>
                <TD className="h-10 whitespace-nowrap">{fmtDate(r.transactionDate)}</TD>
                <TD className="h-10">{CATEGORY_LABEL[r.category]}</TD>
                <TD numeric className="h-10 whitespace-nowrap">{usd(r.amountCents)}</TD>
                <TD className="h-10 whitespace-nowrap"><Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>{r.payrollRunId ? <span className="ml-2 text-1 text-gray-10">{r.status === "paid" ? "paid" : "pays"} on {r.payrollRunId}</span> : null}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      <p className="mt-2 text-1 text-gray-10">Reimbursements are paid with your regular pay, outside gross pay, so they are not taxed.</p>
    </section>
  );
}
