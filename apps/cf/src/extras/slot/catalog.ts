// The run catalog row for a hosted run that reached a terminal status (design 5.2): outcome numbers only, read from
// the slot's own agent_runs and its terminal run step. CompanyDO sends it to HostedExtras.recordRun (or writes D1
// directly) after the run's last commit, outside any transaction. Track cf6-extras.
import { and, desc, eq } from "drizzle-orm";
import { agentRuns, runSteps, type Db } from "@weft/db";
import { WORKERS_AI_NEURONS_PER_M, WORKERS_AI_PROVIDER_ID, type HostedProviderId } from "../../../../../packages/contracts/src/ext/cf-agent";
import type { RunCatalogRow } from "@weft/cf-extras";

/** Statuses a run ends an agent turn in; a waiting run that resumes is recorded again (the row upserts). */
const TERMINAL = new Set(["done", "failed", "refused", "escalated", "expired", "cancelled", "waiting"]);

/** Neurons for a Workers AI run from its token totals (design 5.2 pricing); 0 for every other provider. */
export function runNeurons(provider: string, tokens: { input?: number; output?: number }): number {
  if (provider !== WORKERS_AI_PROVIDER_ID) return 0;
  return Math.ceil(((tokens.input ?? 0) * WORKERS_AI_NEURONS_PER_M.input + (tokens.output ?? 0) * WORKERS_AI_NEURONS_PER_M.output) / 1_000_000);
}

export async function catalogRowFor(db: Db, runId: string, world: { slot: string; gen: number }, endedAtWall: Date = new Date()): Promise<RunCatalogRow | null> {
  const [r] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  if (!r || !TERMINAL.has(r.status)) return null;
  const [t] = await db.select({ resultJson: runSteps.resultJson }).from(runSteps).where(and(eq(runSteps.runId, runId), eq(runSteps.stage, "terminal"))).orderBy(desc(runSteps.n)).limit(1);
  let result: { ms?: unknown; groundingFallback?: unknown } = {};
  try { result = t?.resultJson ? (JSON.parse(String(t.resultJson)) as typeof result) : {}; } catch { result = {}; }
  let tokens: { input?: number; output?: number } = {};
  try { tokens = JSON.parse(String(r.tokensJson)) as typeof tokens; } catch { tokens = {}; }
  // Grounding applies to chat answers: a done chat run without the grounded-receipt fallback was grounded.
  const grounded = r.kind === "chat" && r.status === "done" ? result.groundingFallback !== true : null;
  return {
    runId: r.id, slot: world.slot, gen: world.gen, provider: r.provider as HostedProviderId, model: r.model, trigger: r.trigger, steps: r.stepsUsed, grounded,
    costUsdMicros: r.costUsdMicros, neurons: runNeurons(r.provider, tokens), latencyMs: typeof result.ms === "number" ? Math.round(result.ms) : 0,
    status: r.status, terminalReason: r.terminalReason, endedAt: endedAtWall.toISOString(),
  };
}
