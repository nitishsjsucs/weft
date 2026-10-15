"use client";
import Link from "next/link";
import { ShieldCheck, ShieldX, Undo2 } from "lucide-react";
import { Badge, Button, Card, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { TID, tid, type Action, type ToolOutcome } from "@weft/contracts";
import { client, errorText, useGet, useMutation } from "@/lib/api/hooks";
import { fmtDateTime, notReversibleText } from "../format";
import { PageHeader } from "../page";
import { principalName } from "../refs";
import { useState } from "react";

function actor(a: Action): string {
  if (a.actorKind === "agent") return "Weft agent";
  if (a.actorKind === "routine") return `Routine ${a.routineRunId ?? ""}`.trim();
  return principalName(a.actorId);
}

const notReversible = (a: Action) => notReversibleText(a.notReversibleReason);

export function AuditView() {
  const actions = useGet("/v1/actions", { query: { limit: 100 }, refreshMs: 5_000 });
  const chain = useGet("/v1/actions/verify", { refreshMs: 10_000 });
  const [result, setResult] = useState<ToolOutcome | null>(null);
  const undo = useMutation((seq: number) => client.post("/v1/actions/:seq/rollback", { params: { seq }, body: { reason: "Undo from the audit log" } }));
  const c = chain.data;
  const err = actions.error ?? chain.error ?? undo.error;
  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader
        title="Audit log"
        subtitle="Every state change by a person, the agent, a routine or the system, hash-chained. Undo appends a reversing row; the original stays."
        meta={
          <Badge data-testid={TID.auditChainStatus} data-ok={c ? String(c.ok) : ""} tone={!c ? "gray" : c.ok ? "green" : "red"} size="md">
            {!c ? "Checking chain..." : c.ok ? <><ShieldCheck /> Chain valid{c.head ? ` through #${c.head.seq}` : ""}</> : <><ShieldX /> Chain broken{c.badSeq !== null ? ` at #${c.badSeq}` : ""}{c.gaps.length ? `, gaps ${c.gaps.join(", ")}` : ""}</>}
          </Badge>
        }
      />
      {err ? <div role="alert" className="mb-4 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(err)}</div> : null}
      {result && !result.ok ? <div role="alert" className="mb-4 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{result.refusal.code}: {result.refusal.message}</div> : null}
      {result && result.ok && result.status === "done" ? <div className="mb-4 text-1 text-green-11">{result.summary}</div> : null}
      <Card className="overflow-hidden">
        <Table className="min-w-[980px] text-[13px]">
          <THead><TR><TH>Seq</TH><TH>Time</TH><TH>Actor</TH><TH>On behalf of</TH><TH>Command</TH><TH>Summary</TH><TH>Run</TH><TH /></TR></THead>
          <TBody>
            {(actions.data?.data ?? []).map((a) => (
              <TR key={a.seq} id={`audit-${a.seq}`} data-testid={tid.auditRow(a.seq)} data-reversible={a.reversible} className={cn(a.reversedBySeq !== null && "bg-gray-2")}>
                <TD className="h-11 tabular text-gray-10">#{a.seq}</TD>
                <TD className="h-11 whitespace-nowrap">{fmtDateTime(a.ts)}</TD>
                <TD className="h-11 whitespace-nowrap">{actor(a)}</TD>
                <TD className="h-11 whitespace-nowrap">{a.onBehalfOf ? principalName(a.onBehalfOf) : "-"}</TD>
                <TD className="h-11"><code className="font-mono text-0">{a.command}</code></TD>
                <TD className="h-11">
                  <div className="min-w-[220px]">{a.summary}</div>
                  <div className="text-1 text-gray-10">
                    {a.reversesSeq !== null ? <>Reverses <a href={`#audit-${a.reversesSeq}`} className="text-blue-11 hover:underline">#{a.reversesSeq}</a></> : null}
                    {a.reversedBySeq !== null ? <>Reversed by <a href={`#audit-${a.reversedBySeq}`} className="text-blue-11 hover:underline">#{a.reversedBySeq}</a></> : null}
                    {a.reversible === "no" ? <span className="text-amber-11">{notReversible(a)}</span> : null}
                    {a.proposalId ? <> · approved proposal <code className="font-mono">{a.proposalId}</code></> : null}
                  </div>
                </TD>
                <TD className="h-11">{a.agentRunId ? <Link href={`/app/runs/${a.agentRunId}`} className="font-mono text-0 text-blue-11 hover:underline">{a.agentRunId}</Link> : "-"}</TD>
                <TD className="h-11 text-right">
                  {a.reversible === "yes" && a.reversedBySeq === null ? (
                    <Button data-testid={tid.auditUndo(a.seq)} size="xs" disabled={undo.pending} onClick={async () => setResult((await undo.run(a.seq)) ?? null)}><Undo2 /> Undo</Button>
                  ) : null}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      {actions.data?.hasMore ? <p className="mt-2 text-1 text-gray-10">Showing the latest 100 of {actions.data.count}.</p> : null}
    </div>
  );
}
