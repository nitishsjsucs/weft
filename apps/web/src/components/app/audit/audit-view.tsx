"use client";
import Link from "next/link";
import { Lock, ShieldCheck, ShieldX, Undo2 } from "lucide-react";
import { Badge, Button, Card, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { TID, tid, type Action, type ToolOutcome } from "@weft/contracts";
import { client, errorText, useGet, useMutation } from "@/lib/api/hooks";
import { AGENCY, fmtDateTime, humanTimes, notReversibleText } from "../format";
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

/**
 * A stored summary as a line a person reads. The few summaries whose ids, file names and agency codes humanLine does
 * not know read as words first (the stored text stays in the row's title).
 */
export function auditSummary(summary: string): string {
  const pre = summary
    .replace(/^Delivered ([A-Z]+)_([A-Z]+)_([A-Z]+)(\d+)_\d{4}\.txt from \w+ as the notice$/, "Delivered the $1 $2 $3 $4 notice")
    .replace(/^Delivered (\S+)\.txt from (\w+) as the notice$/, (_m, _f: string, ag: string) => `Delivered a notice from ${AGENCY[ag as keyof typeof AGENCY] ?? "the agency"}`)
    .replace(/\boffer offr?_\w*\d\w*\b/g, "an offer")
    .replace(/^Drafted response \d+ for/, "Drafted a response to")
    .replace(/\b(\d{4})-Q([1-4])\b/g, "Q$2 $1")
    .replace(/\bwith (irs|ca_edd|ny_dtf|ny_dol|tx_twc|co_dor|co_cdle) \(sim\)/g, (_m, ag: string) => `with ${AGENCY[ag as keyof typeof AGENCY]}`);
  return humanLine(pre);
}

/** The audit log reads as a table at a column of 640 px or more and as stacked rows below it (container queries). */
const STACK = "@max-[40rem]:block @max-[40rem]:w-full";

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
      {result && !result.ok ? <div role="alert" className="mb-4 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{result.refusal.code}: {humanTimes(result.refusal.message)}</div> : null}
      {result && result.ok && result.status === "done" ? <div className="mb-4 text-1 text-green-11">{humanTimes(result.summary)}</div> : null}
      <Card className="@container overflow-hidden">
        <Table className={cn("text-[13px]", STACK, "@max-[40rem]:[&_thead]:hidden")}>
          <THead><TR><TH className="w-[7.5rem]">When</TH><TH className="w-[11rem]">Actor</TH><TH>Summary</TH><TH className="w-[6.5rem]"><span className="sr-only">Run and undo</span></TH></TR></THead>
          <TBody className={STACK}>
            {(actions.data?.data ?? []).map((a) => {
              const who = actor(a, routineNames);
              const forWhom = a.onBehalfOf ? `for ${principalName(a.onBehalfOf)}` : null;
              return (
              <TR key={a.seq} id={`audit-${a.seq}`} data-testid={tid.auditRow(a.seq)} data-tour="audit-row" data-seq={a.seq} data-reverses={a.reversesSeq ?? ""} data-reversible={a.reversible} className={cn(a.reversedBySeq !== null && "bg-gray-2", "@max-[40rem]:grid @max-[40rem]:grid-cols-[1fr_auto] @max-[40rem]:gap-x-3 @max-[40rem]:px-3 @max-[40rem]:py-2.5")}>
                <TD className="h-auto py-2.5 align-top whitespace-nowrap @max-[40rem]:col-span-2 @max-[40rem]:flex @max-[40rem]:h-auto @max-[40rem]:gap-2 @max-[40rem]:p-0">
                  <div className="tabular text-gray-10">#{a.seq}</div>
                  <div className="tabular text-1 text-gray-11 @max-[40rem]:text-[13px]">{fmtDateTime(a.ts)}</div>
                </TD>
                <TD className="h-auto max-w-[11rem] py-2.5 align-top @max-[40rem]:col-span-2 @max-[40rem]:max-w-none @max-[40rem]:p-0">
                  <div className="truncate font-medium" title={[who, forWhom, a.routineRunId].filter(Boolean).join(", ")}>{who}</div>
                  {forWhom ? <div className="truncate text-1 text-gray-10" title={forWhom}>{forWhom}</div> : null}
                </TD>
                <TD className="h-auto min-w-0 py-2.5 align-top whitespace-normal break-words @max-[40rem]:p-0 @max-[40rem]:pt-1">
                  {/* The stored summary carries row ids and ISO dates; it reads as words here, the stored text in the title. */}
                  <div title={a.summary}>{auditSummary(a.summary)}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-1 text-gray-10">
                    {/* A command breaks only after its dot ("notices." / "draft_response"), never inside a word. */}
                    <code className="font-mono">{a.command.split(".").map((part, i, all) => <Fragment key={i}><span className="whitespace-nowrap">{part}{i < all.length - 1 ? "." : ""}</span>{i < all.length - 1 ? <wbr /> : null}</Fragment>)}</code>
                    {a.reversible === "no" ? <span className="inline-flex items-center" title={notReversible(a)}><Lock aria-hidden className="size-3" /><span className="sr-only">{notReversible(a)}</span></span> : null}
                    {a.reversesSeq !== null ? <span>· Reverses <a href={`#audit-${a.reversesSeq}`} className="text-blue-11 hover:underline">#{a.reversesSeq}</a></span> : null}
                    {a.reversedBySeq !== null ? <span>· Reversed by <a href={`#audit-${a.reversedBySeq}`} className="text-blue-11 hover:underline">#{a.reversedBySeq}</a></span> : null}
                    {a.proposalId ? <span title={a.proposalId}>· from an approved proposal</span> : null}
                  </div>
                </TD>
                <TD className="h-auto py-2.5 align-top text-right @max-[40rem]:col-start-2 @max-[40rem]:row-start-1 @max-[40rem]:p-0">
                  <div className="flex flex-col items-end gap-1">
                    {a.agentRunId ? <Link href={`/app/runs/${a.agentRunId}`} title={a.agentRunId} aria-label={`Agent run ${a.agentRunId}`} className="whitespace-nowrap text-1 text-blue-11 hover:underline">Agent run</Link> : null}
                    {a.reversible === "yes" && a.reversedBySeq === null ? (
                      <Button data-testid={tid.auditUndo(a.seq)} data-tour="audit-undo" data-seq={a.seq} size="xs" disabled={undo.pending} onClick={async () => setResult((await undo.run(a.seq)) ?? null)}><Undo2 /> Undo</Button>
                    ) : null}
                  </div>
                </TD>
              </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>
      {actions.data?.hasMore ? <p className="mt-2 text-1 text-gray-10">Showing the latest 100 of {actions.data.count}.</p> : null}
    </div>
  );
}
