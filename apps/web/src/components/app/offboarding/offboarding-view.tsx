"use client";
// Offboarding list and case view (wave 2, w2-offboarding). The case shows the eight ordered steps with their status,
// detail and proposal link; pending proposals render as approval cards, and once final pay is done the direct steps
// run with "Run remaining steps" (one offboarding.run_step call each, so each gets its own action row).
import Link from "next/link";
import { useState } from "react";
import { Badge, Button, Card, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { W2_OFFBOARDING_TID, w2OffboardingTid, type OffboardingCase, type OffboardingStep, type Proposal, type Worker, type PageResult } from "@weft/contracts";
import { client, errorText, useGet, useMutation } from "@/lib/api/hooks";
import { fmtDate, fmtDateTime } from "../format";
import { PageHeader } from "../page";
import { ProposalCard } from "../inbox/proposal-card";

const STEP_LABEL: Record<OffboardingStep["kind"], string> = {
  final_pay: "Final pay", directory_suspend: "Directory suspend", sso_deactivate: "SSO deactivation", group_removal: "Group removal",
  app_removal: "App removal", device_lock: "Device lock", cobra_notice: "COBRA notice", benefits_terminate: "Benefits termination",
};
const PROPOSAL_STEPS = new Set(["final_pay", "directory_suspend", "sso_deactivate", "device_lock"]);
const STEP_COMMAND: Partial<Record<OffboardingStep["kind"], string>> = {
  final_pay: "offboarding.final_pay", directory_suspend: "offboarding.suspend_directory", sso_deactivate: "offboarding.deactivate_sso", device_lock: "offboarding.lock_device",
};
const DIRECT_STEPS = ["group_removal", "app_removal", "cobra_notice", "benefits_terminate"] as const;
const STEP_TONE: Record<OffboardingStep["status"], "gray" | "amber" | "green" | "red" | "blue"> = { pending: "gray", proposed: "amber", done: "green", skipped: "gray", failed: "red" };
const CASE_TONE: Record<OffboardingCase["status"], "blue" | "green" | "gray"> = { open: "blue", complete: "green", cancelled: "gray" };
const human = (s: string) => s.replaceAll("_", " ");
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function useWorkerNames(): Map<string, string> {
  const w = useGet("/v1/workers", { query: { limit: 100 } });
  return new Map(((w.data as PageResult<Worker> | undefined)?.data ?? []).map((x) => [x.id, x.displayName]));
}

export function OffboardingList() {
  const q = useGet("/v1/offboarding", { refreshMs: 5_000 });
  const names = useWorkerNames();
  const cases = ((q.data ?? []) as OffboardingCase[]).slice().reverse();
  return (
    <div className="mx-auto w-full max-w-[1000px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title="Offboarding" subtitle="Terminations with final pay, access revocation, benefits and the COBRA notice. Start one from a person's page with Terminate." />
      {q.error ? <div role="alert" className="text-1 text-red-11">{errorText(q.error)}</div> : null}
      <Card className="overflow-x-auto">
        <Table data-testid={W2_OFFBOARDING_TID.caseList}>
          <THead><TR><TH>Person</TH><TH>Kind</TH><TH>Last day</TH><TH>Steps</TH><TH>Status</TH></TR></THead>
          <TBody>
            {cases.length === 0 ? <TR><TD colSpan={5} className="text-gray-10">No offboarding cases yet.</TD></TR> : null}
            {cases.map((c) => {
              const finished = c.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
              return (
                <TR key={c.id} data-testid={w2OffboardingTid.caseRow(c.id)}>
                  <TD><Link href={`/app/offboarding/${c.id}`} className="font-medium hover:underline">{names.get(c.workerId) ?? c.workerId}</Link></TD>
                  <TD className="capitalize">{human(c.kind)}</TD>
                  <TD>{fmtDate(c.lastDay, { month: "short", day: "numeric", year: "numeric" })}</TD>
                  <TD>{finished} of {c.steps.length}</TD>
                  <TD><Badge tone={CASE_TONE[c.status]}>{c.status}</Badge></TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}

function PendingProposal({ id }: { id: string }) {
  const p = useGet("/v1/proposals/:id", { params: { id }, refreshMs: 5_000 });
  return p.data ? <ProposalCard p={p.data as Proposal} /> : null;
}

export function OffboardingCaseView({ id }: { id: string }) {
  const q = useGet("/v1/offboarding/:id", { params: { id }, refreshMs: 5_000 });
  const names = useWorkerNames();
  const c = q.data as OffboardingCase | undefined;
  const [ran, setRan] = useState<string | null>(null);
  // A proposal step left pending (its proposal was refused, denied or expired) can be run by the person directly.
  const runNow = useMutation(async (step: OffboardingStep) => {
    const body = step.kind === "final_pay" ? { case_id: id, pay_unused_pto: !step.detail.includes("no PTO payout") } : { case_id: id };
    return client.post("/v1/tools/:name", { params: { name: STEP_COMMAND[step.kind]! }, body });
  });
  const runRemaining = useMutation(async (steps: string[]) => {
    for (const step of steps) await client.post("/v1/tools/:name", { params: { name: "offboarding.run_step" }, body: { case_id: id, step } });
    return steps.length;
  });
  if (q.error) return <div className="mx-auto w-full max-w-[1000px] px-4 py-8"><div role="alert" className="text-1 text-red-11">{errorText(q.error)}</div></div>;
  if (!c) return <div className="mx-auto w-full max-w-[1000px] px-4 py-8 text-gray-10">Loading case...</div>;
  const finalPayDone = c.steps.find((s) => s.kind === "final_pay")?.status === "done";
  const pendingDirect = DIRECT_STEPS.filter((k) => c.steps.find((s) => s.kind === k)?.status === "pending");
  const proposed = c.steps.filter((s) => s.status === "proposed" && s.proposalId);
  const name = names.get(c.workerId) ?? c.workerId;
  return (
    <div className="mx-auto w-full max-w-[1000px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title={`Offboarding ${name}`} subtitle={`${capitalize(human(c.kind))} termination, last day ${fmtDate(c.lastDay, { month: "short", day: "numeric", year: "numeric" })}. Opened ${fmtDateTime(c.createdAt)}.`}
        meta={<span className="flex items-center gap-3"><Badge data-testid={W2_OFFBOARDING_TID.caseStatus} tone={CASE_TONE[c.status]} size="md">{c.status === "complete" ? "Complete" : c.status === "open" ? "Open" : "Cancelled"}</Badge><Link href={`/app/people/${c.workerId}`} className="text-2 text-accent-11 hover:underline">View person</Link></span>}
        actions={c.status === "open" ? (
          <Button data-testid={W2_OFFBOARDING_TID.runRemaining} variant="primary" size="sm" disabled={!finalPayDone || pendingDirect.length === 0 || runRemaining.pending}
            title={finalPayDone ? undefined : "Approve final pay first"} onClick={() => void runRemaining.run([...pendingDirect]).then((n) => { if (n !== undefined) setRan(`Ran ${n} step${n === 1 ? "" : "s"}`); })}>
            Run remaining steps
          </Button>
        ) : null} />
      {runRemaining.error ? <div role="alert" className="mb-3 text-1 text-red-11">{errorText(runRemaining.error)}</div> : null}
      {runNow.error ? <div role="alert" className="mb-3 text-1 text-red-11">{errorText(runNow.error)}</div> : null}
      {ran ? <div className="mb-3 text-1 text-gray-11" role="status">{ran}</div> : null}
      <Card className="overflow-x-auto">
        <Table data-testid={W2_OFFBOARDING_TID.caseSteps}>
          <THead><TR><TH>#</TH><TH>Step</TH><TH>Status</TH><TH>Detail</TH><TH>Proposal</TH></TR></THead>
          <TBody>
            {c.steps.map((s, i) => (
              <TR key={s.id} data-testid={w2OffboardingTid.step(s.kind)} data-status={s.status}>
                <TD className="text-gray-10 tabular-nums">{i + 1}</TD>
                <TD className="font-medium">{STEP_LABEL[s.kind]}{PROPOSAL_STEPS.has(s.kind) ? <span className="ml-1.5 text-0 text-gray-10">approval</span> : null}</TD>
                <TD><Badge data-testid={w2OffboardingTid.stepStatus(s.kind)} tone={STEP_TONE[s.status]}>{s.status}</Badge></TD>
                <TD className="max-w-[420px] text-[13px] break-words text-gray-11">{s.detail}{s.actionSeq !== null ? <> · <Link href="/app/audit" className="hover:underline">action {s.actionSeq}</Link></> : null}</TD>
                <TD>
                  <span className="flex flex-wrap items-center gap-2">
                    {s.proposalId ? <Link data-testid={w2OffboardingTid.stepProposal(s.kind)} href={`/app/inbox?proposal=${s.proposalId}`} className="font-mono text-0 text-accent-11 hover:underline">{s.proposalId}</Link> : <span className="text-gray-10">-</span>}
                    {c.status === "open" && s.status === "pending" && PROPOSAL_STEPS.has(s.kind) ? (
                      <Button data-testid={w2OffboardingTid.stepRunNow(s.kind)} size="xs" disabled={runNow.pending} title="No pending proposal: run this step now, as you" onClick={() => void runNow.run(s)}>Run now</Button>
                    ) : null}
                  </span>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      {proposed.length ? (
        <section className="mt-6 flex flex-col gap-3">
          <h2 className="text-3 font-semibold">Waiting for approval</h2>
          {proposed.map((s) => <PendingProposal key={s.id} id={s.proposalId!} />)}
        </section>
      ) : null}
    </div>
  );
}
