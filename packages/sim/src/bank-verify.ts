// The bank account verification simulator (wave 2, docs/wave2.md). Owner: w2-onboarding. Writes only sim_* tables;
// stores the last 4 digits of the routing and account numbers, never the full numbers or a credential.
// Deterministic: a routing number that fails the ABA checksum fails; an account ending 0000 is a closed account
// (the demo's way to see a failure); everything else verifies. Fault target bankVerify.verify.
import { abaChecksumOk, type BankVerifySim, type FaultInjector, type SimClock } from "@weft/contracts";
import { simBankVerifications, type DbTx } from "@weft/db";
import { firstFault, SimFaultError } from "./faults";
import { mintId } from "./ids";

export const CLOSED_ACCOUNT_LAST4 = "0000";

export function createBankVerifySim(db: DbTx, clock: SimClock, faults: FaultInjector): BankVerifySim {
  return {
    async verify(req) {
      const fault = await firstFault(faults, ["bankVerify.verify"]);
      if (fault) throw new SimFaultError("bankVerify.verify");
      if (!/^\d{4}$/.test(req.accountLast4)) throw new Error("bankVerify.verify: accountLast4 must be 4 digits");
      const status: "verified" | "failed" = !abaChecksumOk(req.routing) ? "failed" : req.accountLast4 === CLOSED_ACCOUNT_LAST4 ? "failed" : "verified";
      const reason = status === "verified" ? null : !abaChecksumOk(req.routing) ? "routing number not found" : "account closed";
      await db.insert(simBankVerifications).values({ id: await mintId(db, "simk_"), workerId: req.workerId, routingLast4: req.routing.slice(-4), accountLast4: req.accountLast4, status, reason, ts: clock.now() });
      return { status, reason };
    },
  };
}
