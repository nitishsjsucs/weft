// Simulated HireRight (screening) for wave 3 (docs/wave3.md, research/wave3/integrations-screening-esign.md 3).
// Owner: w3-integrations-screening-esign. HireRight publishes no API reference, so this simulator cannot claim vendor
// shapes: it runs the shared screening engine with Weft's normalized model, labeled "Sandbox, API shape not published".
// Statuses follow the integrator-documented vocabulary mapped into Weft's ScreeningStatus. Writes only sim_vendor_records
// and sim_webhook_outbox, reads the sim clock and checks the fault injector.
import type { FaultInjector, ScreeningConnector, ScreeningPackage, SimClock } from "@weft/contracts";
import type { DbTx } from "@weft/db";
import { createScreeningSimEngine, type ScreeningSimFlavor } from "./checkr";

export const HIRERIGHT_SIM_LABEL = "Sandbox, API shape not published";
export const HIRERIGHT_SIM_WEBHOOK_KEY = "weft-sim-hireright-webhook-key-not-a-secret";
export const HIRERIGHT_SIM_PACKAGES: ScreeningPackage[] = [
  { slug: "hr_standard_sim", name: "Standard", priceCents: 3_900, screenings: ["ssn_trace", "national_criminal_search", "county_criminal_search"], phase: "full" },
];

const flavor: ScreeningSimFlavor = {
  vendor: "hireright", key: HIRERIGHT_SIM_WEBHOOK_KEY, header: "x-weft-sim-signature", packages: HIRERIGHT_SIM_PACKAGES, detail: HIRERIGHT_SIM_LABEL,
  // Weft's own normalized event shape: there is no published HireRight wire format to follow.
  eventBody: (e) => ({ event_id: e.id, event: e.type, occurred_at: e.createdAt, order_ref: (e.object.object === "adverse_action" ? e.object.report_id : e.object.id) ?? null, simulated: HIRERIGHT_SIM_LABEL }),
  parse: (b) => (typeof b.event_id === "string" && typeof b.event === "string" && typeof b.order_ref === "string" ? { dedupeKey: b.event_id, vendorOrderId: b.order_ref, kind: b.event } : null),
};

export function createHireRightSim(db: DbTx, clock: SimClock, faults: FaultInjector): ScreeningConnector {
  return createScreeningSimEngine(db, clock, faults, flavor);
}
