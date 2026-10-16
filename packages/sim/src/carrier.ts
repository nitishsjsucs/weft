// The carrier invoice simulator. Owner: w2-benefits-contractors (docs/wave2.md). Writes only sim_carrier_invoices.
import { NotImplemented, type CarrierSim, type FaultInjector, type SimClock } from "@weft/contracts";
import type { DbTx } from "@weft/db";

export function createCarrierSim(_db: DbTx, _clock: SimClock, _faults: FaultInjector): CarrierSim {
  return { invoice: async () => { throw new NotImplemented("carrier invoice simulator (w2-benefits-contractors)"); } };
}
