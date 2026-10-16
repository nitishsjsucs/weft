// Wave 2 routines, prechecks and checklist predicates for the dossier refresh and timeline coarsening routines. Owner: w2-memory (docs/wave2.md).
// prebuilt.ts, prechecks.ts and checks.ts spread these maps in; add entries here only. Routine ids must be new (rt_ prefix).
//
// rt_memory_digest (harness 18 items 1 to 3) is a deterministic step: its precheck runs the digest in code (no
// model, zero tokens) and records the result as a skipped run whose summary names the periods. The run key is the
// routine id plus the trigger ref (one per period slot), so a repeat for the same period is a no-op; the digest
// itself is also a no-op when nothing changed. The digest needs the memory repo and the database, which live in
// apps/api, so apps/api binds it per ReadOnlyExecutor through the registry below (packages/routines never imports
// apps/api or the executor internals).
import type { Precheck, ReadOnlyExecutor, RoutineDef } from "@weft/contracts";
import type { Predicate } from "../checks";

export interface MemoryDigestSummary { commit: string | null; key: string; summary: string }
export type MemoryDigestHook = (ctx: { companyId: string; now: string; triggerRef: string }) => Promise<MemoryDigestSummary>;

export const RT_MEMORY_DIGEST: RoutineDef = {
  id: "rt_memory_digest", name: "Memory digest",
  description: "Every hour, roll the raw timeline into hourly, daily, weekly and monthly summaries, refresh dossiers and the company one-pager, and maintain backlinks. Deterministic; no model.",
  ownerPrincipalId: "usr_dana", enabled: false, autonomy: "approve", trigger: { type: "cron", cron: "5 * * * *", tz: "America/Los_Angeles" }, filter: null,
  instructions: "Deterministic step. The precheck runs the memory digest in code and records the result; no model call follows.",
  tools: [], precheck: "memory_digest", checklist: [], budget: { steps: 1, usd: 0, minutes: 2 },
  surface: { worthSurfacing: false, channel: null }, source: "prebuilt", taintedBy: null,
};

interface MemoryRegistry { hooks: WeakMap<object, MemoryDigestHook>; routine: RoutineDef }
const KEY = Symbol.for("weft.w2-memory.registry");

/** The process-wide registry apps/api binds into (keyed by the ReadOnlyExecutor the engine passes to prechecks). */
export function memoryRegistry(): MemoryRegistry {
  const g = globalThis as unknown as Record<symbol, MemoryRegistry | undefined>;
  return (g[KEY] ??= { hooks: new WeakMap(), routine: RT_MEMORY_DIGEST });
}
memoryRegistry();

const memoryDigest: Precheck = async (ctx, exec: ReadOnlyExecutor) => {
  const hook = memoryRegistry().hooks.get(exec);
  if (!hook) return { action: "skip", reason: "The memory digest is not bound in this process." };
  const out = await hook({ companyId: ctx.companyId, now: ctx.now, triggerRef: ctx.triggerRef });
  return { action: "skip", reason: out.summary };
};

// RT_MEMORY_DIGEST ships disabled and joins this array once the integrator updates the two wave 1 assertions that
// list the prebuilt routine ids (.scratch/contract-requests/w2-memory.md); until then apps/api fires it directly.
export const routines: RoutineDef[] = [];
export const prechecks: Record<string, Precheck> = { memory_digest: memoryDigest };
export const predicates: Record<string, Predicate> = {};
