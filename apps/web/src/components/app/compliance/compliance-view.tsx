"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { STACK } from "../stack";
import { Badge, Card, Drawer, Tabs, TabsContent, TabsList, TabsTrigger, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { TID, W3_ROUTINES_TID, tid, type EmployerRate, type Notice, type TaxAccount } from "@weft/contracts";
import { cn } from "@weft/ui";
import { errorText, useGet } from "@/lib/api/hooks";
import { ACCOUNT_TYPE, AGENCY, fmtDate, fmtDateTime, longDate, statusLabel } from "../format";
import { PageHeader } from "../page";
import { refHref } from "../refs";
import { auditLabel, humanLine, noticeName } from "../copy";
import { CalendarPanel, FilingsPanel, HandoffsPanel } from "./w4-calendar";
import { NoticeUpload, TrainingPanel } from "./w4-upload-training";
import { HeldBack } from "../agent/held-back";

const STATUS_TONE: Record<TaxAccount["status"], "green" | "amber" | "gray" | "red"> = { active: "green", awaiting_state: "amber", needs_info: "red", not_registered: "gray" };
const NOTICE_TONE: Record<Notice["status"], "gray" | "blue" | "amber" | "green" | "red"> = { new: "blue", in_review: "blue", proposed: "amber", resolved: "green", escalated: "red" };
export const ratePct = (r: string) => `${(Number(r) * 100).toFixed(r.length > 6 ? 3 : 2).replace(/0+$/, "").replace(/\.$/, "")}%`;
const human = (s: string) => statusLabel(s);

function currentRate(rates: EmployerRate[], j: string, code: string): EmployerRate | undefined {
  return rates.filter((r) => r.jurisdiction === j && r.code === code && r.supersededActionSeq === null).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
}

interface EscalationCase { outcome: "escalated"; reason: string; specialist: string; escalated_at: string; escalated_by: string; evidence: { label: string; ref: string }[] }
const escalationOf = (n: Notice): EscalationCase | null => (n.status === "escalated" && n.resolution?.outcome === "escalated" ? (n.resolution as unknown as EscalationCase) : null);

/** The specialist hand-off (notices.escalate): who has it, why, and the evidence pack it carried. */
function Escalation({ e }: { e: EscalationCase }) {
  return (
    <section data-testid={W3_ROUTINES_TID.noticeEscalation} className="rounded-lg border border-red-6 bg-red-2 p-3">
      <h3 className="mb-1 text-1 font-medium text-red-11 uppercase">With the {e.specialist.toLowerCase()}</h3>
      <p className="text-[13px]">Escalated {fmtDateTime(e.escalated_at)} by <code className="font-mono text-0">{e.escalated_by}</code>: {e.reason}.</p>
      <ul className="mt-2 flex flex-col gap-1 text-[13px]">
        {e.evidence.map((x) => (
          <li key={`${x.label}${x.ref}`} className="flex flex-wrap items-center gap-2"><span className="text-gray-10">{x.label}</span>{refHref(x.ref) ? <Link href={refHref(x.ref)!} className="font-mono text-0 text-blue-11 hover:underline">{x.ref}</Link> : <code className="font-mono text-0">{x.ref}</code>}</li>
        ))}
      </ul>
    </section>
  );
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
          {escalationOf(d) ? <Escalation e={escalationOf(d)!} /> : null}
          <HeldBack text={d.bodyText} />
          <section>
            <h3 className="mb-1.5 text-1 font-medium text-gray-10 uppercase">Original text ({d.fileName})</h3>
            <pre data-testid="notice-body" className="max-h-80 overflow-auto rounded-lg border border-[var(--app-border)] bg-gray-2 p-3 font-mono text-0 leading-4 break-words whitespace-pre-wrap">{d.bodyText ?? "(no text)"}</pre>
            <p className="mt-1 text-0 text-gray-10">Shown as plain text. Notice text is untrusted: runs that read it are marked tainted.</p>
          </section>
          {d.extracted ? (
            <section>
              <h3 className="mb-1.5 text-1 font-medium text-gray-10 uppercase">Extracted fields (deterministic parser)</h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
                {([["Agency", AGENCY[d.extracted.agency]], ["Form", d.extracted.formCode], ["Kind", human(d.extracted.kind)], ["Account", d.extracted.accountNumber ?? "None"], ["Tax year", String(d.extracted.taxYear ?? "None")], ["Effective from", d.extracted.effectiveFrom ? longDate(d.extracted.effectiveFrom) : "Not stated"], ["Respond by", d.extracted.respondBy ? longDate(d.extracted.respondBy) : "Not stated"]] as const).flatMap(([k, v]) => [<dt key={`k${k}`} className="text-gray-10">{k}</dt>, <dd key={`v${k}`}>{v}</dd>])}
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
                    <Badge tone={p.status === "pending" ? "amber" : p.status === "executed" ? "green" : "gray"}>{p.status === "executed" ? "Done" : statusLabel(p.status)}</Badge>
                    <Link href={`/app/inbox?proposal=${encodeURIComponent(p.id)}`} className="min-w-0 flex-1 truncate hover:underline">{linkedHeadline(p.headline)}</Link>
                    {p.proposerRunId ? <Link href={`/app/runs/${p.proposerRunId}`} className="text-1 text-blue-11 hover:underline">Agent run</Link> : null}
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

/** A linked proposal's headline as copy: ids go, and a rate reads as the notice does ("3.80%" is "3.8%"). */
export function linkedHeadline(h: string): string {
  return humanLine(h).replace(/\b(\d+)\.(\d*?)0+%/g, (_m, a: string, b: string) => `${a}${b ? `.${b}` : ""}%`);
}

export function ComplianceView() {
  const accounts = useGet("/v1/tax/accounts", { refreshMs: 5_000 });
  const rates = useGet("/v1/tax/rates", { refreshMs: 5_000 });
  const notices = useGet("/v1/notices", { query: { limit: 100 }, refreshMs: 5_000 });
  // A rate sourced to a notice names the notice by its form ("DE 2088 notice"), not by its row id.
  const noticeLabel = (id: string): string => noticeName(notices.data?.data.find((x) => x.id === id)?.formCode);
  const [open, setOpen] = useState<string | null>(null);
  const [tab, setTab] = useState("registrations");
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const n = q.get("notice");
    if (n) { setTab("notices"); setOpen(n); }
    const t = q.get("tab");
    if (!n && t && ["calendar", "filings", "handoffs", "training", "notices"].includes(t)) setTab(t);
  }, []);
  const rs = rates.data ?? [];
  const err = accounts.error ?? rates.error ?? notices.error;
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title="Taxes & Compliance" subtitle="State registrations, employer rates, agency notices, the compliance calendar and filings." />
      {err ? <div role="alert" className="mb-4 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(err)}</div> : null}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="registrations">Registrations</TabsTrigger>
          <TabsTrigger value="rates" data-tour="compliance-tab" data-tab="rates">Rates</TabsTrigger>
          <TabsTrigger value="notices">Notices {notices.data ? <Badge size="xs">{notices.data.count}</Badge> : null}</TabsTrigger>
          <TabsTrigger value="calendar" data-tour="compliance-tab" data-tab="calendar">Calendar</TabsTrigger>
          <TabsTrigger value="filings">Filings</TabsTrigger>
          <TabsTrigger value="handoffs">Hand-offs</TabsTrigger>
          <TabsTrigger value="training">Training</TabsTrigger>
        </TabsList>
        <TabsContent value="registrations">
          <Card className={cn("overflow-hidden", STACK.box)}>
            <Table className={cn("min-w-[640px] @max-[40rem]:min-w-0", STACK.table)}>
              <THead className={STACK.head}><TR><TH>State</TH><TH>Agency</TH><TH>Account</TH><TH numeric>SUI rate</TH><TH>Status</TH></TR></THead>
              <TBody>
                {(accounts.data ?? []).map((a) => {
                  const sui = a.accountType === "unemployment" || a.accountType === "combined" ? currentRate(rs, a.jurisdiction, "sui") : undefined;
                  return (
                    <TR key={a.id} data-testid={tid.registrationRow(a.jurisdiction)} data-status={a.status} className={STACK.row}>
                      <TD className={cn("font-medium", STACK.leadShared, "@max-[40rem]:order-first")}>{a.jurisdiction} <span className="hidden font-normal text-gray-11 @max-[40rem]:inline">{AGENCY[a.agency]}</span></TD>
                      <TD className={cn("h-auto py-2", STACK.lead, "@max-[40rem]:hidden")}><div className="whitespace-nowrap">{AGENCY[a.agency]}</div><div className="text-1 text-gray-10">{ACCOUNT_TYPE[a.accountType] ?? human(a.accountType)}</div></TD>
                      <TD data-label="Account" className={cn("font-mono text-1", STACK.cell, "@max-[40rem]:before:font-sans")}>{a.accountNumber ?? <span className="font-sans text-gray-9">{a.status === "awaiting_state" || a.status === "needs_info" ? "Pending" : "None yet"}</span>}</TD>
                      <TD numeric data-label="SUI rate" className={STACK.cell}>{sui ? ratePct(sui.rate) : "-"}</TD>
                      <TD className={cn(STACK.bare, "@max-[40rem]:order-first")}><Badge tone={STATUS_TONE[a.status]}>{a.status === "awaiting_state" ? "Awaiting state" : a.status === "needs_info" ? "Needs info" : a.status === "not_registered" ? "Not registered" : "Active"}</Badge></TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </Card>
        </TabsContent>
        <TabsContent value="rates">
          <Card className={cn("overflow-hidden", STACK.box)}>
            {/* Five columns that fit a 600 px content column: the state and its code read as one ("CA SUI"). On a phone
                each rate stacks (STACK), so the tax, its rate and its source read together without a sideways scroll. */}
            <Table className={STACK.table}>
              <THead className={STACK.head}><TR><TH>Tax</TH><TH numeric>Rate</TH><TH numeric>Wage base</TH><TH>Effective</TH><TH>Source</TH></TR></THead>
              <TBody>
                {[...rs].sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction) || a.code.localeCompare(b.code) || b.effectiveFrom.localeCompare(a.effectiveFrom)).map((r) => {
                  const href = r.source.startsWith("notice:") ? `/app/compliance?notice=${r.source.slice(7)}` : null;
                  return (
                    <TR key={r.id} data-testid={tid.rateRow(r.jurisdiction, r.code)} data-tour="rate-row" data-jurisdiction={r.jurisdiction} data-code={r.code} data-source={r.source} data-current={r.supersededActionSeq === null && r.id === currentRate(rs, r.jurisdiction, r.code)?.id ? "true" : "false"} data-rate={r.rate} className={cn(STACK.row, r.supersededActionSeq !== null ? "text-gray-9 line-through" : undefined)}>
                      <TD className={cn("whitespace-nowrap", STACK.leadShared)}><span className="font-medium">{r.jurisdiction}</span> <span className="uppercase">{r.code}</span></TD>
                      <TD numeric className={cn(STACK.bare, "@max-[40rem]:font-medium")}>{ratePct(r.rate)}</TD>
                      <TD numeric data-label="Wage base" className={cn(STACK.cell, "@max-[40rem]:basis-full")}>{r.wageBase.display}</TD>
                      <TD data-label="Effective" className={cn("h-auto py-2", STACK.cell, "@max-[40rem]:[&>div]:inline @max-[40rem]:[&>div+div]:ml-1")}>
                        <div className="whitespace-nowrap">{fmtDate(r.effectiveFrom, { month: "short", day: "numeric", year: "numeric" })}{r.effectiveTo ? "" : " onward"}</div>
                        {r.effectiveTo ? <div className="whitespace-nowrap text-1 text-gray-10">to {fmtDate(r.effectiveTo, { month: "short", day: "numeric", year: "numeric" })}</div> : null}
                      </TD>
                      <TD data-label="Source" className={cn("h-auto py-2 text-1", !href && "font-mono", STACK.cell, "@max-[40rem]:basis-full @max-[40rem]:before:font-sans")} data-tour="rate-source">{href ? <a href={href} title={r.source} onClick={(e) => { e.preventDefault(); setTab("notices"); setOpen(r.source.slice(7)); }} className="text-blue-11 hover:underline">{noticeLabel(r.source.slice(7))}</a> : r.source === "seed" ? <span className="font-sans text-gray-11" title="seed">Initial setup</span> : r.source}{r.createdActionSeq !== null ? <Link href="/app/audit" className="ml-2 text-gray-10 hover:underline">{auditLabel(r.createdActionSeq)}</Link> : null}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </Card>
        </TabsContent>
        <TabsContent value="notices">
          <div className="mb-3"><NoticeUpload /></div>
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
        <TabsContent value="calendar"><CalendarPanel /></TabsContent>
        <TabsContent value="filings"><FilingsPanel /></TabsContent>
        <TabsContent value="handoffs"><HandoffsPanel /></TabsContent>
        <TabsContent value="training"><TrainingPanel /></TabsContent>
      </Tabs>
      <NoticeDetail id={open} onClose={() => setOpen(null)} />
    </div>
  );
}
