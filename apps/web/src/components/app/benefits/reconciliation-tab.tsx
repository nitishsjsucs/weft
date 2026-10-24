"use client";
// Benefits > Reconciliation (wave 2, GP11). Owner: w2-benefits-contractors. Runs benefits.reconcile for a month and
// lists the findings with billed, expected and deducted amounts. Dispute sends the drafted carrier message through
// the email simulator; from this screen the click is the person's own decision, while an agent or API caller gets a
// proposal in the Inbox.
import Link from "next/link";
import { Fragment, useState } from "react";
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
const FINDING_LABEL: Record<string, string> = { open: "Open", disputed: "Disputed", resolved: "Resolved" };
const monthLabel = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
export const dollars = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function ReconciliationTab({ names, plans }: { names: Map<string, string>; plans: Map<string, string> }) {
  const [month, setMonth] = useState("2026-10");
  const q = useGet("/v1/benefits/reconciliation", { query: { month } });
  const rows = (q.data ?? []) as ReconFinding[];
  // A month not reconciled yet shows the month before it underneath, so the tab is never just an empty state.
  const prevMonth = (() => { const [y, m] = month.split("-").map(Number) as [number, number]; return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; })();
  const prev = useGet("/v1/benefits/reconciliation", { query: { month: prevMonth } });
  const prevRows = q.data && rows.length === 0 ? ((prev.data ?? []) as ReconFinding[]) : [];
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
        <span className="text-1 text-gray-10">Juniper Mutual invoice vs enrollments and that month&apos;s paycheck deductions.</span>
      </div>
      {err ? <div role="alert" className="mb-3 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(err)}</div> : null}
      {notice ? <div data-testid={TID.reconNotice} role="status" className="mb-3 rounded-lg bg-gray-3 px-3 py-2 text-1 text-gray-12">{notice}</div> : null}
      <CardHeading icon={<Scale />}>Findings{rows.length ? ` (${open.length} open${over ? `, ${dollars(over)} overbilled` : ""})` : ""}</CardHeading>
      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <div className="px-4 py-4 text-[13px]">
            <p className="text-gray-10">{!q.data ? "Loading..." : prevRows.length ? `${monthLabel(month)} is not reconciled yet. Run reconciliation to compare the carrier invoice.` : `No findings for ${month}. Run reconciliation to compare the carrier invoice.`}</p>
            {prevRows.length ? (
              <div data-testid="recon-previous" className="mt-3">
                <p className="mb-1.5 font-medium text-gray-12">{monthLabel(prevMonth)}: {prevRows.length} {prevRows.length === 1 ? "finding" : "findings"}</p>
                <ul className="flex flex-col gap-1.5">
                  {prevRows.map((f) => (
                    <li key={f.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-medium">{KIND_LABEL[f.kind] ?? f.kind}</span>
                      {f.workerId ? <Link href={`/app/people/${f.workerId}`} className="text-gray-11 hover:underline">{names.get(f.workerId) ?? f.workerId}</Link> : null}
                      <span className="tabular text-gray-10">billed {dollars(f.billedCents)}, expected {dollars(f.expectedCents)}</span>
                      <Badge tone={STATUS_TONE[f.status] ?? "gray"}>{FINDING_LABEL[f.status] ?? f.status}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid={TID.reconTable} className="text-[13px]">
              <THead><TR><TH>Finding</TH><TH>Person</TH><TH className="hidden tablet:table-cell">Plan</TH><TH numeric className="hidden tablet:table-cell">Billed</TH><TH numeric className="hidden tablet:table-cell">Expected</TH><TH numeric className="hidden tablet:table-cell">Deducted</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {rows.map((f) => (
                  <Fragment key={f.id}>
                    <TR data-testid={TID.reconRow(f.id)} data-kind={f.kind} className="border-b-0">
                      <TD className="h-10 font-medium">{KIND_LABEL[f.kind] ?? f.kind}</TD>
                      <TD className="h-10">{f.workerId ? <Link href={`/app/people/${f.workerId}`} className="hover:underline">{names.get(f.workerId) ?? f.workerId}</Link> : "-"}</TD>
                      <TD className="hidden h-10 tablet:table-cell">{f.planId ? plans.get(f.planId) ?? f.planId : "All billed plans"}</TD>
                      <TD numeric className="hidden h-10 tablet:table-cell">{dollars(f.billedCents)}</TD>
                      <TD numeric className="hidden h-10 tablet:table-cell">{dollars(f.expectedCents)}</TD>
                      <TD numeric className="hidden h-10 tablet:table-cell">{dollars(f.deductedCents)}</TD>
                      <TD className="h-10"><Badge tone={STATUS_TONE[f.status] ?? "gray"} data-status={f.status}>{FINDING_LABEL[f.status] ?? f.status}</Badge></TD>
                      <TD className="h-10 whitespace-nowrap text-right">
                        {f.status !== "open" ? null : confirm === f.id ? (
                          <span className="inline-flex items-center gap-1">
                            <Button data-testid={TID.reconDisputeConfirm} size="xs" variant="primary" disabled={dispute.pending} onClick={() => void onDispute(f.id)}>Send dispute</Button>
                            <Button size="xs" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
                          </span>
                        ) : <Button data-testid={TID.reconDispute(f.id)} size="xs" onClick={() => setConfirm(f.id)}>Dispute</Button>}
                      </TD>
                    </TR>
                    <TR>
                      <TD colSpan={8} className="max-w-[calc(100vw-2rem)] whitespace-normal pb-3 pt-0 text-1 text-gray-10 tablet:max-w-none">
                        {f.detail}
                        {confirm === f.id ? <span className="mt-1 block text-gray-11">Sends a templated dispute to billing@juniper-mutual.example and marks this finding disputed.</span> : null}
                      </TD>
                    </TR>
                  </Fragment>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
    </section>
  );
}
