"use client";
import Link from "next/link";
import { useState } from "react";
import { Check, Clock, ExternalLink, ShieldAlert, X } from "lucide-react";
import { Badge, Button, Card, DiffTable } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { TID, tid, type DecisionResult, type Proposal } from "@weft/contracts";
import { client, errorText, useMutation, useSimClock } from "@/lib/api/hooks";
import { cents, fmtDateTime, humanTimes, relative } from "../format";
import { principalName, refHref } from "../refs";
import { noteLabel, proposerOf, type Proposer } from "./proposer";
import { RiskChip } from "../risk";

export const DENY_REASONS = [
  { code: "incorrect", label: "Incorrect or not grounded" },
  { code: "needs_changes", label: "Needs changes" },
  { code: "not_needed", label: "Not needed" },
  { code: "wrong_timing", label: "Wrong timing" },
  { code: "other", label: "Other" },
] as const;

type Decision = "approve" | "deny" | "dismiss" | "start";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-1 text-gray-10">{label}</dt>
      <dd className="min-w-0 text-[13px] break-words">{children}</dd>
    </div>
  );
}

/** Who proposed the change, with the routine run and a link to the agent run when there is one. */
function ProposedBy({ who }: { who: Proposer }) {
  const run = (id: string | null) => id ? <Link className="inline-flex items-center gap-0.5 text-blue-11 hover:underline" href={`/app/runs/${id}`}>Open run <ExternalLink className="size-3" /></Link> : null;
  switch (who.kind) {
    case "routine": return <span className="flex flex-wrap gap-x-2">Routine <span className="font-mono text-1">{who.routineRunId}</span>{run(who.runId)}</span>;
    case "agent": return <span className="flex flex-wrap gap-x-2">Weft agent{run(who.runId)}</span>;
    case "person": return <>{principalName(who.principalId)}</>;
    case "unknown": return <span className="text-gray-10">Not recorded</span>;
  }
}

/** One decision card (SPEC 11.3 /app/inbox). Free text renders only as text: React escapes it and nothing is truncated. */
export function ProposalCard({ p }: { p: Proposal }) {
  const clock = useSimClock();
  const now = clock.data?.now ?? p.createdAt;
  const [mode, setMode] = useState<"idle" | "deny" | "approve-note">("idle");
  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<DecisionResult | null>(null);
  const m = useMutation((decision: Decision, body?: { reasonCode: string | null; note: string | null }) =>
    client.post(`/v1/proposals/:id/${decision}` as "/v1/proposals/:id/approve", { params: { id: p.id }, body: body ?? {} }));

  async function decide(decision: Decision, body?: { reasonCode: string | null; note: string | null }) {
    const r = await m.run(decision, body);
    if (r) setResult(r as DecisionResult);
  }
  const pending = p.status === "pending";
  const isSuggestion = p.kind === "suggestion";
  const expired = new Date(p.expiresAt).getTime() <= new Date(now).getTime();
  const who = proposerOf(p);

  return (
    <Card data-testid={tid.inboxCard(p.id)} data-status={p.status} data-tainted={p.taintedBy ? "true" : "false"} className="overflow-hidden">
      {p.taintedBy ? (
        <div data-testid={TID.inboxTaintedBanner} role="alert" className="flex items-start gap-2 border-b border-amber-9/30 bg-amber-3 px-4 py-2 text-[13px] text-amber-11">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">This run read untrusted content: {p.taintedBy}</span>
        </div>
      ) : null}
      <div className="flex flex-col gap-3 px-4 py-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <RiskChip risk={p.risk} />
          {isSuggestion ? <Badge tone="blue">Suggestion</Badge> : null}
          {p.kind === "routine_enable" ? <Badge tone="blue">Enable routine</Badge> : null}
          {p.kind === "secret_request" ? <Badge tone="amber">Secret request</Badge> : null}
          {p.command ? <code className="rounded bg-gray-3 px-1.5 py-0.5 font-mono text-0 text-gray-11">{p.command}</code> : null}
          <span className="flex-1" />
          {pending ? (
            <span className={cn("inline-flex items-center gap-1 text-1 tabular", expired ? "text-red-11" : "text-gray-10")} title={`Expires ${fmtDateTime(p.expiresAt)}`}>
              <Clock className="size-3.5" /> {expired ? "Expired" : `Expires ${relative(p.expiresAt, now)}`}
            </span>
          ) : <Badge tone={p.status === "executed" || p.status === "approved" ? "green" : p.status === "denied" || p.status === "failed" ? "red" : "gray"}>{p.status}</Badge>}
        </div>
        <h3 className="text-3 font-medium leading-6 text-balance break-words">{humanTimes(p.headline)}</h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 tablet:grid-cols-4">
          <Field label="On behalf of">{principalName(p.onBehalfOf)}</Field>
          <Field label="Money">{p.moneyCents === null ? "None" : <span className="tabular">{cents(p.moneyCents)}</span>}</Field>
          <Field label="Reversible">{p.reversible ? "Yes, from the audit log" : <span className="text-red-11">No</span>}</Field>
          <Field label="Proposed by"><ProposedBy who={who} /></Field>
        </dl>
        {p.diff.length ? <DiffTable data-testid={TID.proposalDiff} rows={p.diff.map((r) => ({ ...r, before: humanTimes(r.before), after: humanTimes(r.after) }))} /> : null}
        {p.content.length ? (
          <div data-testid={TID.proposalContent} className="flex flex-col gap-2">
            {p.content.map((c, i) => (
              <div key={i} className="rounded-lg border border-[var(--app-border)]">
                <div className="border-b border-[var(--app-border)] bg-gray-2 px-3 py-1.5 text-1 font-medium text-gray-11">{c.label === "Content to be sent" ? c.label : `Content to be sent: ${c.label}`}</div>
                <pre className="max-w-full overflow-x-auto px-3 py-2 font-sans text-[13px] leading-5 break-words whitespace-pre-wrap">{c.text}</pre>
              </div>
            ))}
          </div>
        ) : null}
        {p.agentNote ? (
          <div className="rounded-lg bg-gray-2 px-3 py-2">
            <div data-testid="proposal-note-label" data-proposer={who.kind} className="text-1 font-medium text-gray-11">{noteLabel(who, principalName)}</div>
            <p className="mt-0.5 text-[13px] leading-5 break-words whitespace-pre-wrap text-gray-12">{humanTimes(p.agentNote)}</p>
          </div>
        ) : null}
        {p.evidence.length ? (
          <div className="flex flex-wrap items-center gap-1.5 text-1">
            <span className="text-gray-10">Evidence</span>
            {p.evidence.map((e, i) => {
              const href = refHref(e.ref);
              return href ? (
                <Link key={i} href={href} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-blue-11 shadow-[var(--shadow-border)] hover:bg-blue-3">{e.label} {e.ref && !e.label.includes(e.ref) ? <span className="font-mono text-0 text-gray-10">{e.ref}</span> : null}</Link>
              ) : (
                <span key={i} className="rounded-md px-1.5 py-0.5 shadow-[var(--shadow-border)]">{e.label}{e.ref && !e.label.includes(e.ref) && !/^not reversible/i.test(e.label) ? <> <span className="font-mono text-0 text-gray-10">{e.ref}</span></> : null}</span>
              );
            })}
          </div>
        ) : null}
        {!pending ? (
          <div className="text-1 text-gray-10">
            {p.decidedBy ? <>Decided by {principalName(p.decidedBy)}{p.decidedAt ? ` on ${fmtDateTime(p.decidedAt)}` : ""}</> : null}
            {p.decisionCode ? <> · reason <code className="font-mono">{p.decisionCode}</code></> : null}
            {p.decisionNote ? <> · {p.decisionNote}</> : null}
            {p.executedActionSeq !== null ? <> · <Link href="/app/audit" className="text-blue-11 hover:underline">action #{p.executedActionSeq}</Link></> : null}
          </div>
        ) : null}
      </div>
      {pending ? (
        <div className="flex flex-col gap-2 border-t border-[var(--app-border)] bg-gray-2 px-4 py-3">
          {mode !== "idle" ? (
            <div className="grid gap-2 tablet:grid-cols-[200px_1fr]">
              <select aria-label="Reason code" value={reason} onChange={(e) => setReason(e.target.value)} className="h-8 rounded-lg border border-[var(--app-border)] bg-card px-2 text-[13px]">
                <option value="">{mode === "deny" ? "Choose a reason" : "Reason (optional)"}</option>
                {(mode === "deny" ? DENY_REASONS : [{ code: "looks_right", label: "Looks right" }, { code: "verified_source", label: "Verified against the source" }]).map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
              </select>
              <input aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional, never sent to the agent)" className="h-8 min-w-0 rounded-lg border border-[var(--app-border)] bg-card px-2 text-[13px]" />
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {isSuggestion ? (
              <>
                <Button variant="primary" size="sm" disabled={m.pending} onClick={() => void decide("start")}>Start</Button>
                <Button size="sm" disabled={m.pending} onClick={() => void decide("dismiss")}>Dismiss</Button>
              </>
            ) : mode === "deny" ? (
              <>
                <Button data-testid={TID.inboxDeny} variant="danger" size="sm" disabled={m.pending || !reason} onClick={() => void decide("deny", { reasonCode: reason, note: note || null })}><X /> Confirm deny</Button>
                <Button variant="ghost" size="sm" onClick={() => setMode("idle")}>Cancel</Button>
              </>
            ) : (
              <>
                <Button data-testid={TID.inboxApprove} variant="primary" size="sm" disabled={m.pending || expired} onClick={() => void decide("approve", { reasonCode: reason || null, note: note || null })}><Check /> Approve</Button>
                <Button data-testid={TID.inboxDeny} size="sm" disabled={m.pending} onClick={() => { setMode("deny"); setReason(""); }}><X /> Deny</Button>
                {mode === "idle" ? <Button variant="ghost" size="sm" onClick={() => setMode("approve-note")}>Add reason</Button> : null}
              </>
            )}
            <span className="flex-1" />
            {m.error ? <span role="alert" className="text-1 text-red-11">{errorText(m.error)}</span> : null}
            {result && !result.ok ? <span role="alert" className="text-1 text-red-11">{result.code}: {humanTimes(result.message)}</span> : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
