// Bank ACH simulator (SPEC 8): submitBatch stores the batch; the first tick at or after settleAt settles it.
// A `return` fault on bank.submitBatch returns the first entry (R03 style) instead.
import { and, asc, eq, lte } from "drizzle-orm";
import type { BankSim, FaultInjector, SimClock, SimEvent } from "@weft/contracts";
import { simBankBatches, type DbTx } from "@weft/db";
import { firstFault, SimFaultError } from "./faults";
import { mintId } from "./ids";

export const BANK_VAULT = "vault:sim-bank-operating" as const;
interface StoredEntry { workerId: string; amountCents: number; accountRef: string; returned?: true; returnCode?: "R03" }

export function createBankSim(db: DbTx, clock: SimClock, faults: FaultInjector): BankSim {
  return {
    async submitBatch(req) {
      const fault = await firstFault(faults, ["bank.submitBatch"]);
      if (fault === "error") throw new SimFaultError("bank.submitBatch");
      if (typeof req.credential !== "string" || req.credential.length < 8) throw new Error("SIM_AUTH: the sim bank rejected the credential");
      for (const e of req.entries) {
        if (!Number.isInteger(e.amountCents) || e.amountCents < 0) throw new Error(`bank.submitBatch: bad amount for ${e.workerId}`);
        if (!e.accountRef.startsWith("vault:")) throw new Error("bank.submitBatch: account refs must be vault names");
      }
      const entries: StoredEntry[] = req.entries.map((e, i) => (fault === "return" && i === 0 ? { ...e, returned: true, returnCode: "R03" } : { ...e }));
      const batchId = await mintId(db, "simb_");
      const total = entries.reduce((t, e) => t + e.amountCents, 0);
      await db.insert(simBankBatches).values({ id: batchId, payrollRunId: req.payrollRunId, totalCents: total, entriesJson: JSON.stringify(entries), status: "submitted", settleAt: req.settleAt });
      void clock;
      return { batchId, settleAt: req.settleAt };
    },
    async tick(now) {
      const out: SimEvent[] = [];
      const due = await db.select().from(simBankBatches).where(and(eq(simBankBatches.status, "submitted"), lte(simBankBatches.settleAt, now))).orderBy(asc(simBankBatches.id));
      for (const b of due) {
        const entries = JSON.parse(b.entriesJson) as StoredEntry[];
        const returned = entries.find((e) => e.returned);
        if (returned) {
          await db.update(simBankBatches).set({ status: "returned" }).where(eq(simBankBatches.id, b.id));
          out.push({ type: "sim.bank_batch_returned", subjectRef: b.id, payload: { batch_id: b.id, payroll_run_id: b.payrollRunId, worker_id: returned.workerId } });
        } else {
          await db.update(simBankBatches).set({ status: "settled" }).where(eq(simBankBatches.id, b.id));
          out.push({ type: "sim.bank_batch_settled", subjectRef: b.id, payload: { batch_id: b.id, payroll_run_id: b.payrollRunId } });
        }
      }
      return out;
    },
  };
}
