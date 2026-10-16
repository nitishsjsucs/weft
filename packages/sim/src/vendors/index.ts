// Wave 3 vendor simulators, bundled as Simulators.vendors (docs/wave3.md). Scaffold (frozen): each track fills its own vendor files.
import type { FaultInjector, SimClock, VendorConnectors } from "@weft/contracts";
import type { DbTx } from "@weft/db";
import { createGreenhouseSim } from "./greenhouse";
import { createWorkdaySim } from "./workday";
import { createCheckrSim } from "./checkr";
import { createHireRightSim } from "./hireright";
import { createDocuSignSim } from "./docusign";

export function createVendorSims(db: DbTx, clock: SimClock, faults: FaultInjector): VendorConnectors {
  return { greenhouse: createGreenhouseSim(db, clock, faults), workday: createWorkdaySim(db, clock, faults), checkr: createCheckrSim(db, clock, faults), hireright: createHireRightSim(db, clock, faults), docusign: createDocuSignSim(db, clock, faults) };
}
