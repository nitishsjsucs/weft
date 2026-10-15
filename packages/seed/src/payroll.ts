// Seed step "payroll" (SPEC 5.5). Owner: t1-payroll. Runs after people, benefits, tax, governance and actions:
// opening YTD (Jan 1 to Aug 31, "imported from previous provider", from each start date only), the processed runs
// pay_2026_09_15, pay_2026_09_30 and pay_2026_10_15 through the lifecycle functions (not the executor) with settled
// bank batches, and the open draft pay_2026_10_30. Deterministic: ids from counters, fixed timestamps.
import { isWeftError, type BankSim } from "@weft/contracts";
import { idMinter, payroll } from "@weft/core";
import { and, eq } from "drizzle-orm";
import { paySchedules, workers } from "@weft/db";
import type { SeedContext } from "./context";

export const SEED_PAY_SCHEDULE = "ps_us_semimonthly";
/** Theo Marsh (demo), Payroll Lead, approved the historic runs. */
export const SEED_HISTORY_APPROVER = "usr_theo";
/**
 * The seed has no vault resolver (only the executor resolves credentials), so the historic batches carry the vault
 * name of the operating account. Simulators store only vault names (SPEC 8).
 */
export const SEED_BANK_CREDENTIAL = "vault:sim-bank-operating";

const isStub = (e: unknown) => isWeftError(e) && e._tag === "NotImplemented";

/** The bank simulator, or a deterministic stand-in while the simulator is still a scaffold stub. */
function seedBank(bank: BankSim): Pick<BankSim, "submitBatch" | "tick"> {
  return {
    async submitBatch(req) {
      try { return await bank.submitBatch(req); } catch (e) {
        if (!isStub(e)) throw e;
        return { batchId: `simb_seed_${req.payrollRunId.slice(4)}`, settleAt: req.settleAt };
      }
    },
    async tick(now) {
      try { return await bank.tick(now); } catch (e) { if (!isStub(e)) throw e; return []; }
    },
  };
}

export async function seedPayroll(ctx: SeedContext): Promise<void> {
  // Until the people seed lands (merge 1) the world has no schedule or employees; there is no pay history to build.
  const schedule = await ctx.db.select().from(paySchedules).where(eq(paySchedules.id, SEED_PAY_SCHEDULE));
  const employees = await ctx.db.select({ id: workers.id }).from(workers).where(and(eq(workers.payScheduleId, SEED_PAY_SCHEDULE), eq(workers.type, "employee")));
  if (!schedule.length || !employees.length) return;
  await payroll.seedPayHistory(ctx.db, {
    newId: idMinter(ctx.db), bank: seedBank(ctx.sims.bank), credential: SEED_BANK_CREDENTIAL, approvedBy: SEED_HISTORY_APPROVER,
    draftCreatedAt: payroll.ptToUtc("2026-10-16", 9),
  }, { companyId: ctx.companyId, payScheduleId: SEED_PAY_SCHEDULE });
}
