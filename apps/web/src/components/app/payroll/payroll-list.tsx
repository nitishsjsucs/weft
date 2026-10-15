"use client";
import Link from "next/link";
import { Badge, Card } from "@weft/ui/components";
import { useGet, errorText } from "@/lib/api/hooks";
import { fmtDate, period } from "../format";
import { PageHeader } from "../page";

export function PayrollList() {
  const runs = useGet("/v1/payrolls", { query: { limit: 25 } });
  return (
    <div className="mx-auto w-full max-w-[880px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title="Payroll" subtitle="Semi-monthly US payroll for Larkspur Robotics (demo). Every bank batch goes to the simulated ACH bank." />
      {runs.error ? <div role="alert" className="mb-4 text-1 text-red-11">{errorText(runs.error)}</div> : null}
      <Card className="divide-y divide-[var(--app-border)]">
        {(runs.data?.data ?? []).map((r) => (
          <Link key={r.id} href={`/app/payroll/${r.id}`} data-testid={`payroll-run-${r.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-2">
            <div className="min-w-0 flex-1">
              <div className="text-2 font-medium">{period(r.periodStart, r.periodEnd)}</div>
              <div className="text-1 text-gray-10">US · Semi-monthly · payday {fmtDate(r.payday)} · {r.paycheckCount} paychecks</div>
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
