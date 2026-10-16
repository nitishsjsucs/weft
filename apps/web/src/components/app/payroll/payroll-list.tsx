"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FilePlus2 } from "lucide-react";
import { Badge, Button, Card } from "@weft/ui/components";
import { TID } from "@weft/contracts";
import { client, errorText, useGet, useMutation } from "@/lib/api/hooks";
import { fmtDate, nextPeriodEnd, period, plural, runKind } from "../format";
import { PageHeader } from "../page";

export function PayrollList() {
  const router = useRouter();
  const runs = useGet("/v1/payrolls", { query: { limit: 25 } });
  const latest = [...(runs.data?.data ?? [])].filter((r) => r.payScheduleId === "ps_us_semimonthly").sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  const draft = useMutation((periodEnd: string) => client.post("/v1/payrolls/drafts", { body: { payScheduleId: "ps_us_semimonthly", periodEnd } }));
  async function newDraft() {
    if (!latest) return;
    const o = await draft.run(nextPeriodEnd(latest.periodEnd));
    const id = o && o.ok && o.status === "done" ? ((o.data as { runId?: string } | null)?.runId ?? (o.resultId.startsWith("pay_") ? o.resultId : null)) : null;
    if (id) router.push(`/app/payroll/${id}`);
  }
  return (
    <div className="mx-auto w-full max-w-[880px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader
        title="Payroll"
        subtitle="Semi-monthly US payroll for Larkspur Robotics (demo). Every bank batch goes to the simulated ACH bank."
        actions={<Button data-testid={TID.payrollNewDraft} size="sm" disabled={!latest || draft.pending} onClick={() => void newDraft()}><FilePlus2 /> New draft{latest ? ` (${period(fmtNext(latest.periodEnd), nextPeriodEnd(latest.periodEnd))})` : ""}</Button>}
      />
      {runs.error || draft.error ? <div role="alert" className="mb-4 text-1 text-red-11">{errorText(runs.error ?? draft.error)}</div> : null}
      <Card className="divide-y divide-[var(--app-border)]">
        {(runs.data?.data ?? []).map((r) => (
          <Link key={r.id} href={`/app/payroll/${r.id}`} data-testid={`payroll-run-${r.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-2 font-medium">{period(r.periodStart, r.periodEnd)}{runKind(r.subtype).badge ? <Badge tone="outline" data-testid={`payroll-run-kind-${r.id}`}>{runKind(r.subtype).badge}</Badge> : null}</div>
              <div className="text-1 text-gray-10">US · {runKind(r.subtype).label} · payday {fmtDate(r.payday)} · {plural(r.paycheckCount, "paycheck")}</div>
            </div>
            {r.anomalySummary && r.status === "draft" ? <span className="hidden text-1 text-amber-11 tablet:inline">{r.anomalySummary.needsReview} need review</span> : null}
            <span className="hidden text-2 tabular tablet:inline">{r.totals?.cashRequirement.display ?? ""}</span>
            <Badge tone={r.status === "processed" ? "green" : r.status === "processing" ? "blue" : "gray"}>{r.status}</Badge>
          </Link>
        ))}
        {runs.data && runs.data.data.length === 0 ? <div className="px-4 py-6 text-2 text-gray-10">No payroll runs yet.</div> : null}
      </Card>
    </div>
  );
}

/** First day of the period after `periodEnd`. */
function fmtNext(periodEnd: string): string {
  const d = new Date(`${periodEnd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
