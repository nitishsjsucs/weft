// Additive contract for the guided tour track (owner: tour). Nothing here changes a frozen contract; the integrator
// folds it in between rounds (.scratch/contract-requests/tour.md).
import { z } from "zod";

/** Seed profiles (mirrors packages/seed/src/profile.ts): the base world every test, e2e run and eval uses, and the rich
 * layer on top for pnpm dev and the tour. */
export const SeedProfile = z.enum(["base", "rich"]);
export type SeedProfile = z.infer<typeof SeedProfile>;

/** POST /v1/sim/reset body. An omitted profile keeps the world's own profile (the seed.profile settings row a rich world carries, else base). */
export const SimResetBody = z.object({ profile: SeedProfile.optional() }).strict();
export type SimResetBody = z.infer<typeof SimResetBody>;

/** GET /v1/health gains this optional field (additive). */
export interface HealthSeedProfile { seedProfile?: SeedProfile }
