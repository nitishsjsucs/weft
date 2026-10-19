"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Check, CircleAlert, CircleSlash, Clock, ExternalLink, ShieldAlert } from "lucide-react";
import { ShimmerText } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { TID, W3_CHAT_TID, type ApprovalCardW3, type Proposal, type ProposalStatus } from "@weft/contracts";
import { watchRun, type RunWatch } from "@/lib/api/sse";
import { invalidate } from "@/lib/api/hooks";
import { isChipStep, ranToolsLine, reportOf, stepState, stepSummary, toolLabel, type ReportRef } from "./run-steps";
import { StepReport } from "./chart";
import { ApprovalCard } from "./approval-card";
import { humanDates, humanTimes } from "../format";
import { humanLine } from "../copy";

/** One run in the agent panel: tool trace chips, a shimmer status while it works, then the answer. */
export function RunFeed({ runId, label, latest = true }: { runId: string; label?: string; latest?: boolean }) {
  const [w, setW] = useState<RunWatch>({ run: null, steps: [], trace: null, mode: "idle" });
  // Decisions made on this feed's own cards, so the step line changes at once (the trace re-read follows).
  const [decided, setDecided] = useState<Record<string, ProposalStatus>>({});
  useEffect(() => {
    let last = "";
    return watchRun(runId, (next) => {
      setW(next);
      if (next.run && next.run.status !== last) { last = next.run.status; if (next.run.status !== "running" && next.run.status !== "queued") invalidate(); }
    });
  }, [runId]);
  const status = w.run?.status;
  const working = !status || status === "queued" || status === "running";
  const chips = w.steps.filter(isChipStep);
  const reports = w.steps.map(reportOf).filter((r): r is ReportRef => r !== null);
  // Wave 3: one card per proposal this run filed, built by the API from the stored preview (trace.cards).
  const trace = w.trace as (typeof w.trace & { cards?: ApprovalCardW3[]; proposals?: Proposal[] }) | null;
  const cards = trace?.cards ?? [];
  const proposalOf = (id: string) => trace?.proposals?.find((p) => p.id === id);
  const statusOf = (id: string): ProposalStatus | undefined => decided[id] ?? proposalOf(id)?.status;
  const ran = working ? null : ranToolsLine(w.steps);
  return (
    <div className="flex flex-col gap-1.5" data-tour="agent-run" data-run-id={runId} data-status={status ?? "starting"} data-stream-mode={w.mode}>
      {label ? <div className="text-1 text-gray-10">{label}</div> : null}
      {w.run?.tainted ? (
        <div className="flex items-start gap-1.5 rounded-lg bg-amber-3 px-2 py-1.5 text-1 text-amber-11"><ShieldAlert className="mt-px size-3.5 shrink-0" />This run read untrusted content: {w.run.taintedBy ?? "unknown source"}</div>
      ) : null}
      <ul className="flex flex-col gap-1" data-tour="agent-tool-lines">
        {chips.map((s) => {
          const { tone, note, proposalId } = stepState(s.outcome, statusOf);
          return (
            <li key={s.n} data-testid={TID.agentStep} data-outcome={s.outcome ?? ""} data-state={tone} className="flex min-w-0 items-start gap-1.5 text-[13px] leading-5 text-gray-11 animate-[weft-pop_.25s_ease-out]">
              {tone === "pending" ? <Clock className="mt-0.5 size-3.5 shrink-0 text-amber-11" /> : tone === "refused" || tone === "error" ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-red-11" /> : tone === "declined" ? <CircleSlash className="mt-0.5 size-3.5 shrink-0 text-gray-9" /> : <Check className="mt-0.5 size-3.5 shrink-0 text-gray-9" />}
              <span className="min-w-0 break-words">{stepSummary(s)}{s.toolName && stepSummary(s) !== toolLabel(s.toolName) ? <span className="ml-1.5 font-mono text-0 text-gray-9">{toolLabel(s.toolName)}</span> : null}{proposalId && note ? <span className={tone === "pending" ? "text-amber-11" : "text-gray-10"}> ({note})</span> : null}</span>
            </li>
          );
        })}
      </ul>
      {reports.map((r) => <StepReport key={r.stepN} runId={runId} item={r} />)}
      {cards.map((c) => <ApprovalCard key={c.proposalId} card={c} status={proposalOf(c.proposalId)?.status} taintedBy={proposalOf(c.proposalId)?.taintedBy ?? null} onDecided={(r) => { if (r.ok) setDecided((d) => ({ ...d, [c.proposalId]: r.proposal.status })); invalidate(); }} />)}
      {ran ? <div data-testid={W3_CHAT_TID.ranTools} className="text-1 text-gray-10">{ran}</div> : null}
      <div data-testid={latest ? TID.agentStatus : undefined} data-status={status ?? "starting"} className="text-[13px]">
        {working ? <ShimmerText>Working...</ShimmerText>
          : status === "waiting" ? <span className="text-amber-11">Waiting for approval in the Inbox</span>
          : status === "done" ? <span className="text-gray-10">Done</span>
          : <span className="text-red-11">{status}{w.run?.terminalReason ? `: ${w.run.terminalReason}` : ""}</span>}
      </div>
      {/* A routine's summary is its tool outcomes joined (ids and action numbers); a chat answer is the model's own
          words and keeps the result ids it cites. */}
      {w.run?.summary && !working ? (
        <p data-testid={TID.agentAnswer} className="text-2 leading-[22px] whitespace-pre-wrap text-gray-12">{w.run.routineRunId ? humanLine(w.run.summary) : humanDates(humanTimes(w.run.summary))}</p>
      ) : null}
      <Link href={`/app/runs/${runId}`} className={cn("inline-flex w-fit items-center gap-1 text-1 text-gray-10 hover:text-foreground")}>Open run <ExternalLink className="size-3" /></Link>
    </div>
  );
}
