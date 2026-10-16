"use client";
// Per-routine autonomy (wave 3, w3-parity-routines): recommend, approve or auto as one segmented control. A change is
// a proposal (routines.set_autonomy) that waits in the Inbox; auto is selectable only when Settings allows it.
import Link from "next/link";
import { useState } from "react";
import { Card } from "@weft/ui/components";
import { W3_ROUTINES_TID, type Proposal, type RoutineDef, type ToolOutcome } from "@weft/contracts";
import { client, errorText, useGet, useMutation } from "@/lib/api/hooks";

export type AutonomyLevel = RoutineDef["autonomy"];
export const AUTONOMY_COPY: Record<AutonomyLevel, { label: string; detail: string }> = {
  recommend: { label: "Recommend", detail: "Reads and drafts run. Every change becomes a suggestion in the Inbox; nothing is changed or sent." },
  approve: { label: "Approve", detail: "Reads, drafts and allowed messages run. Changes to pay, tax, benefits and money wait for approval." },
  auto: { label: "Auto", detail: "Commands that opt in run on their own under their limit in a clean run. Money movement and admin access still wait for approval; a run that read untrusted content falls back to Approve." },
};
const LEVELS: AutonomyLevel[] = ["recommend", "approve", "auto"];

export interface AgentSettings { chatCanPropose: boolean; allowAutoAutonomy: boolean }

export function AutonomyControl({ routine }: { routine: RoutineDef }) {
  const settings = useGet("/v1/settings/agent") as { data: AgentSettings | undefined };
  const pending = useGet("/v1/proposals", { query: { status: "pending", limit: 100 }, refreshMs: 5_000 });
  const waiting = (pending.data?.data ?? []).find((p: Proposal) => p.command === "routines.set_autonomy" && p.subjectRef === routine.id) ?? null;
  const [out, setOut] = useState<ToolOutcome | null>(null);
  const change = useMutation((autonomy: AutonomyLevel) => client.post("/v1/routines/:id/autonomy", { params: { id: routine.id }, body: { autonomy } }) as Promise<ToolOutcome>);
  const allowAuto = settings.data?.allowAutoAutonomy === true;
  const requested = waiting ? (waiting.args as { autonomy?: AutonomyLevel } | null)?.autonomy ?? null : null;
  const pick = async (level: AutonomyLevel) => {
    if (level === routine.autonomy || change.pending) return;
    setOut((await change.run(level)) ?? null);
  };
  return (
    <Card className="p-4">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="flex-1 text-1 font-medium text-gray-10 uppercase">Autonomy</h2>
      </div>
      <div role="radiogroup" aria-label="Autonomy" data-testid={W3_ROUTINES_TID.autonomy(routine.id)} data-level={routine.autonomy}
        className="inline-flex w-full rounded-lg bg-gray-3 p-0.5">
        {LEVELS.map((level) => {
          const active = routine.autonomy === level;
          const disabled = change.pending || (level === "auto" && !allowAuto && !active);
          return (
            <button key={level} type="button" role="radio" aria-checked={active} disabled={disabled}
              data-testid={W3_ROUTINES_TID.autonomyLevel(routine.id, level)} onClick={() => void pick(level)}
              title={level === "auto" && !allowAuto ? "Turn on auto autonomy in Settings first" : AUTONOMY_COPY[level].detail}
              className={`h-7 flex-1 rounded-md px-2 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--blue-9)] disabled:opacity-50 ${active ? "bg-card text-foreground shadow-[var(--shadow-border),var(--shadow-xs)]" : "text-gray-11 hover:text-foreground"}`}>
              {AUTONOMY_COPY[level].label}
              {requested === level ? <span className="ml-1 text-amber-11" aria-label="requested">*</span> : null}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[13px] leading-5 text-gray-11">{AUTONOMY_COPY[routine.autonomy].detail}</p>
      <div data-testid={W3_ROUTINES_TID.autonomyStatus(routine.id)} aria-live="polite" className="mt-2 text-1">
        {waiting ? <p className="text-amber-11">A change to {AUTONOMY_COPY[requested ?? "approve"].label} waits for approval in the <Link href="/app/inbox" className="underline">Inbox</Link>.</p>
          : out && out.ok && out.status === "pending_approval" ? <p className="text-amber-11">Proposed. It waits for approval in the <Link href="/app/inbox" className="underline">Inbox</Link>.</p> : null}
        {!allowAuto ? <p className="text-gray-10">Auto is off for this company. An admin can allow it in <Link href="/app/settings" className="underline">Settings</Link>.</p> : null}
        {change.error ? <p role="alert" className="text-red-11">{errorText(change.error)}</p> : null}
        {out && !out.ok ? <p role="alert" className="text-red-11">{out.refusal.message}</p> : null}
      </div>
    </Card>
  );
}
