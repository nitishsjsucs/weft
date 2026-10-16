// Seed step w3_screening_esign (wave 3, docs/wave3.md). Owner: w3-integrations-screening-esign. Deterministic: the screening
// package catalog (cached from the simulated Checkr and HireRight catalogs, synthetic prices) and the agent.screening_cents
// ceilings. Never change wave 1 or wave 2 seed counts (SPEC 5.2 numbers are asserted by tests) and never touch processed runs.
import { formatId } from "@weft/contracts";
import { limits, screeningPackages } from "@weft/db";
import type { SeedContext } from "./context";

/** Per order and per day; the agent's proposal is still always a human approval. */
export const SCREENING_LIMITS = { "agent.screening_cents": 10_000, "agent.screening_day_cents": 30_000 } as const;

export async function seedW3ScreeningEsign(ctx: SeedContext): Promise<void> {
  let n = 0;
  for (const vendor of ["checkr", "hireright"] as const) {
    for (const p of await ctx.sims.vendors[vendor].listPackages()) {
      await ctx.db.insert(screeningPackages).values({ id: formatId("spk_", ++n), vendor, slug: p.slug, name: p.name, priceCents: p.priceCents, screeningsJson: JSON.stringify(p.screenings), phase: p.phase });
    }
  }
  for (const [key, cents] of Object.entries(SCREENING_LIMITS)) await ctx.db.insert(limits).values({ companyId: ctx.companyId, key, cents }).onConflictDoNothing();
}
