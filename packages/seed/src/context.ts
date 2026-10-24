import type { Faker } from "@faker-js/faker";
import type { ExecutorBundle, SimClock, Simulators } from "@weft/contracts";
import type { Db } from "@weft/db";

/** What every seed step receives. Steps write domain rows with `db`, use `executor` for governed writes
 * (vault, memory, the Vic raise through human.exec) and never read the wall clock. */
export interface SeedContext {
  db: Db;
  clock: SimClock;
  executor: ExecutorBundle;
  sims: Simulators;
  dataDir: string;
  companyId: "cmp_larkspur";
  faker: Faker;
}
export type SeedStep = (ctx: SeedContext) => Promise<void>;
