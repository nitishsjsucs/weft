"use client";
// The agent panel before a thread starts: prompts that fit the page (each works on the scripted provider too) and the
// most recent chat runs, so a new viewer sees what the agent has already answered. Opening a run adds it to the thread.
import { History, Sparkles } from "lucide-react";
import { useGet } from "@/lib/api/hooks";
import { fmtDateTime } from "../format";
import { answerPlain } from "./answer";

function promptsFor(pathname: string): string[] {
  if (pathname.startsWith("/app/payroll")) return ["What is the status of the draft payroll?", "Why is the NY raise flagged on this run?", "Show payroll cost by month"];
  if (pathname.startsWith("/app/expenses")) return ["What do the travel claims add up to?", "What is the meal policy?", "Approve all the pending expenses"];
  if (pathname.startsWith("/app/time-off") || pathname.startsWith("/app/people")) return ["How do I request time off?", "Show payroll cost by month", "Approve everything"];
  return ["Show payroll cost by month", "What is the status of the draft payroll?", "Approve everything"];
}

export function PanelStart({ pathname, onAsk, onOpen }: { pathname: string; onAsk: (text: string) => void; onOpen: (runId: string, label: string) => void }) {
  const runs = useGet("/v1/agent/runs", { query: { limit: 100 } });
  const recent = [...(((runs.data as { data?: unknown[] } | undefined)?.data ?? []) as { id: string; trigger: string; summary: string | null; createdAt: string }[])]
    .filter((r) => r.trigger === "chat" && r.summary)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 4);
  return (
    <div className="mt-4 flex flex-col gap-4" data-testid="agent-panel-start">
      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-1 font-medium text-gray-10"><Sparkles className="size-3.5" /> Try asking</div>
        <div className="flex flex-col gap-1.5">
          {promptsFor(pathname).map((p) => (
            <button key={p} type="button" onClick={() => onAsk(p)} className="rounded-lg px-2.5 py-1.5 text-left text-2 shadow-[var(--shadow-border)] hover:bg-gray-2">{p}</button>
          ))}
        </div>
      </div>
      {recent.length ? (
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-1 font-medium text-gray-10"><History className="size-3.5" /> Recent answers</div>
          <div className="flex flex-col gap-1.5">
            {recent.map((r) => (
              <button key={r.id} type="button" onClick={() => onOpen(r.id, "Earlier answer")} className="rounded-lg px-2.5 py-1.5 text-left hover:bg-gray-2" data-testid="agent-recent-run">
                <div className="line-clamp-2 text-2" title={answerPlain(r.summary ?? "") || undefined}>{answerPlain(r.summary ?? "").replace(/\.$/, "")}</div>
                <div className="text-1 text-gray-10">{fmtDateTime(r.createdAt)}</div>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
