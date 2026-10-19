"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FilePlus2, Play, RefreshCw, Send } from "lucide-react";
import { Badge, Button, Drawer } from "@weft/ui/components";
import { TID, type Paycheck, type PayrollRun, type ToolOutcome } from "@weft/contracts";
import { client, errorText, useGet, useMutation, useSimClock } from "@/lib/api/hooks";
import { fmtDate, fmtDateTime, nextPeriodEnd, period, relative, statusLabel } from "../format";
import { PageHeader } from "../page";
import { humanLine } from "../copy";
import { principalName } from "../refs";
import { useAgent } from "../agent-context";
import { agentRunOf } from "../agent/follow";
import { PaycheckDrawer } from "./paycheck-drawer";
import { PaycheckTable } from "./paycheck-table";
import { TotalsStrip } from "./totals";

const STATUS_TONE: Record<PayrollRun["status"], "gray" | "blue" | "green" | "amber" | "red"> = { draft: "gray", pending: "amber", processing: "blue", processed: "green", failed: "red", voided: "gray" };
const SCHEDULE_LABEL: Record<string, string> = { ps_us_semimonthly: "Semi-monthly US payroll", ps_global_monthly: "Monthly global payroll" };

function OutcomeLine({ o }: { o: ToolOutcome | null }) {
  if (!o) return null;
  if (!o.ok) return <span role="alert" title={o.refusal.code} className="text-1 text-red-11">{o.refusal.message}{o.refusal.hint ? ` (${o.refusal.hint})` : ""}</span>;
  if (o.status === "pending_approval") return <span className="text-1 text-amber-11">Sent to the Inbox for approval: {o.title}</span>;
  return <span className="text-1 text-green-11">{o.summary}</span>;
}

export function PayrollReview({ id }: { id: string }) {
  const router = useRouter();
  const agent = useAgent();
  const clock = useSimClock();
  const run = useGet("/v1/payrolls/:id", { params: { id }, refreshMs: 5_000 });
  const pcs = useGet("/v1/payrolls/:id/paychecks", { params: { id }, query: { limit: 100 }, refreshMs: 5_000 });
  const [open, setOpen] = useState<Paycheck | null>(null);
  const [outcome, setOutcome] = useState<ToolOutcome | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [excludeBlocked, setExcludeBlocked] = useState(true);

  const preview = useMutation(() => client.post("/v1/payrolls/:id/preview", { params: { id } }));
  const submit = useMutation((ex: boolean) => client.post("/v1/payrolls/:id/submit", { params: { id }, body: { excludeBlocked: ex } }));
  const review = useMutation(async () => {
    const r = (await client.post("/v1/routines/:id/trigger", { params: { id: "rt_pre_payroll" }, body: { runId: id } })) as { routineRunId: string; agentRunId?: string };
    const agentRunId = await agentRunOf(r.routineRunId, r.agentRunId);
    if (agentRunId) agent.watch(agentRunId, "Pre-payroll review");
    return r;
  });
  const draft = useMutation((payScheduleId: string, periodEnd: string) => client.post("/v1/payrolls/drafts", { body: { payScheduleId, periodEnd } }));

  const r = run.data;
  const data = pcs.data?.data ?? [];
  const blocked = data.filter((p) => p.status === "blocked").length;
  const nr = data.filter((p) => p.reviewGroup === "needs_review").length;
  // GP2: when the agent has proposed submitting this run, say so here and make the human Submit secondary.
  const pendingProps = useGet("/v1/proposals", { query: { status: "pending", limit: 100 }, refreshMs: 5_000 });
  const pendingSubmit = (pendingProps.data?.data ?? []).find((p) => p.command === "payroll.submit_run" && (p.args as { run_id?: string } | null)?.run_id === id) ?? null;
  // A submit card the draft outgrew (a rate change re-previewed it) is withdrawn as STALE_SUBJECT: say so instead of
  // printing its old total, until a review files a current one.
  const supersededProps = useGet("/v1/proposals", { query: { status: "superseded", limit: 100 }, refreshMs: 5_000 });
  const staleSubmit = pendingSubmit ? null : ((supersededProps.data?.data ?? []).filter((p) => p.command === "payroll.submit_run" && p.decisionCode === "STALE_SUBJECT" && (p.args as { run_id?: string } | null)?.run_id === id).at(-1) ?? null);
  const now = clock.data?.now;
  const err = run.error ?? pcs.error ?? preview.error ?? submit.error ?? review.error ?? draft.error;

  if (run.error && !r) return <div className="p-8 text-2 text-red-11" role="alert">{errorText(run.error)}</div>;
  if (!r) return <div className="p-8 text-2 text-gray-10">Loading payroll...</div>;

  const title = `${period(r.periodStart, r.periodEnd)}, ${SCHEDULE_LABEL[r.payScheduleId] ?? r.payScheduleId}`;
  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader
        title={title}
        meta={
          <>
            <Badge data-testid={TID.payrollStatus} data-status={r.status} tone={STATUS_TONE[r.status]} size="md">{statusLabel(r.status)}</Badge>
            <span className="text-1 text-gray-11">Payday {fmtDate(r.payday, { weekday: "short", month: "short", day: "numeric" })}</span>
            {r.status === "draft" ? <span className="text-1 text-gray-11">Approve by {fmtDateTime(r.approvalDeadline)}{now ? ` (${relative(r.approvalDeadline, now)})` : ""}</span> : null}
            {r.approvedBy ? <span className="text-1 text-gray-11">Approved by {principalName(r.approvedBy)}</span> : null}
            {r.bankBatchId ? <span className="font-mono text-0 text-gray-10">batch {r.bankBatchId}</span> : null}
          </>
        }
        actions={
          <>
            <Button data-testid={TID.payrollPreview} size="sm" disabled={preview.pending || r.status !== "draft"} onClick={async () => setOutcome((await preview.run()) ?? null)}><RefreshCw /> Preview again</Button>
            <Button data-testid={TID.payrollRunReview} size="sm" disabled={review.pending || r.status !== "draft"} onClick={() => void review.run()}><Play /> Run review now</Button>
            <Button data-testid={TID.payrollNewDraft} size="sm" disabled={draft.pending} onClick={async () => {
              const o = await draft.run(r.payScheduleId, nextPeriodEnd(r.periodEnd));
              setOutcome(o ?? null);
              const newId = o && o.ok && o.status === "done" ? ((o.data as { runId?: string } | null)?.runId ?? (o.resultId.startsWith("pay_") ? o.resultId : null)) : null;
              if (newId) router.push(`/app/payroll/${newId}`);
            }}><FilePlus2 /> New draft</Button>
            {r.status === "draft" ? (
              <Button data-testid={TID.payrollSubmit} variant={pendingSubmit ? "secondary" : "primary"} size="sm" disabled={submit.pending} onClick={() => { setExcludeBlocked(blocked > 0); setConfirm(true); }}><Send /> Submit</Button>
            ) : null}
          </>
        }
      />
      {pendingSubmit && r.status === "draft" ? (
        <div data-testid="payroll-pending-submit" className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-blue-3 px-3 py-2 text-1 text-blue-11">
          <span className="min-w-0 flex-1">{humanLine(pendingSubmit.headline)}.{(() => {
            // The submit leaves blocked paychecks out, while the totals on this page count every paycheck.
            const ex = pendingSubmit.diff.find((d) => /^excluded/i.test(d.label))?.after;
            return ex && ex !== "none" ? ` ${humanLine(ex)} excluded as blocked, so the totals below, which count every paycheck, are higher.` : "";
          })()} Waiting for approval in the Inbox.</span>
          <Link href="/app/inbox" className="font-medium hover:underline">Open the Inbox ›</Link>
        </div>
      ) : null}
      {staleSubmit && r.status === "draft" ? (
        <div data-testid="payroll-stale-submit" className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-amber-3 px-3 py-2 text-1 text-amber-11">
          <span className="min-w-0 flex-1">The submit card is out of date: this draft changed after it was filed, so it was withdrawn. Run review again for a current one.</span>
          <button type="button" className="font-medium hover:underline disabled:opacity-50" disabled={review.pending} onClick={() => void review.run()}>Run review again ›</button>
        </div>
      ) : null}
      {err ? <div role="alert" className="mb-4 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(err)}</div> : null}
      {outcome ? <div className="mb-4"><OutcomeLine o={outcome} /></div> : null}
      <TotalsStrip totals={r.totals} count={r.paycheckCount - r.excludedWorkerIds.length} />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-1 text-gray-11">
        <span>{data.length} paychecks</span><span>·</span><span>{nr} need review</span>{blocked ? <><span>·</span><span className="text-red-11">{blocked} blocked</span></> : null}
        {r.previousRunId ? <><span>·</span><span>compared with <Link className="text-blue-11 hover:underline" href={`/app/payroll/${r.previousRunId}`} title={r.previousRunId}>{humanLine(r.previousRunId)}</Link></span></> : null}
      </div>
      <PaycheckTable data={data} onOpen={setOpen} />
      <PaycheckDrawer paycheck={open} onClose={() => setOpen(null)} />
      <Drawer
        open={confirm}
        onOpenChange={setConfirm}
        title="Submit payroll"
        description={title}
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button data-testid="payroll-submit-confirm" size="sm" variant="primary" disabled={submit.pending} onClick={async () => { const o = await submit.run(excludeBlocked); setOutcome(o ?? null); setConfirm(false); }}>Submit {r.totals ? r.totals.cashRequirement.display : ""}</Button>
          </div>
        }
      >
        <p className="text-2">Submitting sends a bank batch to the simulated ACH bank, settling on payday at 06:00 PT. The action is recorded in the audit log.</p>
        {blocked ? (
          <label className="mt-4 flex items-start gap-2 rounded-lg bg-amber-3 px-3 py-2 text-[13px] text-amber-11">
            <input type="checkbox" className="mt-0.5" checked={excludeBlocked} onChange={(e) => setExcludeBlocked(e.target.checked)} />
            <span>Exclude {blocked} blocked paycheck{blocked > 1 ? "s" : ""} (for example, no bank account). Without this the submit is refused.</span>
          </label>
        ) : null}
      </Drawer>
    </div>
  );
}
