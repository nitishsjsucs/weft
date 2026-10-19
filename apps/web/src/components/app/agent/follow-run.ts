// A person's click that starts a routine (Review with agent, Mark accepted) shows the routine's agent run in the
// panel, the way Run review now and Deliver do. The routine run gets its agent run a moment after it starts, so both
// helpers poll briefly and give up quietly (the run still shows on the routine's page).
import type { RoutineRunDto } from "@weft/contracts";
import { client } from "@/lib/api/hooks";

const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** The agent run of a routine run the click started, or null when none appears within about 5 s. */
export async function agentRunOf(routineRunId: string, tries = 10): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const rr = (await client.get("/v1/routine-runs/:id", { params: { id: routineRunId } })) as RoutineRunDto;
      if (rr.agentRunId) return rr.agentRunId;
      if (rr.status === "skipped" || rr.status === "failed" || rr.status === "cancelled") return null;
    } catch { /* not there yet */ }
    await wait(500);
  }
  return null;
}

/** The routine's run ids now, so a run an event starts after the click can be told apart from the history. */
export async function routineRunIds(routineId: string): Promise<Set<string>> {
  try {
    const page = (await client.get("/v1/routines/:id/runs", { params: { id: routineId }, query: { limit: 20 } })) as { data: RoutineRunDto[] };
    return new Set(page.data.map((r) => r.id));
  } catch { return new Set(); }
}

/** The agent run of the first run of the routine that is not in `before`, or null when none starts within about 6 s. */
export async function newAgentRunOf(routineId: string, before: Set<string>, tries = 12): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const page = (await client.get("/v1/routines/:id/runs", { params: { id: routineId }, query: { limit: 20 } })) as { data: RoutineRunDto[] };
      const fresh = page.data.find((r) => !before.has(r.id));
      if (fresh?.agentRunId) return fresh.agentRunId;
      if (fresh && (fresh.status === "skipped" || fresh.status === "failed")) return null;
    } catch { /* keep trying */ }
    await wait(500);
  }
  return null;
}
