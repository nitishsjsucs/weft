"use client";
// Person header actions (Terminate, Off-cycle pay). Owner: w2-offboarding (docs/wave2.md). Mounted by people-view.tsx.
// Terminate posts TerminationInput to /v1/workers/:id/terminate and opens the new offboarding case. Off-cycle pay
// posts OffCycleRequest to /v1/payrolls/off-cycle and shows the resulting proposal card in the drawer.
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Drawer } from "@weft/ui/components";
import { W2_OFFBOARDING_TID, type OffboardingCase, type Proposal, type TerminationKind } from "@weft/contracts";
import { ProposalCard } from "../inbox/proposal-card";
import { client, errorText, useGet, useMutation, useSimClock } from "@/lib/api/hooks";
import { useCan } from "@/lib/api/access";

const KINDS: { value: TerminationKind; label: string }[] = [
  { value: "voluntary", label: "Voluntary (resignation)" }, { value: "involuntary", label: "Involuntary" },
  { value: "layoff", label: "Layoff" }, { value: "end_of_contract", label: "End of contract" },
];
const field = "h-8 w-full rounded-lg border border-[var(--app-border)] bg-card px-2 text-[13px]";

export function PersonActions({ workerId, status }: { workerId: string; status: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const [offCycle, setOffCycle] = useState(false);
  // The same query people-view.tsx makes (shared cache); WorkerDetail carries the worker under `worker`.
  const detail = useGet("/v1/workers/:id", { params: { id: workerId } });
  const type = ((detail.data as { worker?: { type?: string } } | undefined)?.worker?.type) ?? null;
  const cases = useGet("/v1/offboarding", { enabled: status === "offboarding" || status === "inactive" });
  const mine = ((cases.data ?? []) as OffboardingCase[]).filter((c) => c.workerId === workerId).at(-1);
  // Off-cycle pay is a payroll proposal and Terminate a people change: a manager (people view, payroll none) gets neither.
  const can = useCan();
  if (mine) {
    return <Link data-testid={W2_OFFBOARDING_TID.personCaseLink} href={`/app/offboarding/${mine.id}`} className="text-2 text-accent-11 underline-offset-2 hover:underline">Offboarding case ({mine.status})</Link>;
  }
  if (status !== "active" && status !== "onboarding") return null;
  if (type !== null && type !== "employee") return null;   // contractors end through their contract
  return (
    <>
      {status === "active" && can("payroll", "edit") ? <Button data-testid={W2_OFFBOARDING_TID.personOffCycle} size="xs" onClick={() => setOffCycle(true)}>Off-cycle pay</Button> : null}
      {can("people", "edit") ? <Button data-testid={W2_OFFBOARDING_TID.personTerminate} variant="danger" size="xs" onClick={() => setOpen(true)}>Terminate</Button> : null}
      {open ? <TerminateDrawer workerId={workerId} onClose={() => setOpen(false)} /> : null}
      {offCycle ? <OffCycleDrawer workerId={workerId} onClose={() => setOffCycle(false)} /> : null}
    </>
  );
}

const REASONS = [{ value: "missed_payroll", label: "Missed payroll" }, { value: "bonus", label: "Bonus only" }, { value: "correction", label: "Correction" }] as const;

/** The semi-monthly period before the one holding `today` (YYYY-MM-DD): the usual "missed" period. */
function previousPeriod(today: string): { start: string; end: string } {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)), d = Number(today.slice(8, 10));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 15) return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-15` };
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  return { start: `${py}-${pad(pm)}-16`, end: `${py}-${pad(pm)}-${pad(new Date(Date.UTC(py, pm, 0)).getUTCDate())}` };
}

/** Dollars typed by a person to integer cents, or null when it is not a plain amount. */
function toCents(dollars: string): number | null {
  const t = dollars.replace(/[$,\s]/g, "");
  if (t === "") return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  return Number(w) * 100 + Number(f.padEnd(2, "0"));
}

function OffCycleDrawer({ workerId, onClose }: { workerId: string; onClose: () => void }) {
  const [periodStartIn, setPeriodStart] = useState("");
  const [periodEndIn, setPeriodEnd] = useState("");
  const [payday, setPayday] = useState("");
  const [reason, setReason] = useState<(typeof REASONS)[number]["value"]>("missed_payroll");
  const [bonus, setBonus] = useState("");
  const [proposalId, setProposalId] = useState<string | null>(null);
  const clock = useSimClock();
  const today = clock.data?.now ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(clock.data.now)) : "";
  const prev = today ? previousPeriod(today) : { start: "", end: "" };
  const periodStart = periodStartIn || prev.start;
  const periodEnd = periodEndIn || prev.end;
  const cents = toCents(bonus);
  const m = useMutation(() => client.post("/v1/payrolls/off-cycle", { body: { workerIds: [workerId], periodStart, periodEnd, payday: payday || today, reason, bonusCents: cents ? { [workerId]: cents } : {} } }));
  const p = useGet("/v1/proposals/:id", { params: { id: proposalId ?? "" }, enabled: !!proposalId, refreshMs: 3_000 });
  const submit = async () => {
    const out = (await m.run()) as { ok?: boolean; status?: string; proposalId?: string } | undefined;
    if (out?.ok && out.status === "pending_approval" && out.proposalId) setProposalId(out.proposalId);
  };
  return (
    <Drawer open onOpenChange={(o) => { if (!o) onClose(); }} title="Off-cycle pay" description="Missed pay for a period, prorated by calendar days when the rate changed in it, plus an optional bonus taxed as supplemental wages. It is proposed for approval first."
      footer={<div className="flex justify-end gap-2"><Button size="sm" onClick={onClose}>Close</Button><Button data-testid={W2_OFFBOARDING_TID.offCycleSubmit} variant="primary" size="sm" disabled={m.pending || !!proposalId || cents === null || !(payday || today) || !periodStart || !periodEnd} onClick={() => void submit()}>Propose</Button></div>}>
      <div className="flex flex-col gap-4 text-[13px]">
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1"><span className="text-gray-11">Period start</span><input data-testid={W2_OFFBOARDING_TID.offCyclePeriodStart} type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className={field} /></label>
          <label className="flex flex-col gap-1"><span className="text-gray-11">Period end</span><input data-testid={W2_OFFBOARDING_TID.offCyclePeriodEnd} type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className={field} /></label>
        </div>
        <label className="flex flex-col gap-1"><span className="text-gray-11">Payday</span><input data-testid={W2_OFFBOARDING_TID.offCyclePayday} type="date" value={payday || today} onChange={(e) => setPayday(e.target.value)} className={field} /></label>
        <label className="flex flex-col gap-1"><span className="text-gray-11">Reason</span>
          <select data-testid={W2_OFFBOARDING_TID.offCycleReason} value={reason} onChange={(e) => setReason(e.target.value as typeof reason)} className={field}>
            {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1"><span className="text-gray-11">Bonus (USD, optional)</span><input data-testid={W2_OFFBOARDING_TID.offCycleBonus} inputMode="decimal" value={bonus} placeholder="0.00" onChange={(e) => setBonus(e.target.value)} className={field} /></label>
        {cents === null ? <div role="alert" className="text-1 text-red-11">Enter the bonus as dollars and cents, for example 1500.00</div> : null}
        {m.error ? <div data-testid={W2_OFFBOARDING_TID.terminateError} role="alert" className="text-1 text-red-11">{errorText(m.error)}</div> : null}
        {p.data ? <ProposalCard p={p.data as Proposal} /> : null}
      </div>
    </Drawer>
  );
}

function TerminateDrawer({ workerId, onClose }: { workerId: string; onClose: () => void }) {
  const router = useRouter();
  const clock = useSimClock();
  const today = clock.data?.now ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(clock.data.now)) : "";
  const [kind, setKind] = useState<TerminationKind>("voluntary");
  const [lastDay, setLastDay] = useState("");
  const [note, setNote] = useState("");
  const [pto, setPto] = useState(true);
  const m = useMutation(() => client.post("/v1/workers/:id/terminate", { params: { id: workerId }, body: { workerId, kind, lastDay: lastDay || today, reasonNote: note, payUnusedPto: pto } }));
  const [refused, setRefused] = useState<{ caseId: string; lines: string[] } | null>(null);
  const submit = async () => {
    const out = (await m.run()) as { ok?: boolean; data?: { case_id?: string; proposals?: { kind: string; refusal: string | null }[] } } | undefined;
    if (!out?.ok || !out.data?.case_id) return;
    const lines = (out.data.proposals ?? []).filter((p) => p.refusal).map((p) => `${p.kind.replaceAll("_", " ")}: ${p.refusal}`);
    if (lines.length) setRefused({ caseId: out.data.case_id, lines });
    else router.push(`/app/offboarding/${out.data.case_id}`);
  };
  return (
    <Drawer open onOpenChange={(o) => { if (!o) onClose(); }} title="Terminate employee" description="Opens an offboarding case. Final pay, directory suspend, SSO deactivation and device lock wait for approval."
      footer={<div className="flex justify-end gap-2"><Button size="sm" onClick={onClose}>Cancel</Button><Button data-testid={W2_OFFBOARDING_TID.terminateSubmit} variant="primary" size="sm" disabled={m.pending || !!refused || !(lastDay || today)} onClick={() => void submit()}>Terminate</Button></div>}>
      <div className="flex flex-col gap-4 text-[13px]">
        <label className="flex flex-col gap-1"><span className="text-gray-11">Kind</span>
          <select data-testid={W2_OFFBOARDING_TID.terminateKind} value={kind} onChange={(e) => setKind(e.target.value as TerminationKind)} className={field}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1"><span className="text-gray-11">Last day</span>
          <input data-testid={W2_OFFBOARDING_TID.terminateLastDay} type="date" value={lastDay || today} onChange={(e) => setLastDay(e.target.value)} className={field} />
        </label>
        <label className="flex flex-col gap-1"><span className="text-gray-11">Note (optional)</span>
          <textarea data-testid={W2_OFFBOARDING_TID.terminateNote} value={note} maxLength={400} onChange={(e) => setNote(e.target.value)} rows={3} className="w-full rounded-lg border border-[var(--app-border)] bg-card px-2 py-1.5 text-[13px]" />
        </label>
        <label className="flex items-center gap-2">
          <input data-testid={W2_OFFBOARDING_TID.terminatePto} type="checkbox" checked={pto} onChange={(e) => setPto(e.target.checked)} />
          <span>Pay unused PTO with final pay</span>
        </label>
        {m.error ? <div data-testid={W2_OFFBOARDING_TID.terminateError} role="alert" className="text-1 text-red-11">{errorText(m.error)}</div> : null}
        {refused ? (
          <div data-testid={W2_OFFBOARDING_TID.terminateError} role="alert" className="flex flex-col gap-1 text-1 text-amber-11">
            <span>The case is open, but these steps could not be proposed:</span>
            {refused.lines.map((l) => <span key={l} className="break-words">{l}</span>)}
            <Link href={`/app/offboarding/${refused.caseId}`} className="text-accent-11 hover:underline">Open the case</Link>
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}
