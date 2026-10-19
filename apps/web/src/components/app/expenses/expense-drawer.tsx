"use client";
// Expense drawer (owner: w3-expenses): receipt preview (admins), claimed against extracted fields, the policy checks
// with the explanation and its source, the engine's suggestion, a decision bar for exactly this one item, where it is
// paid, and the audit trail. A click here is the person's own decision; an agent's decide call is a proposal instead.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge, Button, Drawer } from "@weft/ui/components";
import { W3_EXPENSES_TID as TID, type ExpenseDecision, type ExpenseDeclineReason, type ToolOutcome } from "@weft/contracts";
import type { W3ExpensesDetail } from "../../../../../../packages/contracts/src/ext/w3-expenses";
import { client, errorText, getPrincipal, rawFetch, useGet, useMutation } from "@/lib/api/hooks";
import { fmtDate, fmtDateTime, humanTimes } from "../format";
import { CATEGORY_LABEL, DECISION_LABEL, REASON_LABEL, RULE_LABEL, SEVERITY_TONE, STATUS_LABEL, STATUS_TONE, usd } from "./labels";

function Section({ title, children, tour }: { title: string; children: React.ReactNode; tour?: string }) {
  return <section data-tour={tour} className="mb-5"><h3 className="mb-2 text-1 font-medium tracking-wide text-gray-10 uppercase">{title}</h3>{children}</section>;
}
function Row({ k, v, warn }: { k: string; v: React.ReactNode; warn?: boolean }) {
  return <div className="flex justify-between gap-3 border-b border-[var(--app-border)] py-1"><dt className="text-gray-11">{k}</dt><dd className={`text-right tabular ${warn ? "text-amber-11" : ""}`}>{v}</dd></div>;
}

/** Receipt bytes come through the API (admins only) with the Viewing as header, shown from a blob URL. */
function ReceiptPreview({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let alive = true, made: string | null = null;
    setUrl(null); setFailed(null);
    rawFetch(`/api/v1/expenses/${encodeURIComponent(id)}/receipt`, { headers: { "x-weft-principal": getPrincipal() } }).then(async (r) => {
      if (!r.ok) { if (alive) setFailed(r.status === 403 ? "Receipts are shown to admins only." : "Receipt unavailable."); return; }
      made = URL.createObjectURL(await r.blob());
      if (alive) setUrl(made);
    }).catch(() => { if (alive) setFailed("Receipt unavailable."); });
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [id]);
  if (failed) return <p className="text-1 text-gray-10">{failed}</p>;
  if (!url) return <div className="h-24 w-20 animate-pulse rounded-md bg-gray-3" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="Receipt image (simulated)" className="h-24 w-20 rounded-md bg-white object-contain shadow-[var(--shadow-border)] [image-rendering:pixelated]" />;
}

export function ExpenseDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useGet("/v1/expenses/:id", { params: { id: id ?? "" }, enabled: !!id });
  const e = q.data as W3ExpensesDetail | undefined;
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<ExpenseDeclineReason>("other");
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => { setNote(""); setDone(null); setReason("other"); }, [id]);
  useEffect(() => { if (e?.suggestion?.reasonCode) setReason(e.suggestion.reasonCode); }, [e?.suggestion?.reasonCode]);
  const decide = useMutation(async (decision: ExpenseDecision) => (await client.post("/v1/expenses/:id/decide", { params: { id: id! }, body: { decision, ...(decision === "decline" ? { reasonCode: reason } : {}), ...(note.trim() ? { note: note.trim() } : {}) } })) as ToolOutcome);
  const reopen = useMutation(async () => (await client.post("/v1/expenses/:id/reopen", { params: { id: id! }, body: {} })) as ToolOutcome);
  const act = async (d: ExpenseDecision) => {
    const o = await decide.run(d);
    if (o?.ok) setDone(o.status === "done" ? humanTimes(o.summary) : `Proposal ${o.proposalId} is waiting in the Inbox`);
  };
  const live = e && e.id === id ? e : undefined;
  const ex = live?.receiptExtract ?? null;
  const err = decide.error ?? reopen.error ?? q.error;
  return (
    <Drawer open={!!id} onOpenChange={(o) => { if (!o) onClose(); }} title={live ? `${usd(live.amountCents)} ${CATEGORY_LABEL[live.category].toLowerCase()}` : "Expense"}
      description={live ? `${live.workerName} · ${live.id} · ${STATUS_LABEL[live.status]}` : undefined}>
      {live ? (
        <div data-testid={TID.drawer} data-status={live.status}>
          {err ? <div role="alert" className="mb-3 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(err)}</div> : null}
          {done ? <div role="status" className="mb-3 rounded-lg bg-gray-3 px-3 py-2 text-1 text-gray-12">{done}</div> : null}
          <Section title="Claim">
            <div className="flex gap-4">
              {live.hasReceipt ? <ReceiptPreview id={live.id} /> : <div className="flex h-24 w-20 items-center justify-center rounded-md bg-gray-2 text-center text-0 text-gray-9">No receipt</div>}
              <dl className="min-w-0 flex-1 text-[13px]">
                <Row k="Merchant" v={<span className="break-words">{live.merchant}</span>} />
                <Row k="Amount" v={usd(live.amountCents)} warn={!!ex && ex.totalCents !== live.amountCents} />
                <Row k="Date" v={fmtDate(live.transactionDate, { month: "short", day: "numeric", year: "numeric" })} />
                <Row k="Submitted" v={fmtDate(live.submittedDate)} />
                {live.milesX10 !== null ? <Row k="Miles" v={(live.milesX10 / 10).toFixed(1)} /> : null}
              </dl>
            </div>
            {ex ? <p className="mt-2 text-1 text-gray-10">Receipt reads {usd(ex.totalCents)} on {fmtDate(ex.date)} (simulated extraction).</p>
              : live.hasReceipt ? <p className="mt-2 text-1 text-gray-10">No extraction for this receipt: the simulated extractor reads only seeded receipts, so compare the image by eye.</p> : null}
            <dl className="mt-2 text-[13px]">
              <Row k="Purpose" v={<span className="break-words">{live.businessPurpose}</span>} />
              {live.category === "meals" ? <Row k="Attendees" v={live.attendees ?? <span className="text-gray-9">none listed</span>} /> : null}
            </dl>
            <p className="mt-1 text-0 text-gray-9">Merchant, purpose and attendees are the employee&apos;s own words.</p>
          </Section>
          <Section title="Policy checks" tour="expense-checks">
            {live.checks.length === 0 ? <p className="text-[13px] text-gray-11">No checks fired: within policy (version {live.policyVersion}).</p> : (
              <ul className="flex flex-col gap-1.5">
                {live.checks.map((c) => (
                  <li key={c.rule} data-testid={TID.check(c.rule)} data-severity={c.severity} className="flex items-start gap-2 text-[13px]">
                    <Badge tone={SEVERITY_TONE[c.severity]}>{RULE_LABEL[c.rule] ?? c.rule}</Badge><span className="text-gray-11">{c.message}</span>
                  </li>
                ))}
              </ul>
            )}
            {live.explanation ? <p className="mt-3 rounded-lg bg-gray-2 px-3 py-2 text-[13px]">{live.explanation} <span className="text-1 text-gray-9">({live.explanationSource === "agent" ? "agent, grounded" : "template"})</span></p> : null}
          </Section>
          {live.allowedDecisions.length ? (
            <Section title="Decision">
              {live.suggestion ? (
                <p className="mb-2 text-[13px] text-gray-11">Policy suggests <strong className="font-medium text-foreground">{DECISION_LABEL[live.suggestion.decision]}</strong>: {live.suggestion.note}.{live.suggestion.humanNote ? <span className="mt-1 block text-amber-11">{live.suggestion.humanNote}.</span> : null}</p>
              ) : null}
              <textarea value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={400} rows={2} placeholder={live.allowedDecisions.includes("return") ? "Note to the employee (needed to return)" : "Decision note (optional)"}
                className="mb-2 w-full rounded-lg bg-card px-2.5 py-1.5 text-[13px] shadow-[var(--shadow-border)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-9)]" />
              <div className="flex flex-wrap items-center gap-2">
                {live.allowedDecisions.map((d) => (
                  <Button key={d} data-testid={TID.decide(d)} size="sm" variant={d === "decline" ? "danger" : d === live.suggestion?.decision ? "primary" : "secondary"} disabled={decide.pending || (d === "return" && !note.trim())} onClick={() => void act(d)}>
                    {DECISION_LABEL[d]}
                  </Button>
                ))}
                {live.allowedDecisions.includes("decline") ? (
                  <select aria-label="Decline reason" value={reason} onChange={(ev) => setReason(ev.target.value as ExpenseDeclineReason)} className="h-7 rounded-md bg-card px-2 text-[13px] shadow-[var(--shadow-border)]">
                    {(Object.keys(REASON_LABEL) as ExpenseDeclineReason[]).map((r) => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}
                  </select>
                ) : null}
              </div>
              <p className="mt-2 text-1 text-gray-10">One item per decision. Approved items are paid on the next draft before its deadline, outside gross pay; approve as taxable pays it as wages.</p>
            </Section>
          ) : null}
          <Section title="Payment">
            <dl className="text-[13px]">
              <Row k="Status" v={<Badge tone={STATUS_TONE[live.status]}>{STATUS_LABEL[live.status]}</Badge>} />
              <Row k="Pay run" v={live.payrollRunId ? <Link className="hover:underline" href={`/app/payroll/${live.payrollRunId}`}>{live.payrollRunId}{live.payrollRunStatus ? ` (${live.payrollRunStatus})` : ""}</Link> : live.status.startsWith("approved") ? "Next draft" : "-"} />
              {live.paycheckId ? <Row k="Paycheck" v={<span className="font-mono text-1">{live.paycheckId}</span>} /> : null}
              {live.decidedBy ? <Row k="Decided" v={`${live.decidedBy}${live.decidedAt ? `, ${fmtDateTime(live.decidedAt)}` : ""}`} /> : null}
              {live.decisionReasonCode ? <Row k="Reason" v={REASON_LABEL[live.decisionReasonCode]} /> : null}
              {live.decisionNote ? <Row k="Note" v={<span className="break-words">{live.decisionNote}</span>} /> : null}
            </dl>
            {live.allowedDecisions.length === 0 ? (
              live.reopenBlocker ? <p className="mt-2 text-1 text-gray-10">{live.reopenBlocker}.</p>
                : <Button className="mt-3" size="sm" variant="ghost" disabled={reopen.pending} onClick={() => void reopen.run().then((o) => { if (o?.ok && o.status === "done") setDone(o.summary); })}>Reopen</Button>
            ) : null}
          </Section>
          {live.trail.length ? (
            <Section title="Audit trail">
              <ol className="flex flex-col gap-1 text-1">
                {live.trail.map((a) => <li key={a.seq} className="text-gray-11"><span className="font-mono text-gray-9">#{a.seq}</span> {fmtDateTime(a.at)} · {a.actor} · {humanTimes(a.summary)}</li>)}
              </ol>
            </Section>
          ) : null}
        </div>
      ) : <p className="text-[13px] text-gray-10">{q.error ? errorText(q.error) : "Loading..."}</p>}
    </Drawer>
  );
}
