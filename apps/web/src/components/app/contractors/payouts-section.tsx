"use client";
// Contractors > Payouts (wave 2, GP11). Owner: w2-benefits-contractors. Lists payouts with the fixed FX conversion and
// the payment rail status (pending, sent, delivered on the sim clock), the FX table, and schedules the month's
// payouts for every active contractor. From this screen the click is the person's own decision; an agent or API
// caller gets a proposal in the Inbox.
import { useState } from "react";
import { ArrowLeftRight, Banknote } from "lucide-react";
import { Badge, Button, Card, CardHeading, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { W2_BENEFITS_TID as TID, type ContractorPayout, type ToolOutcome, type Worker } from "@weft/contracts";
import { client, errorText, useGet, useMutation } from "@/lib/api/hooks";
import { fmtDate, fmtDateTime, longDate } from "../format";

const TONE: Record<string, "amber" | "blue" | "green" | "red"> = { pending: "amber", sent: "blue", delivered: "green", returned: "red" };
const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const minor = (m: number, cur: string) => `${(m / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
const when = (iso: string | null) => (iso ? fmtDateTime(iso) : "-");

/** The last business day of the sim month (the global monthly payday). */
function monthEnd(nowIso: string | undefined): string {
  const d = nowIso ? new Date(nowIso) : new Date(Date.UTC(2026, 9, 26));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  while (end.getUTCDay() === 0 || end.getUTCDay() === 6) end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

export function PayoutsSection({ contractors }: { contractors: Worker[] }) {
  const q = useGet("/v1/contractors/payouts", { query: { limit: 100 }, refreshMs: 5_000 });
  const fx = useGet("/v1/contractors/fx");
  const clock = useGet("/v1/sim/clock");
  const rows = ((q.data as { data?: ContractorPayout[] } | undefined)?.data ?? []);
  const rates = (fx.data ?? []) as { currency: string; usdPerUnit: string; asOf: string; source: string }[];
  const names = new Map(contractors.map((w) => [w.id, w.displayName]));
  const [notice, setNotice] = useState<string | null>(null);
  const payday = monthEnd(clock.data?.now);
  const active = contractors.filter((w) => w.status === "active").map((w) => w.id);
  const already = rows.some((r) => r.scheduledFor === payday);
  const schedule = useMutation(async () => (await client.post("/v1/contractors/payouts", { body: { workerIds: active, scheduledFor: payday } })) as ToolOutcome);
  const onSchedule = async () => { const o = await schedule.run(); if (o && o.ok) setNotice(o.status === "done" ? o.summary : `Proposal ${o.proposalId} is waiting in the Inbox`); q.reload(); };
  const err = q.error ?? fx.error ?? schedule.error;
  return (
    <div className="mt-6 flex flex-col gap-6 [&>section]:min-w-0">
      {err ? <div role="alert" className="rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(err)}</div> : null}
      {notice ? <div role="status" className="rounded-lg bg-gray-3 px-3 py-2 text-1 text-gray-12">{notice}</div> : null}
      <section>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <CardHeading icon={<Banknote />}>Payouts</CardHeading>
          <Button data-testid={TID.payoutsSchedule} size="sm" variant="primary" className="ml-auto" disabled={schedule.pending || already || active.length === 0} onClick={() => void onSchedule()}>
            {already ? `Scheduled for ${fmtDate(payday)}` : `Pay ${active.length} contractor${active.length === 1 ? "" : "s"} on ${fmtDate(payday)}`}
          </Button>
        </div>
        <Card className="overflow-hidden">
          {rows.length === 0 ? <p className="px-4 py-4 text-[13px] text-gray-10">{q.data ? "No payouts yet." : "Loading..."}</p> : (
            <div className="overflow-x-auto">
              <Table data-testid={TID.payoutsTable} className="text-[13px]">
                <THead><TR><TH>Contractor</TH><TH className="hidden tablet:table-cell">Payday</TH><TH numeric className="hidden tablet:table-cell">Amount</TH><TH numeric className="hidden tablet:table-cell">FX</TH><TH numeric>USD</TH><TH>Rail</TH></TR></THead>
                <TBody>
                  {rows.map((p) => (
                    <TR key={p.id} data-testid={TID.payoutRow(p.id)} data-rail={p.railStatus}>
                      <TD className="h-10 whitespace-nowrap">{names.get(p.workerId) ?? p.workerId}</TD>
                      <TD className="hidden h-10 whitespace-nowrap tablet:table-cell">{fmtDate(p.scheduledFor)}</TD>
                      <TD numeric className="hidden h-10 whitespace-nowrap tablet:table-cell">{minor(p.amountMinor, p.currency)}</TD>
                      <TD numeric className="hidden h-10 font-mono text-1 tablet:table-cell">{p.fxRate}</TD>
                      <TD numeric className="h-10 whitespace-nowrap">{usd(p.usdCents)}</TD>
                      <TD className="h-10 whitespace-nowrap">
                        <Badge tone={TONE[p.railStatus] ?? "gray"}>{p.railStatus}</Badge>
                        <span className="ml-2 hidden text-1 text-gray-10 tablet:inline" title={`Sent ${when(p.sentAt)}, delivered ${when(p.deliveredAt)}`}>{p.deliveredAt ? when(p.deliveredAt) : p.sentAt ? when(p.sentAt) : ""}</span>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </Card>
        <p className="mt-2 text-1 text-gray-10">The payment rail simulator marks a transfer sent on its next tick and delivered two business days after booking, on the sim clock.</p>
      </section>
      <section>
        <CardHeading icon={<ArrowLeftRight />}>FX table <Badge tone="outline">Simulated</Badge></CardHeading>
        <Card className="overflow-hidden">
          <Table data-testid={TID.fxTable} className="text-[13px]">
            <THead><TR><TH>Currency</TH><TH numeric>USD per unit</TH><TH>As of</TH></TR></THead>
            <TBody>
              {rates.map((r) => (
                <TR key={r.currency}><TD className="h-9 font-mono text-1">{r.currency}</TD><TD numeric className="h-9 font-mono text-1">{r.usdPerUnit}</TD><TD className="h-9 text-gray-10">{/^\d{4}-\d{2}-\d{2}$/.test(r.asOf) ? longDate(r.asOf) : r.asOf}</TD></TR>
              ))}
            </TBody>
          </Table>
        </Card>
        <p className="mt-2 text-1 text-gray-10">{rates[0]?.source ?? "Synthetic FX table (fixed, not market data)"}. Conversions round half up to whole cents.</p>
      </section>
    </div>
  );
}
