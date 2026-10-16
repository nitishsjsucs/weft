// The bank account verification simulator (wave 2, docs/wave2.md). Owner: w2-onboarding. Writes only sim_* tables; stores vault names, never credentials.
import { NotImplemented, type BankVerifySim, type FaultInjector, type SimClock } from "@weft/contracts";
import type { DbTx } from "@weft/db";


export function createBankVerifySim(_db: DbTx, _clock: SimClock, _faults: FaultInjector): BankVerifySim {
  return {
    verify: async () => { throw new NotImplemented("bank verification simulator (w2-onboarding)"); },
  };
}
