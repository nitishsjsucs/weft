"use client";
// Routine gallery (wave 3 rank 11, w3-parity-routines): a row of prebuilt favorites with "Try it", which fires an
// attended run now and opens it in the agent panel. Last run and next run come from GET /v1/routines.
import Link from "next/link";
import { Play } from "lucide-react";
import { Badge, Button, Card } from "@weft/ui/components";
import { W3_ROUTINES_TID, type RoutineDef, type RoutineRunDto } from "@weft/contracts";
import { client, errorText, useMutation } from "@/lib/api/hooks";
import { fmtDateTime, statusLabel } from "../format";
import { useAgent } from "../agent-context";

/** GET /v1/routines rows carry these two fields since wave 3 (apps/api/src/routes/routines.ts). */
export type RoutineRow = RoutineDef & { lastRun?: { id: string; status: RoutineRunDto["status"]; startedAt: string | null; summary: string | null } | null; nextRunAt?: string | null };

export const FAVORITES = ["rt_new_hire_ready", "rt_pre_payroll", "rt_monthly_exec_report", "rt_people_digest", "rt_milestones"] as const;
const LAST_TONE: Record<RoutineRunDto["status"], "gray" | "blue" | "amber" | "green" | "red"> = { queued: "gray", running: "blue", waiting_approval: "amber", waiting_event: "amber", done: "green", failed: "red", cancelled: "gray", skipped: "gray" };

export function RunTimes({ r }: { r: RoutineRow }) {
  return (
    <div className="flex flex-col gap-0.5 text-1 text-gray-11">
      <span className="inline-flex flex-wrap items-center gap-1">Last run: {r.lastRun ? <><Badge tone={LAST_TONE[r.lastRun.status]} size="xs">{r.lastRun.status === "waiting_approval" ? "Waiting for approval" : statusLabel(r.lastRun.status)}</Badge>{r.lastRun.startedAt ? ` ${fmtDateTime(r.lastRun.startedAt)}` : ""}</> : <span className="text-gray-10">none yet</span>}</span>
      <span>Next run: {r.nextRunAt ? fmtDateTime(r.nextRunAt) : <span className="text-gray-10">{r.enabled ? (r.trigger.type === "event" ? "on its event" : "when run by hand") : "off while disabled"}</span>}</span>
    </div>
  );
}

function TryIt({ r }: { r: RoutineRow }) {
  const agent = useAgent();
  const run = useMutation(async () => {
    const res = (await client.post("/v1/routines/:id/trigger", { params: { id: r.id } })) as { routineRunId: string };
    let agentRunId: string | null = null;
    for (let i = 0; !agentRunId && i < 10; i++) {
      await new Promise((ok) => setTimeout(ok, 500));
      try {
        const rr = (await client.get("/v1/routine-runs/:id", { params: { id: res.routineRunId } })) as RoutineRunDto;
        agentRunId = rr.agentRunId;
        if (!agentRunId && rr.status === "skipped") break;
      } catch { /* not yet */ }
    }
    if (agentRunId) agent.watch(agentRunId, r.name);
    return res;
  });
  return (
    <>
      <Button data-testid={W3_ROUTINES_TID.tryIt(r.id)} size="sm" disabled={run.pending} onClick={(e) => { e.preventDefault(); void run.run(); }}><Play /> Try it</Button>
      {run.error ? <p role="alert" className="text-1 text-red-11">{errorText(run.error)}</p> : null}
    </>
  );
}

export function RoutineGallery({ rows }: { rows: RoutineRow[] }) {
  const favs = FAVORITES.map((id) => rows.find((r) => r.id === id)).filter((r): r is RoutineRow => !!r);
  if (!favs.length) return null;
  return (
    <section data-testid={W3_ROUTINES_TID.gallery} data-tour="routine-gallery" data-count={favs.length} className="mb-8">
      <h2 className="mb-2 text-3 font-medium">Favorites</h2>
      <div className="grid gap-3 tablet:grid-cols-2 laptop:grid-cols-3">
        {favs.map((r) => (
          <Card key={r.id} className="flex flex-col gap-2 p-4">
            <div className="flex items-start gap-2">
              <Link href={`/app/routines/${r.id}`} className="min-w-0 flex-1 text-2 font-medium hover:underline">{r.name}</Link>
              <Badge tone={r.enabled ? "green" : "gray"}>{r.enabled ? "Enabled" : "Disabled"}</Badge>
            </div>
            <p className="line-clamp-3 text-[13px] text-gray-11">{r.description}</p>
            <div className="mt-auto flex items-end gap-2 pt-1">
              <div className="min-w-0 flex-1"><RunTimes r={r} /></div>
              <TryIt r={r} />
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
