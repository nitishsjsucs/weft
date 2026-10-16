"use client";
// Person header actions (Terminate). Owner: w2-offboarding (docs/wave2.md). Mounted by people-view.tsx.
// Terminate posts TerminationInput to /v1/workers/:id/terminate and opens the new offboarding case.
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Drawer } from "@weft/ui/components";
import { W2_OFFBOARDING_TID, type OffboardingCase, type TerminationKind } from "@weft/contracts";
import { client, errorText, useGet, useMutation, useSimClock } from "@/lib/api/hooks";

const KINDS: { value: TerminationKind; label: string }[] = [
  { value: "voluntary", label: "Voluntary (resignation)" }, { value: "involuntary", label: "Involuntary" },
  { value: "layoff", label: "Layoff" }, { value: "end_of_contract", label: "End of contract" },
];
const field = "h-8 w-full rounded-lg border border-[var(--app-border)] bg-card px-2 text-[13px]";

export function PersonActions({ workerId, status }: { workerId: string; status: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const cases = useGet("/v1/offboarding", { enabled: status === "offboarding" || status === "inactive" });
  const mine = ((cases.data ?? []) as OffboardingCase[]).filter((c) => c.workerId === workerId).at(-1);
  if (mine) {
    return <Link data-testid={W2_OFFBOARDING_TID.personCaseLink} href={`/app/offboarding/${mine.id}`} className="text-2 text-accent-11 underline-offset-2 hover:underline">Offboarding case ({mine.status})</Link>;
  }
  if (status !== "active" && status !== "onboarding") return null;
  return (
    <>
      <Button data-testid={W2_OFFBOARDING_TID.personTerminate} variant="danger" size="xs" onClick={() => setOpen(true)}>Terminate</Button>
      {open ? <TerminateDrawer workerId={workerId} onClose={() => setOpen(false)} /> : null}
    </>
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
