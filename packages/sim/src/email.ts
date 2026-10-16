// The email simulator (wave 2, docs/wave2.md). Owner: w2-onboarding. Writes only sim_* tables; stores vault names, never credentials.
import { NotImplemented, type EmailSim, type FaultInjector, type SimClock } from "@weft/contracts";
import type { DbTx } from "@weft/db";

export function createEmailSim(_db: DbTx, _clock: SimClock, _faults: FaultInjector): EmailSim {
  return {
    send: async () => { throw new NotImplemented("email simulator (w2-onboarding)"); },
    list: async () => [],
  };
}
