// Finding the agent run behind something a person (or the clock) started, so the agent panel can follow it: a routine
// trigger answers with its routine run, whose agent run starts a moment later; an accepted offer or a delivered notice
// starts a routine through an event, so the run is the new one in the runs list.
import { client } from "@/lib/api/hooks";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FollowRow { id: string; routineRunId: string | null; trigger: string; cacheKey?: string; createdAt: string }

export async function recentAgentRuns(limit = 10): Promise<FollowRow[]> {
  const page = (await client.get("/v1/agent/runs", { query: { limit } })) as { data?: FollowRow[] };
  return page.data ?? [];
}

/** Ids of the newest agent runs, taken before a click so the run it starts is the one not in this set. */
export async function agentRunIdsNow(): Promise<Set<string>> {
  try { return new Set((await recentAgentRuns()).map((r) => r.id)); } catch { return new Set(); }
}

/** The agent run of a routine run (hinted when the API already returned it); polls for up to `tries` half seconds. */
export async function agentRunOf(routineRunId: string, hinted?: string | null, tries = 20): Promise<string | null> {
  if (hinted) return hinted;
  for (let i = 0; i < tries; i++) {
    try {
      const rr = (await client.get("/v1/routine-runs/:id", { params: { id: routineRunId } })) as { agentRunId?: string | null; status?: string };
      if (rr?.agentRunId) return rr.agentRunId;
      if (rr?.status && /^(skipped|done|failed|cancelled)$/.test(rr.status)) return null;   // finished without a model run
    } catch { /* not yet */ }
    await pause(500);
  }
  return null;
}

/** The first routine agent run that is not in `before`; polls for up to `tries` half seconds. */
export async function newRoutineAgentRun(before: Set<string>, tries = 20): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const fresh = (await recentAgentRuns()).filter((r) => !before.has(r.id) && r.routineRunId);
      if (fresh.length) return fresh.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!.id;
    } catch { /* keep trying */ }
    await pause(500);
  }
  return null;
}

/** The routine id a run's cache key names (`weft:main:<routine>:<company>`), or null for chat. */
export function routineIdOf(row: Pick<FollowRow, "cacheKey">): string | null {
  const id = row.cacheKey?.split(":")[2] ?? null;
  return id && id.startsWith("rt_") ? id : null;
}
