// Seed step w3_integrations_hr (wave 3, docs/wave3.md). Owner: w3-integrations-hr. Deterministic: the Greenhouse
// connection row with the value maps for the fictional Larkspur account (Engineering, Hardware and Operations; the
// Oakland and Austin offices; the Boulder field office is left unmapped on purpose so a simulated hire shows an
// unmapped-value item), and the simulator's Larkspur jobs and in-process candidates. No hires are seeded, so the
// 15-minute poll stays idle until someone simulates one. Never changes wave 1 or wave 2 seed counts.
import type { W3GreenhouseSimControls } from "@weft/contracts";
import { integrationConnections } from "@weft/db";
import type { SeedContext } from "./context";

export const GREENHOUSE_VALUE_MAPS = {
  departments: { "3300101": "dpt_engineering", "3300102": "dpt_hardware", "3300103": "dpt_operations" },
  offices: { "2200101": "wkp_oakland", "2200102": "wkp_austin" },
} as const;

export async function seedW3IntegrationsHr(ctx: SeedContext): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db.insert(integrationConnections).values({
    id: "intc_greenhouse", companyId: ctx.companyId, vendor: "greenhouse", mode: "simulated", lastSyncAt: null, cursor: null, health: "ok", detail: null,
    ownershipJson: null, settingsJson: JSON.stringify(GREENHOUSE_VALUE_MAPS), updatedAt: now,
  }).onConflictDoNothing();
  const gh = ctx.sims.vendors.greenhouse as unknown as Partial<W3GreenhouseSimControls>;
  if (typeof gh.seedLarkspur === "function") await gh.seedLarkspur();   // a real adapter (connected) has no simulator to seed
}
