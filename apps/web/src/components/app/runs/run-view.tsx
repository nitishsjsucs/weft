"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CircleCheck, CircleDashed, ShieldAlert } from "lucide-react";
import { Badge, Card, ShimmerText, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { TID, type ProposalStatus, type RunStepRow } from "@weft/contracts";
import { watchRun, type RunWatch } from "@/lib/api/sse";
import { fmtDate, fmtDateTime, statusLabel, usd } from "../format";
import { useRoutineNames } from "../routine-names";
import { auditLabel, codeWords, humanLine, routineSummaryText, sentenceCase } from "../copy";
import { answerPlain } from "../agent/answer";
import { taintText } from "../agent/untrusted";
import { PageHeader } from "../page";
import { principalName } from "../refs";
import { stepState, stepSummary, toolLabel } from "../agent/run-steps";

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "-");
const int = (n: number) => n.toLocaleString("en-US");

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-4 py-3">
      <span className="truncate text-1 text-gray-10">{label}</span>
      <span className="truncate text-4 font-semibold tabular">{value}</span>
      {hint ? <span className="truncate text-0 text-gray-10">{hint}</span> : null}
    </div>
  );
}

/** A step's outcome in words; a step that filed a proposal shows the proposal's live status, not the call-time "pending:<id>". */
function OutcomeBadge({ o, statusOf }: { o: RunStepRow["outcome"]; statusOf: (id: string) => ProposalStatus | undefined }) {
  const { tone, note } = stepState(o, statusOf);
  if (tone === "none" || !note) return <span className="text-gray-9">-</span>;
  return <Badge tone={tone === "ok" ? "green" : tone === "pending" ? "amber" : tone === "declined" ? "gray" : "red"} title={o ?? undefined} className="max-w-[220px] truncate">{note}</Badge>;
}

/** Gate report item 6: only a run on a real model reads (live); scripted and template runs say so instead. */
export function isLiveRun(run: { provider: string; model: string }): boolean {
  return run.provider !== "scripted" && run.model !== "template" && run.model !== "none";
}

export function providerLabel(run: { provider: string; model: string }): string {
  if (run.model === "template") return "Template, no model";
  if (run.provider === "scripted") return "Scripted, no model";
  return `${run.provider} ${run.model} (live)`;
}

/**
 * Gate report item 4 and the GP1 run at 1440 px: the Steps card is about 790 px wide with the agent panel docked, so
 * step titles wrap instead of widening the table, and the columns the metrics above already total step aside as the
 * card narrows. Below a 900 px card Cache hit and Model time go; below 560 px (a phone) Stage moves under the title and
 * Tokens and USD go too, so #, Step and Outcome stay in view without scrolling.
 */
const STEP_OPTIONAL = "hidden @min-[900px]:table-cell";
const STEP_WIDE = "hidden @min-[560px]:table-cell";

const STEP_KIND: Partial<Record<RunStepRow["kind"], string>> = { context: "Context assembled", model_call: "Model call", verify: "Checks", recite: "Plan recited", notice: "Notice", error: "Error" };

/** The mono line under a step title: its stage on a narrow card (where the Stage column steps aside), then kind, tool and attempt. */
function StepDetail({ s }: { s: RunStepRow }) {
  const extra = [s.toolName || s.attempt > 1 ? statusLabel(s.kind) : null, s.toolName ? toolLabel(s.toolName) : null, s.attempt > 1 ? `attempt ${s.attempt}` : null].filter(Boolean).join(" · ");
  return (
    <div className="font-mono text-0 text-gray-10 [overflow-wrap:anywhere]">
      <span className="@min-[560px]:hidden">{s.stage}{extra ? " · " : ""}</span>{extra}
    </div>
  );
}

/** Run view (SPEC 11.3): stages, tool calls, outcomes, tokens, cache-hit ratio, USD and model time, checklist, proposals. */
export function RunView({ id }: { id: string }) {
  const [w, setW] = useState<RunWatch>({ run: null, steps: [], trace: null, mode: "idle" });
  useEffect(() => watchRun(id, setW), [id]);
  const run = w.run;
  const routineNames = useRoutineNames(run?.routineRunId ? [run.routineRunId] : []);
  if (!run && w.missing) {
    return (
      <div className="p-8 text-2 text-gray-10" data-testid="run-not-found">
        <p className="text-foreground">No run {id}.</p>
        <p className="mt-1">The link may be from before the workspace was reset. Recent runs are listed in the agent panel and linked from the audit log.</p>
        <Link href="/app/audit" className="mt-3 inline-block text-blue-11 hover:underline">Open the audit log</Link>
      </div>
    );
  }
  if (!run) return <div className="p-8 text-2 text-gray-10">{w.mode === "idle" ? "Loading run..." : "Waiting for the run..."}</div>;
  const modelMs = w.steps.reduce((a, s) => a + (s.timings?.modelMs ?? 0), 0);
  const working = run.status === "running" || run.status === "queued";
  const live = isLiveRun(run);
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader
        title={<span data-testid="run-title">{runTitle(run, run.routineRunId ? routineNames[run.routineRunId] : undefined)}</span>}
        subtitle={run.summary ? <span data-assist-untrusted={run.tainted ? "" : undefined}>{run.routineRunId ? routineSummaryText(run.summary) : answerPlain(run.summary)}</span> : undefined}
        meta={
          <>
            <Badge data-testid="run-status" data-status={run.status} tone={run.status === "done" ? "green" : run.status === "waiting" ? "amber" : working ? "blue" : "red"} size="md">{working ? <ShimmerText>{statusLabel(run.status)}</ShimmerText> : run.status === "waiting" ? "Waiting for approval" : statusLabel(run.status)}</Badge>
            {run.terminalReason && !/^(waiting_approval|done)$/i.test(run.terminalReason) && run.terminalReason.toLowerCase() !== run.status ? <span title={run.terminalReason} className="text-1 text-gray-10">{sentenceCase(codeWords(run.terminalReason))}</span> : null}
            <Badge data-testid="run-provider" data-live={live ? "true" : "false"} tone="outline" size="md">{providerLabel(run)}</Badge>
            <Badge tone={run.attended ? "blue" : "gray"} size="md">{run.attended ? "Attended" : "Unattended"}</Badge>
            <span className="text-1 text-gray-11">Trigger: {triggerWords(run.trigger)}</span>
            <span className="text-1 text-gray-11">Started {fmtDateTime(run.createdAt)}</span>
            {/* How the page follows the run matters only while it runs; a finished run is just loaded. */}
            {working || run.status === "waiting" ? <span data-testid="run-feed-mode" className="text-1 text-gray-10">({w.mode === "sse" ? "streaming" : w.mode === "polling" ? "polling every 1 s" : "loaded"})</span> : null}
            <span data-testid="run-id" className="font-mono text-0 text-gray-9 select-all">{run.id}</span>
          </>
        }
      />
      {run.tainted ? (
        <div data-testid="run-tainted-banner" role="alert" className="mb-4 flex items-start gap-2 rounded-xl bg-amber-3 px-4 py-2.5 text-[13px] text-amber-11">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" /><span title={run.taintedBy ?? undefined}>This run read untrusted content: {taintText(run.taintedBy)}. Every write it asked for became a proposal.</span>
        </div>
      ) : null}
      <Card className="@container mb-6">
        <div className="grid grid-cols-2 divide-[var(--app-border)] @min-[720px]:grid-cols-6 [&>*]:border-[var(--app-border)] [&>*:nth-child(n+3)]:border-t @min-[720px]:[&>*:nth-child(n+3)]:border-t-0 @min-[720px]:[&>*+*]:border-l">
          <Metric label="Model steps" value={`${run.stepsUsed} of ${run.budget.steps}`} />
          {/* A scripted run calls no model: its token counts are the scripted provider's estimates, and say so. */}
          <Metric label="Input tokens" value={int(run.tokens.input)} hint={run.provider === "scripted" ? "estimated, no model ran" : `${int(run.tokens.cached)} cached`} />
          <Metric label="Output tokens" value={int(run.tokens.output)} hint={run.tokens.reasoning ? `${int(run.tokens.reasoning)} reasoning` : undefined} />
          <Metric label="Cache-hit ratio" value={pct(run.tokens.cached, run.tokens.input)} />
          <Metric label="Cost" value={usd(run.costUsdMicros)} hint={`cap $${run.budget.usd.toFixed(2)}`} />
          <Metric label="Model time" value={`${(modelMs / 1000).toFixed(1)} s`} />
        </div>
      </Card>
      {run.checklist?.length ? (
        <section className="mb-6">
          <h2 className="mb-2 text-2 font-medium">Checklist</h2>
          <ul className="flex flex-col gap-1">
            {run.checklist.map((c) => (
              <li key={c.id} className="flex items-center gap-2 text-[13px]">
                {c.passed ? <CircleCheck className="size-4 text-green-11" /> : <CircleDashed className="size-4 text-gray-9" />}
                <span className={cn(!c.passed && "text-gray-11")}>{c.label}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="mb-6">
        <h2 className="mb-2 text-2 font-medium">Steps</h2>
        <div data-testid="run-steps-card" className="@container min-w-0 overflow-hidden rounded-xl border border-[var(--app-border)] bg-card shadow-xs">
          <Table className="text-[13px]">
            <THead><TR><TH>#</TH><TH className={STEP_WIDE}>Stage</TH><TH className="w-full">Step</TH><TH>Outcome</TH><TH numeric className={cn("whitespace-nowrap", STEP_WIDE)}>Tokens in / cached / out</TH><TH numeric className={STEP_OPTIONAL}>Cache hit</TH><TH numeric className={STEP_WIDE}>USD</TH><TH numeric className={STEP_OPTIONAL}>Model time</TH></TR></THead>
            <TBody>
              {w.steps.map((s) => (
                <TR key={s.n} id={resultIdOf(s) ?? undefined} data-testid={TID.runStep} data-stage={s.stage} data-kind={s.kind}>
                  <TD className="h-10 tabular text-gray-10">{s.n}</TD>
                  <TD className={cn("h-10", STEP_WIDE)}><code className="font-mono text-0">{s.stage}</code></TD>
                  <TD className="h-10 py-1.5">
                    <div className="min-w-0 break-words">{s.toolName ? stepSummary(s) : STEP_KIND[s.kind] ?? stepSummary(s)}</div>
                    <StepDetail s={s} />
                  </TD>
                  <TD className="h-10"><OutcomeBadge o={s.outcome} statusOf={(pid) => w.trace?.proposals.find((p) => p.id === pid)?.status} /></TD>
                  <TD numeric className={cn("h-10 whitespace-nowrap", STEP_WIDE)}>{s.usage ? `${int(s.usage.input)} / ${int(s.usage.cached)} / ${int(s.usage.output)}` : "-"}</TD>
                  <TD numeric className={cn("h-10", STEP_OPTIONAL)}>{s.usage ? pct(s.usage.cached, s.usage.input) : "-"}</TD>
                  <TD numeric className={cn("h-10", STEP_WIDE)}>{s.costUsdMicros ? usd(s.costUsdMicros) : "-"}</TD>
                  <TD numeric className={cn("h-10 whitespace-nowrap", STEP_OPTIONAL)}>{s.timings ? `${(s.timings.modelMs / 1000).toFixed(2)} s` : "-"}</TD>
                </TR>
              ))}
              {w.steps.length === 0 ? <TR><TD colSpan={8} className="text-gray-10">No steps yet.</TD></TR> : null}
            </TBody>
          </Table>
        </div>
      </section>
      {w.trace?.proposals.length ? (
        <section className="mb-6">
          <h2 className="mb-2 text-2 font-medium">Proposals and their fate</h2>
          <Card className="divide-y divide-[var(--app-border)]">
            {w.trace.proposals.map((p) => (
              <Link key={p.id} href={`/app/inbox?proposal=${encodeURIComponent(p.id)}`} data-entity={p.id} data-entity-kind="proposal" title={`${p.id}: ${p.headline}`} className="flex items-center gap-3 px-4 py-2.5 text-[13px] hover:bg-gray-2">
                <span className="min-w-0 flex-1 truncate">{humanLine(p.headline)}</span>
                <Badge tone={p.status === "executed" || p.status === "approved" ? "green" : p.status === "pending" ? "amber" : "red"}>{p.status === "pending" ? "Waiting for approval" : statusLabel(p.status)}</Badge>
                {p.decidedBy ? <span className="hidden text-1 text-gray-10 tablet:inline">Decided by {principalName(p.decidedBy)}</span> : null}
              </Link>
            ))}
          </Card>
        </section>
      ) : null}
      {w.trace?.actions.length ? (
        <section>
          <h2 className="mb-2 text-2 font-medium">Actions</h2>
          <Card className="divide-y divide-[var(--app-border)]">
            {w.trace.actions.map((a) => (
              <Link key={a.seq} href="/app/audit" className="flex items-center gap-3 px-4 py-2.5 text-[13px] hover:bg-gray-2">
                <span className="tabular text-gray-10">{auditLabel(a.seq)}</span><code className="font-mono text-0">{a.command}</code><span className="min-w-0 flex-1 truncate" title={humanLine(a.summary)}>{humanLine(a.summary)}</span>
              </Link>
            ))}
          </Card>
        </section>
      ) : null}
    </div>
  );
}

/** The page title: what the run was, by its routine or its trigger, and the day it ran (the id sits in the meta line). */
export function runTitle(run: { trigger: string; createdAt: string; routineRunId: string | null }, routineName?: string): string {
  const when = fmtDate(run.createdAt, { month: "short", day: "numeric", year: "numeric" });
  const what = routineName ?? (run.routineRunId ? "Routine run" : ({ chat: "Chat answer", mention: "Chat mention answer", portal: "Portal answer", mcp: "MCP client run", draft: "Routine draft", task: "Task run" } as Record<string, string>)[run.trigger.split(":")[0] ?? ""] ?? "Agent run");
  return `${what}, ${when}`;
}

/** A run's trigger key as words ("routine:rtr_x" is "Routine"); the key itself is the title. */
function triggerWords(t: string): string {
  const k = t.split(":")[0] ?? t;
  return ({ chat: "Chat", routine: "Routine", mention: "Chat mention", portal: "Portal question", mcp: "MCP client", draft: "Draft", task: "Task" } as Record<string, string>)[k] ?? sentenceCase(k.replace(/_/g, " "));
}
/** The result id a tool step returned, so a Sources chip can link to its row. */
function resultIdOf(s: RunStepRow): string | null {
  const o = (s.result as { outcome?: { resultId?: unknown } } | null)?.outcome;
  return typeof o?.resultId === "string" ? o.resultId : null;
}
