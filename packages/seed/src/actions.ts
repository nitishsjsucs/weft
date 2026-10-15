// Seed step "actions" (SPEC 5). Owner: t2-world. The NY raise (18% effective 2026-10-16) as a governed action:
// people.set_pay_rate through executor.human.exec as Dana with the clock at 2026-10-09 10:00 PT, so the payroll
// anomaly evidence can point at a real action row. Until the executor lands (scaffold stub), the command runs
// directly in one transaction and the pay rate carries no action seq.
import { eq } from "drizzle-orm";
import { isWeftError, type HumanSession } from "@weft/contracts";
import { payRates, withWriteLock } from "@weft/db";
import { directCtx, directDeps, runDirect, SEED_TIME } from "@weft/core";
import type { SeedContext } from "./context";
import { ROSTER, seedWorkerId } from "./people";

export const RAISE_AT = "2026-10-09T17:00:00.000Z";   // Fri 2026-10-09 10:00 PT
export const RAISE_KEY = "lena";
export const RAISE_BPS = 1_800;
export const RAISE_EFFECTIVE = "2026-10-16";

export function raiseArgs() {
  const r = ROSTER.find((x) => x.key === RAISE_KEY)!;
  return { worker_id: seedWorkerId(RAISE_KEY), amount_cents: Math.round((r.pay.cents * (10_000 + RAISE_BPS)) / 10_000), effective_from: RAISE_EFFECTIVE };
}

const DANA: HumanSession = { principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui", keyScope: null };
const isStub = (e: unknown) => (isWeftError(e) && e._tag === "NotImplemented") || e instanceof TypeError;

export async function seedActions(ctx: SeedContext): Promise<void> {
  const args = raiseArgs();
  await ctx.clock.set(RAISE_AT, 0);
  try {
    let viaExecutor = true;
    try {
      const out = await ctx.executor.human.exec(DANA, "people.set_pay_rate", args);
      if (!out.ok || out.status !== "done") throw new Error(`seed actions: the NY raise did not execute: ${JSON.stringify(out)}`);
    } catch (e) {
      if (!isStub(e)) throw e;
      viaExecutor = false;
    }
    if (!viaExecutor) {
      await withWriteLock(() => ctx.db.transaction(async (tx) => {
        const sims = ctx.sims && typeof (ctx.sims as { tick?: unknown }).tick === "function" ? ctx.sims : ({} as never);
        const out = await runDirect("people.set_pay_rate", args, directCtx(ctx.clock, { principal: { id: "usr_dana", kind: "human", role: "admin" }, onBehalfOf: null, surface: "human_ui", agentKind: null }), directDeps(tx, ctx.clock, sims));
        const id = (out.data as { pay_rate_id: string }).pay_rate_id;
        await tx.update(payRates).set({ createdActionSeq: null }).where(eq(payRates.id, id));
      }));
    }
  } finally {
    await ctx.clock.set(SEED_TIME, 0);
  }
}
