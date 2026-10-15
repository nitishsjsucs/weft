// Fault injector over sim_faults. Every outbound simulator call checks it first (SPEC 8).
import { eq } from "drizzle-orm";
import type { ArmedFault, FaultDecision, FaultInjector, FaultKind, FaultMode, FaultTarget } from "@weft/contracts";
import { simFaults, type DbTx } from "@weft/db";

/** Thrown by a simulator when an armed `error` fault fires. */
export class SimFaultError extends Error {
  override name = "SimFaultError";
  constructor(readonly target: string) { super(`Simulated failure at ${target}`); }
}

export function createFaults(db: DbTx): FaultInjector {
  return {
    async arm(f) {
      await db.insert(simFaults).values({ target: f.target, kind: f.kind, mode: f.mode, armed: true, firedCount: 0 })
        .onConflictDoUpdate({ target: simFaults.target, set: { kind: f.kind, mode: f.mode, armed: true } });
    },
    async disarm(target) {
      await db.update(simFaults).set({ armed: false }).where(eq(simFaults.target, target));
    },
    async check(target): Promise<FaultDecision> {
      const [row] = await db.select().from(simFaults).where(eq(simFaults.target, target)).limit(1);
      if (!row || !row.armed) return { fire: false };
      await db.update(simFaults).set({ firedCount: row.firedCount + 1, armed: row.mode === "always" }).where(eq(simFaults.target, target));
      return { fire: true, kind: row.kind as FaultKind };
    },
    async list(): Promise<ArmedFault[]> {
      const rows = await db.select().from(simFaults).orderBy(simFaults.target);
      return rows.map((r) => ({ target: r.target as FaultTarget, kind: r.kind as FaultKind, mode: r.mode as FaultMode, armed: r.armed, firedCount: r.firedCount }));
    },
  };
}

/** Checks targets in order and returns the first fault that fires. */
export async function firstFault(faults: FaultInjector, targets: FaultTarget[]): Promise<FaultKind | null> {
  for (const t of targets) {
    const d = await faults.check(t);
    if (d.fire) return d.kind;
  }
  return null;
}
