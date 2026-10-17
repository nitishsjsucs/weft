"use client";
import Link from "next/link";
import { useState } from "react";
import { CalendarClock, Hand, Play, Radio, Sparkles } from "lucide-react";
import { Badge, Button, Card, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { TID, tid, type RoutineDef, type RoutineRunDto, type ToolOutcome } from "@weft/contracts";
import { client, errorText, useGet, useMutation } from "@/lib/api/hooks";
import { fmtDateTime, usd } from "../format";
import { PageHeader } from "../page";
import { principalName } from "../refs";
import { useAgent } from "../agent-context";
import { AUTONOMY_COPY, AutonomyControl } from "./autonomy-control";
import { RoutineGallery, RunTimes, type RoutineRow } from "./gallery";
import { RoutineDecisionCounts, RoutineGalleryW4 } from "./gallery/routine-gallery-w4";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Readable trigger: "Mondays 9:00 PT", "Weekdays 9:00 PT", "On notice.received". Falls back to the raw cron. */
export function triggerLabel(t: RoutineDef["trigger"]): string {
  if (t.type === "manual") return "Manual";
  if (t.type === "event") return `On ${t.event}`;
  const m = /^(\d+) (\d+) \* \* (\S+)$/.exec(t.cron);
  if (!m) return `${t.cron} (${t.tz})`;
  const time = `${m[2]}:${m[1]!.padStart(2, "0")}`;
  const tz = t.tz === "America/Los_Angeles" ? "PT" : t.tz;
  const dow = m[3]!;
  const days = dow === "*" ? "Every day" : dow === "1-5" ? "Weekdays" : /^\d$/.test(dow) ? `${DAYS[Number(dow)]}s` : `days ${dow}`;
  return `${days} ${time} ${tz}`;
}
function TriggerChip({ t }: { t: RoutineDef["trigger"] }) {
  const Icon = t.type === "cron" ? CalendarClock : t.type === "event" ? Radio : Hand;
  return <Badge tone="outline" size="md"><Icon />{triggerLabel(t)}</Badge>;
}
const RUN_TONE: Record<RoutineRunDto["status"], "gray" | "blue" | "amber" | "green" | "red"> = { queued: "gray", running: "blue", waiting_approval: "amber", waiting_event: "amber", done: "green", failed: "red", cancelled: "gray", skipped: "gray" };

function DraftBox() {
  const [prompt, setPrompt] = useState("");
  const [out, setOut] = useState<ToolOutcome | null>(null);
  const draft = useMutation((p: string) => client.post("/v1/routines/draft", { body: { prompt: p } }));
  return (
    <Card className="mb-8 p-4">
      <div className="mb-2 flex items-center gap-2 text-2 font-medium"><Sparkles className="size-4 text-accent-9" />Create your own</div>
      <p className="mb-3 text-[13px] text-gray-11">Describe when it runs and what it does. It is created disabled, and enabling it is a proposal in the Inbox.</p>
      <div className="flex flex-col gap-2 tablet:flex-row">
        <input
          data-testid={TID.routineDraftInput}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && prompt.trim()) void draft.run(prompt.trim()).then((o) => setOut(o ?? null)); }}
          placeholder="Every Friday, post open approvals to #payroll"
          aria-label="Describe a routine"
          className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--app-border)] bg-card px-3 text-2 outline-none focus:ring-2 focus:ring-[var(--blue-9)]"
        />
        <Button data-testid={TID.routineDraftSubmit} variant="primary" disabled={!prompt.trim() || draft.pending} onClick={async () => setOut((await draft.run(prompt.trim())) ?? null)}>Create routine</Button>
      </div>
      {draft.error ? <p role="alert" className="mt-2 text-1 text-red-11">{errorText(draft.error)}</p> : null}
      {out && !out.ok ? <p role="alert" className="mt-2 text-1 text-red-11">{out.refusal.code}: {out.refusal.message}</p> : null}
      {out && out.ok && out.status === "pending_approval" ? <p className="mt-2 text-1 text-amber-11">Created disabled. Enabling it waits in the <Link href="/app/inbox" className="underline">Inbox</Link>.</p> : null}
      {out && out.ok && out.status === "done" ? <p className="mt-2 text-1 text-green-11">{out.summary}</p> : null}
    </Card>
  );
}

export function RoutinesView() {
  const list = useGet("/v1/routines", { refreshMs: 5_000 }) as { data: RoutineRow[] | undefined; error: Error | null };
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title="Routines" subtitle="Standing jobs the agent runs on a schedule or an event. Deterministic prechecks decide whether a model is needed at all." />
      <RoutineGallery rows={list.data ?? []} />
      <DraftBox />
      <RoutineGalleryW4 />
      {list.error ? <div role="alert" className="mb-4 text-1 text-red-11">{errorText(list.error)}</div> : null}
      <div className="grid gap-4 tablet:grid-cols-2">
        {(list.data ?? []).map((r) => (
          <Link key={r.id} href={`/app/routines/${r.id}`} data-testid={tid.routineCard(r.id)} data-enabled={String(r.enabled)} className="group">
            <Card className="flex h-full flex-col gap-2 p-4 transition-shadow group-hover:shadow-[var(--shadow-medium)]">
              <div className="flex items-start gap-2">
                <h3 className="min-w-0 flex-1 text-3 font-medium">{r.name}</h3>
                <Badge tone={r.enabled ? "green" : "gray"}>{r.enabled ? "Enabled" : "Disabled"}</Badge>
              </div>
              <p className="text-[13px] text-gray-11">{r.description}</p>
              <RunTimes r={r} />
              <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
                <TriggerChip t={r.trigger} />
                {r.autonomy !== "approve" ? <Badge tone="outline">{AUTONOMY_COPY[r.autonomy].label}</Badge> : null}
                {r.source === "custom" ? <Badge tone="blue">Custom</Badge> : null}
                {r.taintedBy ? <Badge tone="amber">Tainted draft</Badge> : null}
                <span className="ml-auto font-mono text-0 text-gray-10">{r.id}</span>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

function duration(r: RoutineRunDto): string {
  if (!r.startedAt || !r.endedAt) return r.startedAt ? "running" : "-";
  const ms = new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime();
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`;
}

export function RoutineDetail({ id }: { id: string }) {
  const agent = useAgent();
  const r = useGet("/v1/routines/:id", { params: { id } });
  const runs = useGet("/v1/routines/:id/runs", { params: { id }, query: { limit: 50 }, refreshMs: 3_000 });
  const trigger = useMutation(async () => {
    const res = (await client.post("/v1/routines/:id/trigger", { params: { id } })) as { routineRunId: string; agentRunId?: string };
    let agentRunId = res.agentRunId ?? null;
    for (let i = 0; !agentRunId && i < 10; i++) {
      await new Promise((ok) => setTimeout(ok, 500));
      try { agentRunId = ((await client.get("/v1/routine-runs/:id", { params: { id: res.routineRunId } })) as RoutineRunDto).agentRunId; } catch { /* not yet */ }
    }
    if (agentRunId) agent.watch(agentRunId, r.data?.name ?? id);
    return res;
  });
  const d = r.data;
  if (r.error && !d) return <div role="alert" className="p-8 text-2 text-red-11">{errorText(r.error)}</div>;
  if (!d) return <div className="p-8 text-2 text-gray-10">Loading routine...</div>;
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader
        title={d.name}
        subtitle={d.description}
        meta={<><TriggerChip t={d.trigger} /><Badge tone={d.enabled ? "green" : "gray"} size="md">{d.enabled ? "Enabled" : "Disabled"}</Badge><span className="text-1 text-gray-11">Owner {principalName(d.ownerPrincipalId)} · budget {d.budget.steps} steps, ${d.budget.usd.toFixed(2)}</span></>}
        actions={<Button data-testid={TID.routineRunNow} variant="primary" size="sm" disabled={trigger.pending} onClick={() => void trigger.run()}><Play /> Run now</Button>}
      />
      {trigger.error ? <div role="alert" className="mb-4 text-1 text-red-11">{errorText(trigger.error)}</div> : null}
      <div className="mb-8 grid gap-4 laptop:grid-cols-3">
        <Card className="p-4 laptop:col-span-2">
          <h2 className="mb-1.5 text-1 font-medium text-gray-10 uppercase">Instructions</h2>
          <p className="text-[13px] leading-5 whitespace-pre-wrap">{d.instructions}</p>
          <h2 className="mt-4 mb-1.5 text-1 font-medium text-gray-10 uppercase">Tool allowlist</h2>
          <div className="flex flex-wrap gap-1.5">{d.tools.map((t) => <code key={t} className="rounded-md bg-gray-3 px-1.5 py-0.5 font-mono text-0">{t}</code>)}</div>
        </Card>
        <div className="flex flex-col gap-4">
          <AutonomyControl routine={d} />
          <RoutineDecisionCounts routineId={d.id} />
          <Card className="p-4">
            <h2 className="mb-1.5 text-1 font-medium text-gray-10 uppercase">Checklist (done when every item holds)</h2>
            <ul className="flex flex-col gap-1.5">{d.checklist.map((c) => <li key={c.id} className="text-[13px]">{c.label}<div className="font-mono text-0 break-all text-gray-10">{c.check}</div></li>)}</ul>
          </Card>
        </div>
      </div>
      <h2 className="mb-2 text-3 font-medium">Run log</h2>
      <Card className="overflow-hidden">
        <Table className="min-w-[860px] text-[13px]">
          <THead><TR><TH>Trigger</TH><TH>Status</TH><TH>Started</TH><TH numeric>Duration</TH><TH numeric>Cost</TH><TH>Left for a person</TH><TH>Run</TH></TR></THead>
          <TBody>
            {(runs.data?.data ?? []).map((x) => (
              <TR key={x.id} data-testid={TID.routineRunRow} data-status={x.status}>
                <TD className="h-11 max-w-[220px]"><code className="font-mono text-1 break-all">{x.triggerRef}</code>{x.attended ? <Badge tone="blue" size="xs" className="ml-1.5">attended</Badge> : null}{x.overdue ? <Badge tone="red" size="xs" className="ml-1.5">overdue</Badge> : null}</TD>
                <TD className="h-11"><Badge tone={RUN_TONE[x.status]}>{x.status.replace("_", " ")}</Badge></TD>
                <TD className="h-11 whitespace-nowrap">{x.startedAt ? fmtDateTime(x.startedAt) : "-"}</TD>
                <TD numeric className="h-11">{duration(x)}</TD>
                <TD numeric className="h-11">{usd(x.costUsdMicros)}</TD>
                <TD className="h-11 min-w-[280px] py-2">{x.leftForHuman.length ? x.leftForHuman.join("; ") : <span className="text-gray-10">Nothing</span>}{x.summary ? <div className="text-1 text-gray-10">{x.summary}</div> : null}</TD>
                <TD className="h-11">{x.agentRunId ? <Link href={`/app/runs/${x.agentRunId}`} className="font-mono text-0 text-blue-11 hover:underline">{x.agentRunId}</Link> : <span className="text-1 text-gray-10">precheck only</span>}</TD>
              </TR>
            ))}
            {runs.data && runs.data.data.length === 0 ? <TR><TD colSpan={7} className="text-gray-10">No runs yet.</TD></TR> : null}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}
