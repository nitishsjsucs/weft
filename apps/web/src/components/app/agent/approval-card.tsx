"use client";
// Interactive approval card (wave 3, ApprovalCardW3). Every value on it comes from the proposal's stored preview,
// built by the executor's approvalCardOf; the agent's own words never reach it. Approve and Deny call the same decide
// route as the Inbox (inbox/decide.ts), so a double click or a race with another surface still executes once; Open
// goes to the Inbox card with the full preview, the content to be sent and the agent's note. A proposal from a run
// that read untrusted content shows the Inbox's warning and is not approvable from the card: approve it in the Inbox,
// where the full content is on screen (Deny stays, since denying never executes anything).
import Link from "next/link";
import { useState } from "react";
import { Check, ExternalLink, ShieldAlert, X } from "lucide-react";
import { formatCents, W3_CHAT_TID, type ApprovalCardW3, type DecisionResult, type ProposalStatus, type RiskClass } from "@weft/contracts";
import { Button } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { errorText, useMutation } from "@/lib/api/hooks";
import { decideProposal } from "../inbox/decide";
import { RiskChip } from "../risk";
import { ChangeValue, idleMoneyRow, splitChange } from "../card-rows";
import { cardField, enumWords, humanLine } from "../copy";
import { taintText } from "./untrusted";
import { followInPlace } from "@/lib/url-state";
import { viewPatch } from "../../assist/surface-core";

/** The proposal in the Inbox. On the Inbox itself the Open link writes it in place (followInPlace), so the page shows it. */
const inboxHref = (proposalId: string) => `/app/inbox?proposal=${encodeURIComponent(proposalId)}`;

const OUTCOME: Partial<Record<ProposalStatus, { text: string; tone: string }>> = {
  executed: { text: "Approved and done", tone: "text-green-11" },
  approved: { text: "Approved", tone: "text-green-11" },
  failed: { text: "Approved, but it failed when it ran", tone: "text-red-11" },
  denied: { text: "Denied", tone: "text-gray-11" },
  dismissed: { text: "Dismissed", tone: "text-gray-11" },
  expired: { text: "Expired before anyone decided", tone: "text-gray-11" },
  superseded: { text: "Withdrawn as out of date", tone: "text-gray-11" },
};

/**
 * `status` is the proposal's live status when the caller has it (the run trace, a proposals read); else the card's.
 * `taintedBy` is the proposal row's taint source (the trace's or the proposal read's `taintedBy`); `known` is false
 * until the caller has read the proposal row, and Approve waits for it (fail closed on the taint check).
 */
export function ApprovalCard({ card, status, taintedBy = null, known = true, compact = false, onDecided }: { card: ApprovalCardW3; status?: ProposalStatus; taintedBy?: string | null; known?: boolean; compact?: boolean; onDecided?: (r: DecisionResult) => void }) {
  const [result, setResult] = useState<DecisionResult | null>(null);
  const m = useMutation((decision: "approve" | "deny") => decideProposal(card.proposalId, decision, decision === "deny" ? { reasonCode: "not_needed", note: null } : undefined));
  const live: ProposalStatus = (result?.ok ? result.proposal.status : undefined) ?? status ?? (card.status === "approved" ? "approved" : card.status);
  const pending = live === "pending";
  const outcome = OUTCOME[live];
  async function decide(d: "approve" | "deny") {
    const r = await m.run(d);
    if (r) { setResult(r); onDecided?.(r); }
  }
  const refusal = result && !result.ok ? result : null;
  // A row that changes nothing a person decides on ("not scheduled" to "not paid") is left out.
  const fields = card.fields.map((f) => cardField(f.label, f.value)).filter((c) => { const p = splitChange(c.value); return !(p && idleMoneyRow(p[0], p[1].replace(/^(?:to|→) /, ""))); });

  return (
    <div data-testid={W3_CHAT_TID.card(card.proposalId)} data-status={live} className={cn("flex flex-col gap-2 rounded-xl border border-gray-a4 bg-card p-3 shadow-[var(--shadow-xs)]", compact && "p-2.5")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span data-tour="proposal-risk" className="inline-flex"><RiskChip risk={card.risk as RiskClass} /></span>
        {/* A return or a decline moves nothing: no "$0.00" chip beside the amount the headline names. */}
        {card.moneyCents ? <span className="text-1 font-medium tabular-nums text-gray-12">{formatCents(card.moneyCents)}</span> : null}
        <span className="flex-1" />
        <span className="text-0 text-gray-10">{pending ? "Needs approval" : "Decided"}</span>
      </div>
      {taintedBy ? (
        <div data-testid={W3_CHAT_TID.cardTainted(card.proposalId)} role="alert" className="flex items-start gap-1.5 rounded-lg bg-amber-3 px-2 py-1.5 text-1 text-amber-11">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words" title={taintedBy}>This run read untrusted content: {taintText(taintedBy)}.{pending ? " Review it in the Inbox before approving." : ""}</span>
        </div>
      ) : null}
      <p className="text-[13px] leading-5 font-medium break-words text-gray-12">{humanLine(card.headline)}</p>
      <dl className="flex flex-col gap-0.5 text-1 text-gray-11">
        {card.subjectName ? <div className="flex gap-1.5"><dt className="text-gray-10">For</dt><dd className="min-w-0 break-words">{card.subjectName}</dd></div> : null}
        {card.routineName ? <div className="flex gap-1.5"><dt className="text-gray-10">Routine</dt><dd className="min-w-0 break-words">{card.routineName}</dd></div> : null}
        {card.approverName ? <div className="flex gap-1.5"><dt className="text-gray-10">{pending ? "Asked by" : "Decided by"}</dt><dd className="min-w-0 break-words">{card.approverName}</dd></div> : null}
      </dl>
      {fields.length > 0 ? (
        <dl className="flex flex-col divide-y divide-gray-a3 rounded-lg bg-gray-2 px-2 py-1 text-1">
          {fields.map((c, i) => (
            <div key={i} className="flex items-start justify-between gap-3 py-1">
              <dt className="min-w-0 break-words text-gray-11">{c.label}</dt>
              <dd className="min-w-0 text-right font-medium tabular-nums break-words text-gray-12"><ChangeValue value={c.value} /></dd>
            </div>
          ))}
        </dl>
      ) : null}
      {outcome ? <p className={cn("text-1 font-medium", outcome.tone)}>{outcome.text}</p> : null}
      {refusal ? <p role="alert" title={refusal.code} className="text-1 text-red-11">{refusal.message}</p> : null}
      {m.error ? <p role="alert" className="text-1 text-red-11">{errorText(m.error)}</p> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {pending ? (
          <>
            {taintedBy || !known ? null : <Button data-testid={W3_CHAT_TID.cardApprove(card.proposalId)} data-tour="proposal-approve" variant="primary" size="sm" disabled={m.pending} onClick={() => void decide("approve")}><Check /> Approve</Button>}
            <Button data-testid={W3_CHAT_TID.cardDeny(card.proposalId)} variant="secondary" size="sm" disabled={m.pending} onClick={() => void decide("deny")}><X /> Deny</Button>
          </>
        ) : null}
        <Button asChild variant="ghost" size="sm"><Link href={inboxHref(card.proposalId)} onClick={(e) => followInPlace(e, inboxHref(card.proposalId), viewPatch(inboxHref(card.proposalId)))}>Open <ExternalLink className="size-3" /></Link></Button>
      </div>
    </div>
  );
}
