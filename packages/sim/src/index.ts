// Simulators (SPEC 8). Owner: t2-world. Stateless objects over a db handle, so the executor binds one to its transaction.
import { NotImplemented, type SimClock, type Simulators } from "@weft/contracts";
import type { DbTx } from "@weft/db";

export interface CreateSimulatorsOptions { db: DbTx; clock: SimClock }
export type SimulatorsFactory = (opts: CreateSimulatorsOptions) => Simulators;

export const createSimulators: SimulatorsFactory = (_opts) => {
  throw new NotImplemented("createSimulators (t2-world)");
};
