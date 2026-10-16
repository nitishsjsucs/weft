// Scaffold (frozen): the SPEC 5 step order. faker.seed(20261015), ids from per-prefix counters, frozen clock while seeding.
import { Faker, en } from "@faker-js/faker";
import type { ExecutorBundle, SimClock, Simulators } from "@weft/contracts";
import type { Db } from "@weft/db";
import { SEED_TIME } from "@weft/core";
import type { SeedContext, SeedStep } from "./context";
import { seedCompany } from "./company";
import { seedPeople } from "./people";
import { seedBenefits } from "./benefits";
import { seedTax } from "./tax";
import { seedIt } from "./it";
import { seedGovernance } from "./governance";
import { seedActions } from "./actions";
import { seedPayroll } from "./payroll";
import { seedW2Onboarding } from "./w2-onboarding";
import { seedW2Offboarding } from "./w2-offboarding";
import { seedW2BenefitsContractors } from "./w2-benefits-contractors";
import { seedW3Expenses } from "./w3-expenses";
import { seedW3TimeOff } from "./w3-timeoff";
import { seedW3Parity } from "./w3-parity";
import { seedW3IntegrationsHr } from "./w3-integrations-hr";
import { seedW3ScreeningEsign } from "./w3-screening-esign";

export type { SeedContext, SeedStep } from "./context";
export { DIGEST_EXCLUDE, digestDb, dumpDb } from "./digest";
export const FAKER_SEED = 20261015;
export const SEED_CLOCK = SEED_TIME;   // Monday 2026-10-26 08:30 PT

/** The slice of createWeft()'s result the seed uses. */
export interface SeedTarget { db: Db; clock: SimClock; executor: ExecutorBundle; sims: Simulators; dataDir: string }

export const SEED_STEPS: readonly (readonly [string, SeedStep])[] = [
  ["company", seedCompany], ["people", seedPeople], ["benefits", seedBenefits], ["tax", seedTax], ["it", seedIt],
  ["governance", seedGovernance],
  ["actions", seedActions],
  ["payroll", seedPayroll],
  // wave 2 (docs/wave2.md)
  ["w2_onboarding", seedW2Onboarding], ["w2_offboarding", seedW2Offboarding], ["w2_benefits_contractors", seedW2BenefitsContractors],
  // wave 3 (docs/wave3.md)
  ["w3_expenses", seedW3Expenses], ["w3_timeoff", seedW3TimeOff], ["w3_parity", seedW3Parity], ["w3_integrations_hr", seedW3IntegrationsHr], ["w3_screening_esign", seedW3ScreeningEsign],
];

export async function seedWorld(weft: SeedTarget, opts: { log?: (line: string) => void } = {}): Promise<void> {
  const faker = new Faker({ locale: [en] });
  faker.seed(FAKER_SEED);
  await weft.clock.set(SEED_CLOCK, 0);   // frozen while seeding; steps may move it (the actions step backdates the raise)
  const ctx: SeedContext = { db: weft.db, clock: weft.clock, executor: weft.executor, sims: weft.sims, dataDir: weft.dataDir, companyId: "cmp_larkspur", faker };
  for (const [name, step] of SEED_STEPS) {
    await step(ctx);
    opts.log?.(`seeded ${name}`);
  }
  await weft.clock.set(SEED_CLOCK, 0);   // the seed time; createWeft callers set the live rate afterwards
}
