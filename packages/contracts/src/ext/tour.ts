// Additive contract for the guided tour track (owner: tour). Nothing here changes a frozen contract; the integrator
// folds it in between rounds (.scratch/contract-requests/tour.md).
import { z } from "zod";

/** Seed profiles: the base world every test, e2e run and eval uses, and the rich layer on top for pnpm dev and the tour. */
export const SeedProfile = z.enum(["base", "rich"]);
export type SeedProfile = z.infer<typeof SeedProfile>;

/** POST /v1/sim/reset body. An omitted profile keeps the world's own profile (stored key, then WEFT_SEED_PROFILE, then base). */
export const SimResetBody = z.object({ profile: SeedProfile.optional() }).strict();
export type SimResetBody = z.infer<typeof SimResetBody>;

/** GET /v1/health gains this optional field (additive). */
export interface HealthSeedProfile { seedProfile?: SeedProfile }

/** The settings row a rich world carries (absent on base worlds, so base digests do not change). */
export const SEED_PROFILE_KEY = "seed.profile";
/** Environment variable scripts/dev.ts passes to the seed step and the API. */
export const SEED_PROFILE_ENV = "WEFT_SEED_PROFILE";
/** The rich layer's module and export, owned by the rich-seed track: packages/seed/src/rich.ts exporting seedRich. */
export const RICH_LAYER = { file: "packages/seed/src/rich.ts", exportName: "seedRich" } as const;
