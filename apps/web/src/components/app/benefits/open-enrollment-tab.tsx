"use client";
// Benefits > Open enrollment (wave 2, GP11). Owner: w2-benefits-contractors. 2027 plan year status per eligible
// employee; the reminder posts one message in #general (chat simulator) naming everyone who has not chosen.
import Link from "next/link";
import { useState } from "react";
import { CalendarCheck } from "lucide-react";
import { Badge, Button, Card, CardHeading, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { W2_BENEFITS_TID as TID, type ToolOutcome } from "@weft/contracts";
import { client, errorText, useGet, useMutation } from "@/lib/api/hooks";

interface Row { id: string; workerId: string; name: string; planYear: number; status: string; nudges: number; lastNudgedAt: string | null }
const TONE: Record<string, "green" | "gray" | "amber" | "blue"> = { elected: "green", waived: "gray", in_progress: "blue", not_started: "amber" };
const OE_LABEL: Record<string, string> = { elected: "Elected", waived: "Waived", in_progress: "In progress", not_started: "Not started" };

export function OpenEnrollmentTab() {
  const q = useGet("/v1/benefits/open-enrollment");
  const rows = (q.data ?? []) as Row[];
  const [notice, setNotice] = useState<string | null>(null);
  const nudge = useMutation(async () => (await client.post("/v1/tools/:name", { params: { name: "benefits.nudge_open_enrollment" }, body: {} })) as ToolOutcome);
  const left = rows.filter((r) => r.status === "not_started" || r.status === "in_progress");
  const onNudge = async () => { const o = await nudge.run(); if (o && o.ok) setNotice(o.status === "done" ? o.summary : `Proposal ${o.proposalId} is waiting in the Inbox`); q.reload(); };
  const counts = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-gray-11">Plan year 2027, closes 2026-11-13.</span>
        {(["elected", "waived", "in_progress", "not_started"] as const).map((s) => <Badge key={s} tone={TONE[s]}>{counts[s] ?? 0} {OE_LABEL[s]!.toLowerCase()}</Badge>)}
        <Button data-testid={TID.enrollmentNudge} size="sm" className="ml-auto" disabled={nudge.pending || left.length === 0} onClick={() => void onNudge()}>Remind {left.length} in #general</Button>
      </div>
      {q.error ?? nudge.error ? <div role="alert" className="mb-3 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText((q.error ?? nudge.error)!)}</div> : null}
      {notice ? <div role="status" className="mb-3 rounded-lg bg-gray-3 px-3 py-2 text-1 text-gray-12">{notice}</div> : null}
      <CardHeading icon={<CalendarCheck />}>Who has chosen</CardHeading>
      <Card className="overflow-hidden">
        {rows.length === 0 ? <p className="px-4 py-4 text-[13px] text-gray-10">{q.data ? "No open enrollment rows." : "Loading..."}</p> : (
          <div className="max-h-[480px] overflow-y-auto">
            <Table data-testid={TID.enrollmentTable} className="text-[13px]">
              <THead><TR><TH>Person</TH><TH>Status</TH><TH numeric>Reminders</TH><TH>Last reminder</TH></TR></THead>
              <TBody>
                {[...left, ...rows.filter((r) => !left.includes(r))].map((r) => (
                  <TR key={r.id} data-testid={TID.enrollmentRow(r.workerId)} data-status={r.status}>
                    <TD className="h-9 whitespace-nowrap"><Link href={`/app/people/${r.workerId}`} className="hover:underline">{r.name}</Link></TD>
                    <TD className="h-9"><Badge tone={TONE[r.status] ?? "gray"} data-status={r.status}>{OE_LABEL[r.status] ?? r.status.replace("_", " ")}</Badge></TD>
                    <TD numeric className="h-9">{r.nudges}</TD>
                    <TD className="h-9 text-gray-10">{r.lastNudgedAt ? r.lastNudgedAt.slice(0, 16).replace("T", " ") + " UTC" : "-"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
    </section>
  );
}
