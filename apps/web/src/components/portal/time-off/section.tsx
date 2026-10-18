"use client";
// Portal section (wave 3, docs/wave3.md; filled in by the rich-seed track). Time off for a new hire before day one:
// the policies that will apply, how each accrues, the first date each can be used after its waiting period, and the
// company holidays from the start date. Read-only: requests open in the app after the start date. Calls go to
// /v1/portal/time-off as the portal principal (the new hire persona reaches only /v1/portal/*).
import { useEffect, useMemo, useState } from "react";
import { Badge, Card, CardHeading, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { CalendarDays } from "lucide-react";
import { fmtDate } from "../../app/format";

type Policy = { id: string; name: string; type: string; paid: boolean; jurisdiction: string; accrual: string; usableFrom: string; waitingDays: number; capHours: number | null; carryoverHours: number | null };
type View = { workerId: string; startDate: string; policies: Policy[]; holidays: { date: string; name: string }[] };

export function TimeOffPortalSection({ principal }: { workerId: string; principal: string }) {
  const [view, setView] = useState<View | null>(null);
  const headers = useMemo(() => ({ "x-weft-principal": principal, accept: "application/json" }), [principal]);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/v1/portal/time-off", { headers });
        if (res.ok && live) setView((await res.json()) as View);
      } catch { /* the section stays hidden */ }
    })();
    return () => { live = false; };
  }, [headers]);

  if (!view || view.policies.length === 0) return null;
  const upcoming = view.holidays.slice(0, 6);
  return (
    <section data-testid="portal-time-off" className="mt-6">
      <CardHeading icon={<CalendarDays />}>Time off</CardHeading>
      <Card className="overflow-hidden">
        <Table className="text-[13px]">
          <THead><TR><TH>Policy</TH><TH>How it accrues</TH><TH>Usable from</TH><TH numeric>Cap</TH></TR></THead>
          <TBody>
            {view.policies.map((p) => (
              <TR key={p.id} data-testid={`portal-time-off-${p.id}`}>
                <TD className="h-10 align-top">
                  <div className="flex flex-wrap items-center gap-2">{p.name}{p.paid ? null : <Badge tone="gray">Unpaid</Badge>}</div>
                </TD>
                <TD className="h-10 align-top text-gray-11">{p.accrual}</TD>
                <TD className="h-10 whitespace-nowrap align-top">{fmtDate(p.usableFrom)}{p.waitingDays > 0 ? <span className="text-1 text-gray-10"> ({p.waitingDays}-day wait)</span> : null}</TD>
                <TD numeric className="h-10 whitespace-nowrap align-top">{p.capHours === null ? "None" : `${p.capHours} h`}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      {upcoming.length ? (
        <p data-testid="portal-time-off-holidays" className="mt-2 text-1 text-gray-11">
          Company holidays after you start: {upcoming.map((h) => `${h.name} (${fmtDate(h.date)})`).join(", ")}.
        </p>
      ) : null}
      <p className="mt-1 text-1 text-gray-10">Balances start on {fmtDate(view.startDate)}. You can request time off in Weft from your first day.</p>
    </section>
  );
}
