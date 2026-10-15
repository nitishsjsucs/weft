"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge, Card, Drawer, Tabs, TabsContent, TabsList, TabsTrigger, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { TID, tid, type EmployerRate, type Notice, type TaxAccount } from "@weft/contracts";
import { errorText, useGet } from "@/lib/api/hooks";
import { fmtDate, fmtDateTime } from "../format";
import { PageHeader } from "../page";
import { refHref } from "../refs";

const AGENCY: Record<TaxAccount["agency"], string> = { irs: "IRS (sim)", ca_edd: "CA EDD (sim)", ny_dtf: "NY DTF (sim)", ny_dol: "NY DOL (sim)", tx_twc: "TX TWC (sim)", co_dor: "CO DOR (sim)", co_cdle: "CO CDLE (sim)" };
const STATUS_TONE: Record<TaxAccount["status"], "green" | "amber" | "gray" | "red"> = { active: "green", awaiting_state: "amber", needs_info: "red", not_registered: "gray" };
const NOTICE_TONE: Record<Notice["status"], "gray" | "blue" | "amber" | "green" | "red"> = { new: "blue", in_review: "blue", proposed: "amber", resolved: "green", escalated: "red" };
export const ratePct = (r: string) => `${(Number(r) * 100).toFixed(r.length > 6 ? 3 : 2).replace(/0+$/, "").replace(/\.$/, "")}%`;
const human = (s: string) => s.replaceAll("_", " ");

function currentRate(rates: EmployerRate[], j: string, code: string): EmployerRate | undefined {
  return rates.filter((r) => r.jurisdiction === j && r.code === code && r.supersededActionSeq === null).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
}

function NoticeDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const n = useGet("/v1/notices/:id", { params: { id: id ?? "" }, enabled: !!id });
  const props = useGet("/v1/proposals", { query: { limit: 100 }, enabled: !!id });
  const linked = (props.data?.data ?? []).filter((p) => p.subjectRef === id || p.evidence.some((e) => e.ref === id));
  const d = n.data;
  return (
    <Drawer open={!!id} onOpenChange={(o) => { if (!o) onClose(); }} title={d?.title ?? "Notice"} description={d ? `${AGENCY[d.agency]} · ${d.formCode} · received ${fmtDateTime(d.receivedAt)}` : undefined}>
      {n.error ? <div role="alert" className="text-1 text-red-11">{errorText(n.error)}</div> : null}
      {d ? (
        <div className="flex flex-col gap-5" data-testid="notice-detail">
          <div className="flex flex-wrap items-center gap-2"><Badge tone={NOTICE_TONE[d.status]} size="md">{human(d.status)}</Badge>{d.responseConfirmation ? <span className="text-1 text-gray-11">Confirmation <code className="font-mono">{d.responseConfirmation}</code></span> : null}</div>
          <section>
            <h3 className="mb-1.5 text-1 font-medium text-gray-10 uppercase">Original text ({d.fileName})</h3>
            <pre data-testid="notice-body" className="max-h-80 overflow-auto rounded-lg border border-[var(--app-border)] bg-gray-2 p-3 font-mono text-0 leading-4 break-words whitespace-pre-wrap">{d.bodyText ?? "(no text)"}</pre>
            <p className="mt-1 text-0 text-gray-10">Shown as plain text. Notice text is untrusted: runs that read it are marked tainted.</p>
          </section>
          {d.extracted ? (
            <section>
              <h3 className="mb-1.5 text-1 font-medium text-gray-10 uppercase">Extracted fields (deterministic parser)</h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
                {([["Agency", AGENCY[d.extracted.agency]], ["Form", d.extracted.formCode], ["Kind", human(d.extracted.kind)], ["Account", d.extracted.accountNumber ?? "-"], ["Tax year", String(d.extracted.taxYear ?? "-")], ["Effective from", d.extracted.effectiveFrom ?? "-"], ["Respond by", d.extracted.respondBy ?? "-"]] as const).flatMap(([k, v]) => [<dt key={`k${k}`} className="text-gray-10">{k}</dt>, <dd key={`v${k}`}>{v}</dd>])}
                {d.extracted.rates.map((r) => [<dt key={`rk${r.code}`} className="text-gray-10">{r.code.toUpperCase()} rate</dt>, <dd key={`rv${r.code}`}>{r.oldRate ? `${ratePct(r.oldRate)} to ` : ""}{ratePct(r.newRate)}</dd>])}
              </dl>
            </section>
          ) : null}
          <section>
            <h3 className="mb-1.5 text-1 font-medium text-gray-10 uppercase">Linked runs and proposals</h3>
            {linked.length === 0 ? <p className="text-[13px] text-gray-10">None yet.</p> : (
              <ul className="flex flex-col gap-1.5 text-[13px]">
                {linked.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2">
                    <Badge tone={p.status === "pending" ? "amber" : p.status === "executed" ? "green" : "gray"}>{p.status}</Badge>
                    <Link href="/app/inbox" className="min-w-0 flex-1 truncate hover:underline">{p.headline}</Link>
                    {p.proposerRunId ? <Link href={`/app/runs/${p.proposerRunId}`} className="font-mono text-0 text-blue-11 hover:underline">{p.proposerRunId}</Link> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}

export function ComplianceView() {
  const accounts = useGet("/v1/tax/accounts", { refreshMs: 5_000 });
  const rates = useGet("/v1/tax/rates", { refreshMs: 5_000 });
  const notices = useGet("/v1/notices", { query: { limit: 100 }, refreshMs: 5_000 });
  const [open, setOpen] = useState<string | null>(null);
  const [tab, setTab] = useState("registrations");
  useEffect(() => {
    const n = new URLSearchParams(window.location.search).get("notice");
    if (n) { setTab("notices"); setOpen(n); }
  }, []);
  const rs = rates.data ?? [];
  const err = accounts.error ?? rates.error ?? notices.error;
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title="Taxes & Compliance" subtitle="State registrations, employer rates and agency notices. Every agency here is a simulator in this repo." />
      {err ? <div role="alert" className="mb-4 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(err)}</div> : null}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="registrations">Registrations</TabsTrigger>
          <TabsTrigger value="rates">Rates</TabsTrigger>
          <TabsTrigger value="notices">Notices {notices.data ? <Badge size="xs">{notices.data.count}</Badge> : null}</TabsTrigger>
          <TabsTrigger value="filings">Filings <Badge size="xs">Coming soon</Badge></TabsTrigger>
        </TabsList>
        <TabsContent value="registrations">
          <Card className="overflow-hidden">
            <Table className="min-w-[640px]">
              <THead><TR><TH>State</TH><TH>Agency</TH><TH>Account</TH><TH numeric>SUI rate</TH><TH>Status</TH></TR></THead>
              <TBody>
                {(accounts.data ?? []).map((a) => {
                  const sui = a.accountType === "unemployment" || a.accountType === "combined" ? currentRate(rs, a.jurisdiction, "sui") : undefined;
                  return (
                    <TR key={a.id} data-testid={tid.registrationRow(a.jurisdiction)} data-status={a.status}>
                      <TD className="font-medium">{a.jurisdiction}</TD>
                      <TD>{AGENCY[a.agency]} <span className="text-1 text-gray-10">{human(a.accountType)}</span></TD>
                      <TD className="font-mono text-1">{a.accountNumber ?? <span className="text-gray-9">Pending</span>}</TD>
                      <TD numeric>{sui ? ratePct(sui.rate) : "-"}</TD>
                      <TD><Badge tone={STATUS_TONE[a.status]}>{a.status === "awaiting_state" ? "Awaiting state" : a.status === "needs_info" ? "Needs info" : a.status === "not_registered" ? "Not registered" : "Active"}</Badge></TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </Card>
        </TabsContent>
        <TabsContent value="rates">
          <Card className="overflow-hidden">
            <Table className="min-w-[720px]">
              <THead><TR><TH>Jurisdiction</TH><TH>Code</TH><TH numeric>Rate</TH><TH numeric>Wage base</TH><TH>Effective</TH><TH>Source</TH></TR></THead>
              <TBody>
                {[...rs].sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction) || a.code.localeCompare(b.code) || b.effectiveFrom.localeCompare(a.effectiveFrom)).map((r) => {
                  const href = r.source.startsWith("notice:") ? `/app/compliance?notice=${r.source.slice(7)}` : null;
                  return (
                    <TR key={r.id} data-testid={tid.rateRow(r.jurisdiction, r.code)} data-rate={r.rate} className={r.supersededActionSeq !== null ? "text-gray-9 line-through" : undefined}>
                      <TD className="font-medium">{r.jurisdiction}</TD>
                      <TD className="uppercase">{r.code}</TD>
                      <TD numeric>{ratePct(r.rate)}</TD>
                      <TD numeric>{r.wageBase.display}</TD>
                      <TD className="whitespace-nowrap">{fmtDate(r.effectiveFrom, { month: "short", day: "numeric", year: "numeric" })}{r.effectiveTo ? ` to ${fmtDate(r.effectiveTo, { month: "short", day: "numeric", year: "numeric" })}` : " onward"}</TD>
                      <TD className="font-mono text-1">{href ? <a href={href} onClick={(e) => { e.preventDefault(); setTab("notices"); setOpen(r.source.slice(7)); }} className="text-blue-11 hover:underline">{r.source}</a> : r.source}{r.createdActionSeq !== null ? <Link href="/app/audit" className="ml-2 text-gray-10 hover:underline">#{r.createdActionSeq}</Link> : null}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </Card>
        </TabsContent>
        <TabsContent value="notices">
          <Card className="divide-y divide-[var(--app-border)]">
            {(notices.data?.data ?? []).map((n) => (
              <button type="button" key={n.id} data-testid={tid.noticeRow(n.id)} onClick={() => setOpen(n.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-2 font-medium">{n.title}</div>
                  <div className="truncate text-1 text-gray-10">{AGENCY[n.agency]} · {n.formCode} · received {fmtDateTime(n.receivedAt)}{n.respondBy ? ` · respond by ${fmtDate(n.respondBy)}` : ""}</div>
                </div>
                <Badge data-testid={TID.noticeStatus} tone={NOTICE_TONE[n.status]}>{human(n.status)}</Badge>
              </button>
            ))}
            {notices.data && notices.data.data.length === 0 ? <div className="px-4 py-6 text-2 text-gray-10">No notices.</div> : null}
          </Card>
        </TabsContent>
        <TabsContent value="filings">
          <div className="rounded-xl border border-dashed border-[var(--app-border)] px-6 py-10 text-center text-2 text-gray-10">Quarterly and annual filings are coming soon. Responses to notices are filed from the Inbox today.</div>
        </TabsContent>
      </Tabs>
      <NoticeDetail id={open} onClose={() => setOpen(null)} />
    </div>
  );
}
