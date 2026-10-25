"use client";
import Link from "next/link";
import { useState } from "react";
import { Check, Clock, ExternalLink, ShieldAlert, X } from "lucide-react";
import { Badge, Button, Card, DiffTable } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { TID, tid, type DecisionResult, type Proposal } from "@weft/contracts";
import { errorText, useMutation, useSimClock } from "@/lib/api/hooks";
import { cents, fmtDateTime, humanTimes, relative, statusLabel } from "../format";
import { auditLabel, codeWords, humanCopy, humanLine, splitChecks, valueText, type Severity } from "../copy";
import { RULE_LABEL, SEVERITY_TONE } from "../expenses/labels";
import { principalName, refHref } from "../refs";
import { noteLabel, proposerOf, type Proposer } from "./proposer";
import { useRoutineNames } from "../routine-names";
import { RiskChip } from "../risk";
import { decideProposal, type Decision } from "./decide";
import { taintText } from "../agent/untrusted";
import { idleMoneyRow } from "../card-rows";

const SEVERITY_WORD: Record<Severity, string> = { block: "Blocks", review: "Review", info: "Note" };
const APPROVE_REASONS = [{ code: "looks_right", label: "Looks right" }, { code: "verified_source", label: "Verified against the source" }] as const;
/** A decision's reason code as the words the person chose it by. */
export function reasonLabel(code: string): string {
  return [...DENY_REASONS, ...APPROVE_REASONS].find((r) => r.code === code)?.label ?? statusLabel(code);
}

export const DENY_REASONS = [
  { code: "incorrect", label: "Incorrect or not grounded" },
  { code: "needs_changes", label: "Needs changes" },
  { code: "not_needed", label: "Not needed" },
  { code: "wrong_timing", label: "Wrong timing" },
  { code: "other", label: "Other" },
] as const;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-1 text-gray-10">{label}</dt>
      <dd className="min-w-0 text-[13px] break-words">{children}</dd>
    </div>
  );
}

/** A content block's heading: a decision note stays on the claim, so it is not labelled as content to be sent. */
export function contentLabel(label: string): string {
  if (label === "Content to be sent") return label;
  if (/^Decision note$/i.test(label)) return "Decision note (kept on the claim)";
  return `Content to be sent: ${label}`;
}

/** Who proposed the change, with the routine run and a link to the agent run when there is one. */
function ProposedBy({ who }: { who: Proposer }) {
  const names = useRoutineNames(who.kind === "routine" ? [who.routineRunId] : []);
  const run = (id: string | null) => id ? <Link className="inline-flex items-center gap-0.5 text-blue-11 hover:underline" href={`/app/runs/${id}`}>Open run <ExternalLink className="size-3" /></Link> : null;
  switch (who.kind) {
    // The routine run id is for whoever traces the run, so it sits behind the word, not on the card.
    case "routine": return (
      <span className="flex flex-wrap items-baseline gap-x-2">
        <details className="inline-block">
          <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden" title="Show the routine run id">{names[who.routineRunId] ? `Routine: ${names[who.routineRunId]}` : "Routine"}</summary> <span className="font-mono text-0 text-gray-10 select-all">{who.routineRunId}</span>
        </details>
        {run(who.runId)}
      </span>
    );
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
  const m = useMutation((decision: Decision, body?: { reasonCode: string | null; note: string | null }) => decideProposal(p.id, decision, body));

  async function decide(decision: Decision, body?: { reasonCode: string | null; note: string | null }) {
    const r = await m.run(decision, body);
    if (r) setResult(r as DecisionResult);
  }
  const pending = p.status === "pending";
  const isSuggestion = p.kind === "suggestion";
  const expired = new Date(p.expiresAt).getTime() <= new Date(now).getTime();
  const who = proposerOf(p);
  const diff = splitChecks(p.diff);
  // A row that changes nothing a person decides on ("not scheduled" to "not paid" on a return) is left out, and so is
  // a row whose before and after read the same ("Excluded (blocked) None → None").
  const shown = diff.rows
    .filter((r) => !idleMoneyRow(String(r.before ?? ""), String(r.after ?? "")))
    .map((r) => ({ ...r, label: humanLine(r.label), before: valueText(r.before), after: valueText(r.after) }))
    .filter((r) => r.before !== r.after);

  return (
    <Card data-testid={tid.inboxCard(p.id)} data-tour="inbox-card" data-proposal-id={p.id} data-command={p.command ?? undefined} data-has-diff={p.diff.length ? "true" : "false"} data-status={p.status} data-tainted={p.taintedBy ? "true" : "false"} className="overflow-hidden">
      {p.taintedBy ? (
        <div data-testid={TID.inboxTaintedBanner} role="alert" className="flex items-start gap-2 border-b border-amber-9/30 bg-amber-3 px-4 py-2 text-[13px] text-amber-11">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words" title={p.taintedBy}>This run read untrusted content: {taintText(p.taintedBy)}. Read the content below before you approve.</span>
        </div>
      ) : null}
      <div className="flex flex-col gap-3 px-4 py-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <span data-tour="proposal-risk" className="inline-flex"><RiskChip risk={p.risk} /></span>
          {isSuggestion ? <Badge tone="blue">Suggestion</Badge> : null}
          {p.kind === "routine_enable" ? <Badge tone="blue">Enable routine</Badge> : null}
          {p.kind === "secret_request" ? <Badge tone="amber">Secret request</Badge> : null}
          {p.command ? <code className="rounded bg-gray-3 px-1.5 py-0.5 font-mono text-0 text-gray-11">{p.command}</code> : null}
          <span className="flex-1" />
          {pending ? (
            <span className={cn("inline-flex items-center gap-1 text-1 tabular", expired ? "text-red-11" : "text-gray-10")} title={`Expires ${fmtDateTime(p.expiresAt)}`}>
              <Clock className="size-3.5" /> {expired ? "Expired" : `Expires ${relative(p.expiresAt, now)}`}
            </span>
          ) : <Badge tone={p.status === "executed" || p.status === "approved" ? "green" : p.status === "denied" || p.status === "failed" ? "red" : "gray"}>{statusLabel(p.status)}</Badge>}
        </div>
        <h3 className="text-3 font-medium leading-6 text-balance break-words">{humanLine(p.headline)}</h3>
        {/* On a phone the four facts read as one line, so the diff, the evidence and Approve fit above the tour's sheet. */}
        <p className="text-1 text-gray-11 mobile:hidden">
          For {principalName(p.onBehalfOf)} · {!p.moneyCents ? "moves no money" : <span className="tabular">moves {cents(p.moneyCents)}</span>} · {p.reversible ? "reversible" : <span className="text-red-11">not reversible</span>}
        </p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 max-mobile:hidden tablet:grid-cols-4">
          <Field label="On behalf of">{principalName(p.onBehalfOf)}</Field>
          <Field label="Moves money">{!p.moneyCents ? "No" : <span className="tabular">{cents(p.moneyCents)}</span>}</Field>
          <Field label="Reversible">{p.reversible ? "Yes, from the audit log" : <span className="text-red-11">No</span>}</Field>
          <Field label="Proposed by"><ProposedBy who={who} /></Field>
        </dl>
        {shown.length ? <DiffTable data-testid={TID.proposalDiff} data-tour="proposal-diff" rows={shown} /> : null}
        {diff.checks.length ? (
          <ul data-testid="proposal-checks" className="flex flex-col gap-1.5">
            {diff.checks.map((c, i) => (
              <li key={i} title={c.rule} className="flex min-w-0 items-start gap-2 text-[13px] leading-5">
                {c.severity ? <Badge size="xs" tone={SEVERITY_TONE[c.severity]} className="mt-0.5 shrink-0">{SEVERITY_WORD[c.severity]}</Badge> : null}
                <span className="min-w-0 break-words"><span className="font-medium">Policy check, {(RULE_LABEL[c.rule] ?? codeWords(c.rule)).toLowerCase()}:</span> {c.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {p.content.length ? (
          <div data-testid={TID.proposalContent} className="flex flex-col gap-2">
            {p.content.map((c, i) => (
              <div key={i} className="rounded-lg border border-[var(--app-border)]">
                <div className="border-b border-[var(--app-border)] bg-gray-2 px-3 py-1.5 text-1 font-medium text-gray-11">{contentLabel(c.label)}</div>
                <pre data-assist-untrusted="" className="max-w-full overflow-x-auto px-3 py-2 font-sans text-[13px] leading-5 break-words whitespace-pre-wrap">{c.text}</pre>
              </div>
            ))}
          </div>
        ) : null}
        {p.agentNote && !p.content.some((c) => c.text.trim() === p.agentNote!.trim()) ? (
          <div className="rounded-lg bg-gray-2 px-3 py-2">
            <div data-testid="proposal-note-label" data-proposer={who.kind} className="text-1 font-medium text-gray-11">{noteLabel(who, principalName)}</div>
            <p data-assist-untrusted="" className="mt-0.5 text-[13px] leading-5 break-words whitespace-pre-wrap text-gray-12 max-mobile:line-clamp-3" title={humanTimes(p.agentNote)}>{humanTimes(p.agentNote)}</p>
          </div>
        ) : null}
        {p.evidence.length ? (
          <div data-tour="proposal-evidence" className="flex flex-wrap items-center gap-1.5 text-1">
            <span className="text-gray-10">Evidence</span>
            {p.evidence.map((e, i) => {
              const href = refHref(e.ref);
              return href ? (
                // A linked chip names the record and the link opens it, so the raw ref only shows when the label is all there is.
                <Link key={i} href={href} title={e.ref} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-blue-11 shadow-[var(--shadow-border)] hover:bg-blue-3">{e.label.trim() ? e.label : e.ref}</Link>
              ) : (
                <span key={i} title={e.ref || undefined} className="rounded-md px-1.5 py-0.5 shadow-[var(--shadow-border)]">{humanLine(e.label) || e.label}{e.ref && !e.label.includes(e.ref) && !/^not reversible/i.test(e.label) && !/^[a-z]{2,5}_\w*\d/.test(e.ref) ? <> <span className="text-0 text-gray-10">{humanLine(e.ref)}</span></> : null}</span>
              );
            })}
          </div>
        ) : null}
        {!pending ? (
          <div className="text-1 text-gray-10">
            {p.decidedBy ? <>Decided by {principalName(p.decidedBy)}{p.decidedAt ? ` on ${fmtDateTime(p.decidedAt)}` : ""}</> : null}
            {p.decisionCode ? <> · Reason: {reasonLabel(p.decisionCode).toLowerCase()}</> : null}
            {p.decisionNote ? <> · <span data-assist-untrusted="">{p.decisionNote}</span></> : null}
            {p.executedActionSeq !== null ? <> · <Link href="/app/audit" className="text-blue-11 hover:underline">{auditLabel(p.executedActionSeq)}</Link></> : null}
          </div>
        ) : null}
      </div>
      {pending ? (
        <div className="flex flex-col gap-2 border-t border-[var(--app-border)] bg-gray-2 px-4 py-3">
          {mode !== "idle" ? (
            <div className="grid gap-2 tablet:grid-cols-[200px_1fr]">
              <select aria-label="Reason code" value={reason} onChange={(e) => setReason(e.target.value)} className="h-8 rounded-lg border border-[var(--app-border)] bg-card px-2 text-[13px]">
                <option value="">{mode === "deny" ? "Choose a reason" : "Reason (optional)"}</option>
                {(mode === "deny" ? DENY_REASONS : APPROVE_REASONS).map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
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
                <Button data-testid={TID.inboxApprove} data-tour="proposal-approve" variant="primary" size="sm" disabled={m.pending || expired} onClick={() => void decide("approve", { reasonCode: reason || null, note: note || null })}><Check /> Approve</Button>
                <Button data-testid={TID.inboxDeny} size="sm" disabled={m.pending} onClick={() => { setMode("deny"); setReason(""); }}><X /> Deny</Button>
                {mode === "idle" ? <Button variant="ghost" size="sm" onClick={() => setMode("approve-note")}>Add reason</Button> : null}
              </>
            )}
            <span className="flex-1" />
            {m.error ? <span role="alert" className="text-1 text-red-11">{errorText(m.error)}</span> : null}
            {result && !result.ok ? <span role="alert" title={result.code} className="text-1 text-red-11">{humanTimes(result.message)}</span> : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
