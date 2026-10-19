"use client";
import Link from "next/link";
import { ShieldCheck, ShieldX, Undo2 } from "lucide-react";
import { Badge, Button, Card, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { TID, tid, type Action, type ToolOutcome } from "@weft/contracts";
import { client, errorText, useGet, useMutation } from "@/lib/api/hooks";
import { fmtDateTime, humanTimes, notReversibleText } from "../format";
import { PageHeader } from "../page";
import { principalName } from "../refs";
import { humanLine } from "../copy";
import { Fragment, useEffect, useRef, useState } from "react";

/** Who wrote the row: a routine by its name (its run id is for whoever traces it, so it sits in the title). */
function actor(a: Action, routineNames: Record<string, string>): string {
  if (a.actorKind === "agent") return "Weft agent";
  if (a.actorKind === "routine") return a.routineRunId && routineNames[a.routineRunId] ? `Routine: ${routineNames[a.routineRunId]}` : "Routine";
  return principalName(a.actorId);
}

/** The routines' names for the routine runs on the page, read once per run id. */
function useRoutineNames(runIds: string[]): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());
  const routines = useGet("/v1/routines", { enabled: runIds.length > 0 });
  const key = runIds.join(",");
  useEffect(() => {
    const defs = (routines.data ?? []) as { id: string; name: string }[];
    if (!defs.length) return;
    for (const id of runIds) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      client.get("/v1/routine-runs/:id", { params: { id } }).then(
        (r) => { const name = defs.find((d) => d.id === (r as { routineId: string }).routineId)?.name; if (name) setNames((n) => ({ ...n, [id]: name })); },
        () => undefined,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, routines.data]);
  return names;
}

const notReversible = (a: Action) => humanTimes(notReversibleText(a.notReversibleReason));

export function AuditView() {
  const actions = useGet("/v1/actions", { query: { limit: 100 }, refreshMs: 5_000 });
  // A link to /app/audit#audit-<seq> (the offboarding case view) scrolls to and marks that row once it has loaded.
  const jumped = useRef(false);
  useEffect(() => {
    if (jumped.current || !actions.data) return;
    const m = /^#audit-(\d+)$/.exec(window.location.hash);
    if (!m) return;
    jumped.current = true;
    const el = document.getElementById(`audit-${m[1]}`);
    if (el) { el.scrollIntoView({ block: "center" }); el.classList.add("bg-blue-3"); }
  }, [actions.data]);
  const chain = useGet("/v1/actions/verify", { refreshMs: 10_000 });
  const routineNames = useRoutineNames([...new Set((actions.data?.data ?? []).map((a) => a.routineRunId).filter((x): x is string => !!x))]);
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
          <Badge data-testid={TID.auditChainStatus} data-tour="audit-chain" data-ok={c ? String(c.ok) : ""} tone={!c ? "gray" : c.ok ? "green" : "red"} size="md">
            {!c ? "Checking chain..." : c.ok ? <><ShieldCheck /> Chain valid{c.head ? ` through #${c.head.seq}` : ""}</> : <><ShieldX /> Chain broken{c.badSeq !== null ? ` at #${c.badSeq}` : ""}{c.gaps.length ? `, gaps ${c.gaps.join(", ")}` : ""}</>}
          </Badge>
        }
      />
      {err ? <div role="alert" className="mb-4 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(err)}</div> : null}
      {result && !result.ok ? <div role="alert" title={result.refusal.code} className="mb-4 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{humanTimes(result.refusal.message)}</div> : null}
      {result && result.ok && result.status === "done" ? <div className="mb-4 text-1 text-green-11">{humanTimes(result.summary)}</div> : null}
      <Card className="overflow-hidden">
        <Table className="text-[13px]">
          <THead><TR><TH>Seq</TH><TH>Time</TH><TH>Actor</TH><TH>Command</TH><TH className="w-full min-w-[200px]">Summary</TH><TH>Run</TH><TH /></TR></THead>
          <TBody>
            {(actions.data?.data ?? []).map((a) => (
              <TR key={a.seq} id={`audit-${a.seq}`} data-testid={tid.auditRow(a.seq)} data-tour="audit-row" data-seq={a.seq} data-reverses={a.reversesSeq ?? ""} data-reversible={a.reversible} className={cn(a.reversedBySeq !== null && "bg-gray-2")}>
                <TD className="h-11 tabular text-gray-10">#{a.seq}</TD>
                <TD className="h-11 whitespace-nowrap">{fmtDateTime(a.ts)}</TD>
                <TD className="h-11 max-w-[10rem]">
                  <div title={a.routineRunId ?? undefined}>{actor(a, routineNames)}</div>
                  {a.onBehalfOf ? <div className="text-1 text-gray-10">for {principalName(a.onBehalfOf)}</div> : null}
                </TD>
                {/* A command breaks only after its dot ("notices." / "draft_response"), never inside a word. */}
                <TD className="h-11 max-w-[11rem]"><code className="font-mono text-1">{a.command.split(".").map((part, i, all) => <Fragment key={i}><span className="whitespace-nowrap">{part}{i < all.length - 1 ? "." : ""}</span>{i < all.length - 1 ? <wbr /> : null}</Fragment>)}</code></TD>
                <TD className="h-11 min-w-[200px] whitespace-normal break-words">
                  {/* The stored summary carries row ids and ISO dates; it reads as words here, the stored text in the title. */}
                  <div title={a.summary}>{humanLine(a.summary)}</div>
                  <div className="text-1 text-gray-10">
                    {a.reversesSeq !== null ? <>Reverses <a href={`#audit-${a.reversesSeq}`} className="text-blue-11 hover:underline">#{a.reversesSeq}</a></> : null}
                    {a.reversedBySeq !== null ? <>Reversed by <a href={`#audit-${a.reversedBySeq}`} className="text-blue-11 hover:underline">#{a.reversedBySeq}</a></> : null}
                    {a.reversible === "no" ? <span className="text-amber-11">{notReversible(a)}</span> : null}
                    {a.proposalId ? <> · <span title={a.proposalId}>from an approved proposal</span></> : null}
                  </div>
                </TD>
                <TD className="h-11 max-w-[8rem]">{a.agentRunId ? <Link href={`/app/runs/${a.agentRunId}`} title={a.agentRunId} aria-label={`Agent run ${a.agentRunId}`} className="whitespace-nowrap text-1 text-blue-11 hover:underline">Agent run</Link> : "-"}</TD>
                <TD className="h-11 text-right">
                  {a.reversible === "yes" && a.reversedBySeq === null ? (
                    <Button data-testid={tid.auditUndo(a.seq)} data-tour="audit-undo" data-seq={a.seq} size="xs" disabled={undo.pending} onClick={async () => setResult((await undo.run(a.seq)) ?? null)}><Undo2 /> Undo</Button>
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
