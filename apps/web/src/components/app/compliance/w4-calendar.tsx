"use client";
// Wave 4 compliance screens (w4-parity-compliance): the compliance calendar, the filings list with the prepared
// return, and the hand-offs to a person. Every row is derived in code on the API; nothing here computes a number.
// Filing a return always files a pending proposal (R4) that a person approves in the Inbox.
import Link from "next/link";
import { useState } from "react";
import { Badge, Button, Card, Drawer, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { client, errorText, useGet, useMutation } from "@/lib/api/hooks";
import { cents, fmtDate } from "../format";

export interface CalendarRowDto {
  id: string; kind: string; title: string; jurisdiction: string | null; agency: string | null; form: string | null; period: string | null; dueOn: string;
  status: "upcoming" | "due_soon" | "prepared" | "proposed" | "done" | "overdue" | "waived"; subjectRef: string | null; proposalId: string | null; daysLeft: number; sourceUrl: string | null;
}
interface FilingDto {
  id: string; form: string; formLabel: string; period: string; agency: string; jurisdiction: string; status: string; dueOn: string | null; filedAt: string | null;
  confirmation: string | null; prepared: boolean; periodOpen: boolean; totalDueCents: number | null; balanceDueCents: number | null; sourceUrl: string | null;
}
interface PreparedReturn { lines: { line: string; label: string; cents: number | null; count: number | null }[]; runs: string[]; coverage: string; employees: Record<string, unknown>[]; total_due_cents: number; balance_due_cents: number }
interface HandoffDto { id: string; kind: string; reason: string; subjectRef: string | null; summary: string; evidence: { label: string; ref: string }[]; status: string; assigneeName: string; createdAt: string; resolutionNote: string | null }
interface Page<T> { data: T[]; count: number; hasMore: boolean }

const TONE: Record<CalendarRowDto["status"], "gray" | "blue" | "amber" | "green" | "red"> = { upcoming: "gray", due_soon: "amber", prepared: "blue", proposed: "blue", done: "green", overdue: "red", waived: "gray" };
const KIND: Record<string, string> = { filing: "Filing", deposit: "Deposit", notice_response: "Notice reply", registration: "Registration", training_due: "Training", contractor_form_expiry: "Contractor form", benefits_window_close: "Benefits window" };
const human = (s: string) => s.replaceAll("_", " ");
const days = (n: number) => (n === 0 ? "today" : n > 0 ? `in ${n} day${n === 1 ? "" : "s"}` : `${-n} day${n === -1 ? "" : "s"} ago`);

export function CalendarPanel() {
  const cal = useGet("/v1/compliance/calendar", { refreshMs: 5_000 });
  const [kind, setKind] = useState<string>("all");
  const rows = ((cal.data ?? []) as unknown as CalendarRowDto[]).filter((r) => kind === "all" || r.kind === kind);
  const kinds = [...new Set(((cal.data ?? []) as unknown as CalendarRowDto[]).map((r) => r.kind))];
  return (
    <div className="flex flex-col gap-3" data-testid="compliance-calendar" data-tour="compliance-calendar" data-count={rows.length}>
      {cal.error ? <div role="alert" className="text-1 text-red-11">{errorText(cal.error)}</div> : null}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by kind">
        {["all", ...kinds].map((k) => (
          <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k} className={`rounded-full border px-3 py-1 text-1 ${kind === k ? "border-gray-12 bg-gray-12 text-gray-1" : "border-[var(--app-border)] hover:bg-gray-2"}`}>{k === "all" ? "All" : KIND[k] ?? human(k)}</button>
        ))}
      </div>
      <Card className="overflow-hidden">
        <Table className="min-w-[680px]">
          <THead><TR><TH>Due</TH><TH>What</TH><TH>Kind</TH><TH>Status</TH><TH>Source</TH></TR></THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.id} data-testid={`calendar-row-${r.id}`} data-kind={r.kind} data-status={r.status}>
                <TD className="whitespace-nowrap">{fmtDate(r.dueOn, { month: "short", day: "numeric", year: "numeric" })}<div className="text-0 text-gray-10">{days(r.daysLeft)}</div></TD>
                <TD className="font-medium">{r.title}</TD>
                <TD>{KIND[r.kind] ?? human(r.kind)}</TD>
                <TD><Badge tone={TONE[r.status]}>{human(r.status)}</Badge>{r.proposalId ? <Link href="/app/inbox" className="ml-2 text-1 text-blue-11 hover:underline">In Inbox</Link> : null}</TD>
                <TD className="text-1">{r.sourceUrl ? <a href={r.sourceUrl} target="_blank" rel="noreferrer noopener" className="text-blue-11 hover:underline">Rule</a> : <span className="text-gray-9">-</span>}</TD>
              </TR>
            ))}
            {cal.data && rows.length === 0 ? <TR><TD colSpan={5} className="text-gray-10">Nothing on the calendar.</TD></TR> : null}
          </TBody>
        </Table>
      </Card>
      <p className="text-0 text-gray-10">Rows within 14 days of their due date show as due soon. Every agency here is a simulator.</p>
    </div>
  );
}

function FilingDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const f = useGet("/v1/filings/:id", { params: { id: id ?? "" }, enabled: !!id });
  const d = f.data as unknown as (FilingDto & { preparedReturn: PreparedReturn | null }) | undefined;
  const prepare = useMutation(() => client.post("/v1/filings/:id/prepare", { params: { id: id! }, body: {} }));
  const file = useMutation(() => client.post("/v1/filings/:id/file", { params: { id: id! }, body: {} }));
  const [sent, setSent] = useState(false);
  const err = f.error ?? prepare.error ?? file.error;
  const p = d?.preparedReturn ?? null;
  return (
    <Drawer open={!!id} onOpenChange={(o) => { if (!o) onClose(); }} title={d ? `${d.formLabel} for ${d.period}` : "Filing"} description={d ? `Due ${d.dueOn ?? "-"} · ${human(d.status)}` : undefined}>
      {err ? <div role="alert" className="mb-3 text-1 text-red-11">{errorText(err)}</div> : null}
      {d ? (
        <div className="flex flex-col gap-4" data-testid="filing-detail">
          <div className="flex flex-wrap gap-2">
            {d.status === "draft" ? <Button size="sm" variant="secondary" data-testid="filing-prepare" disabled={prepare.pending} onClick={() => void prepare.run()}>{p ? "Prepare again" : "Prepare from payroll"}</Button> : null}
            {d.status === "draft" && p && !d.periodOpen ? <Button size="sm" variant="primary" data-testid="filing-file" disabled={file.pending} onClick={() => void file.run().then((r) => { if (r) setSent(true); })}>Request filing approval</Button> : null}
            {d.confirmation ? <span className="text-1 text-gray-11">Confirmation <code className="font-mono">{d.confirmation}</code></span> : null}
          </div>
          {sent ? <p role="status" data-testid="filing-proposed" className="text-1 text-blue-11">Sent to the <Link href="/app/inbox" className="underline">Inbox</Link> for approval.</p> : null}
          {p ? (
            <>
              <Table>
                <THead><TR><TH>Line</TH><TH>Description</TH><TH numeric>Amount</TH></TR></THead>
                <TBody>
                  {p.lines.map((l) => (
                    <TR key={l.line} data-testid={`filing-line-${l.line}`}><TD className="font-mono text-1">{l.line}</TD><TD>{l.label}</TD><TD numeric>{l.cents !== null ? cents(l.cents) : l.count ?? "-"}</TD></TR>
                  ))}
                </TBody>
              </Table>
              <p className="text-1 text-gray-11">{p.coverage}</p>
              {p.employees.length ? <p className="text-1 text-gray-10">{p.employees.length} employee rows on this return.</p> : null}
            </>
          ) : <p className="text-[13px] text-gray-10">Not prepared yet. Preparing reads the processed pay runs; nothing is sent.</p>}
          {d.periodOpen ? <p className="text-0 text-gray-10">The period has not ended, so it can be prepared to date but not filed.</p> : null}
          <p className="text-0 text-gray-10">Filing is irreversible, so it always goes to the Inbox for a person to approve. {d.sourceUrl ? <a href={d.sourceUrl} target="_blank" rel="noreferrer noopener" className="text-blue-11 hover:underline">Agency rule</a> : null}</p>
        </div>
      ) : null}
    </Drawer>
  );
}

export function FilingsPanel() {
  const list = useGet("/v1/filings", { query: { limit: 100 }, refreshMs: 5_000 });
  const [open, setOpen] = useState<string | null>(null);
  const rows = ((list.data as unknown as Page<FilingDto> | undefined)?.data ?? []);
  return (
    <>
      {list.error ? <div role="alert" className="mb-3 text-1 text-red-11">{errorText(list.error)}</div> : null}
      <Card className="overflow-hidden" data-testid="filings-list">
        <Table className="min-w-[680px]">
          <THead><TR><TH>Form</TH><TH>Period</TH><TH>Due</TH><TH numeric>Total</TH><TH>Status</TH></TR></THead>
          <TBody>
            {rows.map((f) => (
              <TR key={f.id} data-testid={`filing-row-${f.form}-${f.period}`} data-status={f.status} className="cursor-pointer hover:bg-gray-2" onClick={() => setOpen(f.id)}>
                <TD className="font-medium">{f.formLabel}<span className="ml-2 text-1 text-gray-10">{f.jurisdiction}</span></TD>
                <TD>{f.period}</TD>
                <TD className="whitespace-nowrap">{f.dueOn ? fmtDate(f.dueOn, { month: "short", day: "numeric", year: "numeric" }) : "-"}</TD>
                <TD numeric>{f.totalDueCents !== null ? cents(f.totalDueCents) : "-"}</TD>
                <TD><Badge tone={f.status === "filed" || f.status === "accepted" ? "green" : f.prepared ? "blue" : "gray"}>{f.status === "draft" ? (f.prepared ? "prepared" : "not prepared") : f.status}</Badge></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      <FilingDrawer id={open} onClose={() => setOpen(null)} />
    </>
  );
}

/** Open hand-offs to a person. Also meant for the Inbox (contract request: the integrator mounts it there). */
export function HandoffsPanel({ status = "open" }: { status?: string }) {
  const list = useGet("/v1/handoffs", { query: { status, limit: 100 }, refreshMs: 5_000 });
  const resolve = useMutation((id: string) => client.post("/v1/handoffs/:id/resolve", { params: { id }, body: { note: "" } }));
  const rows = ((list.data as unknown as Page<HandoffDto> | undefined)?.data ?? []);
  return (
    <section data-testid="handoffs-panel" className="flex flex-col gap-2">
      {list.error ? <div role="alert" className="text-1 text-red-11">{errorText(list.error)}</div> : null}
      {rows.length === 0 && list.data ? <p className="text-[13px] text-gray-10">No open hand-offs.</p> : null}
      {rows.map((h) => (
        <Card key={h.id} className="flex flex-col gap-1.5 p-3" data-testid={`handoff-${h.id}`}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="amber">{human(h.kind)}</Badge><span className="text-1 text-gray-10">{human(h.reason)}</span>
            <code className="font-mono text-0">{h.id}</code>{h.subjectRef ? <code className="font-mono text-0 text-gray-10">{h.subjectRef}</code> : null}
          </div>
          <p className="text-[13px]">{h.summary}</p>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-0 text-gray-11">{h.evidence.map((e) => <li key={`${e.label}${e.ref}`}>{e.label}: <code className="font-mono">{e.ref}</code></li>)}</ul>
          <div className="flex items-center gap-2 text-1 text-gray-10">With {h.assigneeName}
            {h.status === "open" || h.status === "acknowledged" ? <Button size="sm" variant="secondary" disabled={resolve.pending} onClick={() => void resolve.run(h.id)}>Mark resolved</Button> : null}
          </div>
        </Card>
      ))}
    </section>
  );
}
