"use client";
// Benefits > Reconciliation (wave 2, GP11). Owner: w2-benefits-contractors. Runs benefits.reconcile for a month and
// lists the findings with billed, expected and deducted amounts. Dispute sends the drafted carrier message through
// the email simulator; from this screen the click is the person's own decision, while an agent or API caller gets a
// proposal in the Inbox.
import Link from "next/link";
import { useState } from "react";
import { Scale } from "lucide-react";
import { Badge, Button, Card, CardHeading, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { W2_BENEFITS_TID as TID, type ReconFinding, type ToolOutcome } from "@weft/contracts";
import { client, errorText, useGet, useMutation } from "@/lib/api/hooks";

const KIND_LABEL: Record<string, string> = {
  terminated_but_billed: "Billed after last day",
  missing_dependent: "Missing dependent",
  wrong_tier: "Wrong tier",
  billed_not_enrolled: "Billed, not enrolled",
  enrolled_not_billed: "Enrolled, not billed",
  amount_mismatch: "Amount mismatch",
};
const STATUS_TONE: Record<string, "amber" | "blue" | "green" | "gray"> = { open: "amber", disputed: "blue", resolved: "green", dismissed: "gray" };
export const dollars = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function ReconciliationTab({ names, plans }: { names: Map<string, string>; plans: Map<string, string> }) {
  const [month, setMonth] = useState("2026-10");
  const q = useGet("/v1/benefits/reconciliation", { query: { month } });
  const rows = (q.data ?? []) as ReconFinding[];
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const run = useMutation(async () => (await client.post("/v1/benefits/reconciliation/run", { body: { month } })) as ToolOutcome);
  const dispute = useMutation(async (id: string) => (await client.post("/v1/tools/:name", { params: { name: "benefits.dispute_finding" }, body: { finding_id: id } })) as ToolOutcome);
  const onRun = async () => {
    const o = await run.run();
    if (o && o.ok && o.status === "done") setNotice(o.summary);
    q.reload();
  };
  const onDispute = async (id: string) => {
    const o = await dispute.run(id);
    setConfirm(null);
    if (o && o.ok) setNotice(o.status === "done" ? o.summary : `Proposal ${o.proposalId} is waiting in the Inbox`);
    q.reload();
  };
  const err = q.error ?? run.error ?? dispute.error;
  const open = rows.filter((r) => r.status === "open");
  const over = open.reduce((s, r) => s + Math.max(0, r.billedCents - r.expectedCents), 0);
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-[13px] text-gray-11">Invoice month
          <input data-testid={TID.reconMonth} type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="h-8 rounded-lg bg-card px-2 text-[13px] text-foreground shadow-[var(--shadow-border)]" />
        </label>
        <Button data-testid={TID.reconRun} size="sm" variant="primary" disabled={run.pending} onClick={() => void onRun()}>{run.pending ? "Reconciling..." : "Run reconciliation"}</Button>
        <span className="text-1 text-gray-10">Juniper Mutual (sim) invoice vs enrollments and that month&apos;s paycheck deductions.</span>
      </div>
      {err ? <div role="alert" className="mb-3 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(err)}</div> : null}
      {notice ? <div data-testid={TID.reconNotice} role="status" className="mb-3 rounded-lg bg-gray-3 px-3 py-2 text-1 text-gray-12">{notice}</div> : null}
      <CardHeading icon={<Scale />}>Findings{rows.length ? ` (${open.length} open${over ? `, ${dollars(over)} overbilled` : ""})` : ""}</CardHeading>
      <Card className="overflow-hidden">
        {rows.length === 0 ? <p className="px-4 py-4 text-[13px] text-gray-10">{q.data ? `No findings for ${month}. Run reconciliation to compare the carrier invoice.` : "Loading..."}</p> : (
          <div className="overflow-x-auto">
            <Table data-testid={TID.reconTable} className="text-[13px]">
              <THead><TR><TH>Finding</TH><TH>Person</TH><TH>Plan</TH><TH numeric>Billed</TH><TH numeric>Expected</TH><TH numeric>Deducted</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {rows.map((f) => (
                  <TR key={f.id} data-testid={TID.reconRow(f.id)} data-kind={f.kind}>
                    <TD className="py-2 align-top"><div className="font-medium">{KIND_LABEL[f.kind] ?? f.kind}</div><div className="max-w-[360px] text-1 text-gray-10">{f.detail}</div></TD>
                    <TD className="whitespace-nowrap py-2 align-top">{f.workerId ? <Link href={`/app/people/${f.workerId}`} className="hover:underline">{names.get(f.workerId) ?? f.workerId}</Link> : "-"}</TD>
                    <TD className="py-2 align-top">{f.planId ? plans.get(f.planId) ?? f.planId : "All billed plans"}</TD>
                    <TD numeric className="py-2 align-top">{dollars(f.billedCents)}</TD>
                    <TD numeric className="py-2 align-top">{dollars(f.expectedCents)}</TD>
                    <TD numeric className="py-2 align-top">{dollars(f.deductedCents)}</TD>
                    <TD className="py-2 align-top"><Badge tone={STATUS_TONE[f.status] ?? "gray"}>{f.status}</Badge></TD>
                    <TD className="whitespace-nowrap py-2 align-top">
                      {f.status !== "open" ? null : confirm === f.id ? (
                        <span className="flex items-center gap-1">
                          <Button data-testid={TID.reconDisputeConfirm} size="xs" variant="primary" disabled={dispute.pending} onClick={() => void onDispute(f.id)}>Send dispute</Button>
                          <Button size="xs" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
                        </span>
                      ) : <Button data-testid={TID.reconDispute(f.id)} size="xs" onClick={() => setConfirm(f.id)}>Dispute</Button>}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
      {confirm ? <p className="mt-2 text-1 text-gray-10">Sends a templated dispute for {confirm} to billing@juniper-mutual.example in the email simulator and marks the finding disputed.</p> : null}
    </section>
  );
}
