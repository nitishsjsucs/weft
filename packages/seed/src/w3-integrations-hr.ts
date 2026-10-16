// Seed step w3_integrations_hr (wave 3, docs/wave3.md). Owner: w3-integrations-hr. Deterministic: the Greenhouse
// connection row with the value maps for the fictional Larkspur account (Engineering, Hardware and Operations; the
// Oakland and Austin offices; the Boulder field office is left unmapped on purpose so a simulated hire shows an
// unmapped-value item), and the simulator's Larkspur jobs and in-process candidates. No hires are seeded, so the
// 15-minute poll stays idle until someone simulates one. The simulated Workday tenant mirrors the seeded employees
// (same work email, title, state and pay, so a first sync links everyone with no conflict) and the Workday connection
// row carries the absence type map read from the tenant (Vacation and Sick). Workday stays unsynced until someone
// presses Sync now, so time off keeps Weft as its system of record. When the Time Off seed (w3_timeoff, which runs
// first) has created no vacation type, a fallback adds the same tot_vacation and top_vac_us rows it seeds, so Workday
// vacation has a native policy to land on; with the Time Off seed present it adds nothing. Never changes wave 1 or
// wave 2 seed counts.
import type { W3GreenhouseSimControls, W3WorkdaySimControls } from "@weft/contracts";
import { eq } from "drizzle-orm";
import { integrationConnections, timeOffPolicies, timeOffTypes } from "@weft/db";
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
  const wd = ctx.sims.vendors.workday as unknown as Partial<W3WorkdaySimControls>;
  if (typeof wd.seedLarkspur === "function" && typeof wd.rest === "function") {
    await wd.seedLarkspur();
    const first = (await wd.rest("/common/v1/workers", { limit: "1" })).body as { data: { id: string }[] };
    const types = first.data[0] ? ((await wd.rest(`/absenceManagement/v5/workers/${first.data[0].id}/eligibleAbsenceTypes`, { limit: "100" })).body as { data: { id: string; descriptor: string }[] }).data : [];
    const KINDS: Record<string, string> = { vacation: "vacation", sick: "sick" };
    const map = Object.fromEntries(types.flatMap((t) => (KINDS[t.descriptor.toLowerCase()] ? [[t.id, KINDS[t.descriptor.toLowerCase()]!]] : [])));
    const [vac] = await ctx.db.select().from(timeOffTypes).where(eq(timeOffTypes.kind, "vacation")).limit(1);
    if (!vac) {
      await ctx.db.insert(timeOffTypes).values({ id: "tot_vacation", companyId: ctx.companyId, kind: "vacation", name: "Vacation", paid: true, countsAsVacation: true }).onConflictDoNothing();
      await ctx.db.insert(timeOffPolicies).values({ id: "top_vac_us", companyId: ctx.companyId, typeId: "tot_vacation", name: "Larkspur Vacation", jurisdiction: "US", schedule: "per_pay_period", minutesPerPeriod: 300, effectiveFrom: "2023-01-01" }).onConflictDoNothing();
    }
    await ctx.db.insert(integrationConnections).values({
      id: "intc_workday", companyId: ctx.companyId, vendor: "workday", mode: "simulated", lastSyncAt: null, cursor: null, health: "ok", detail: null,
      ownershipJson: null, settingsJson: JSON.stringify({ time_off_types: map }), updatedAt: now,
    }).onConflictDoNothing();
  }
}
