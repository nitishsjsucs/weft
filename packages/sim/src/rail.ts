// The payment rail simulator (wave 2, docs/wave2.md). Owner: w2-benefits-contractors. Writes only sim_* tables; stores vault names, never credentials.
import { NotImplemented, type PaymentRailSim, type FaultInjector, type SimClock } from "@weft/contracts";
import type { DbTx } from "@weft/db";


export function createRailSim(_db: DbTx, _clock: SimClock, _faults: FaultInjector): PaymentRailSim {
  return {
    send: async () => { throw new NotImplemented("payment rail simulator (w2-benefits-contractors)"); },
    tick: async () => [],
  };
}
