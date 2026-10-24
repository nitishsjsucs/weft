// Seed profiles. "base" is seedWorld() alone: tests, `pnpm e2e`, `pnpm demo` and the eval worlds use it, and its
// digest is pinned. "rich" layers deterministic history on top (packages/seed/src/rich) so every screen has data; it
// is the default for `pnpm dev`. Pick one with WEFT_SEED_PROFILE=base|rich (the seed CLI defaults to base).
import { eq } from "drizzle-orm";
import { SEED_TIME } from "@weft/core";
import { settings, type Db } from "@weft/db";
import { seedWorld, type SeedTarget } from "./index";
import { seedRichProfile, type RichSummary } from "./rich/index";

export const SEED_PROFILES = ["base", "rich"] as const;
export type SeedProfile = (typeof SEED_PROFILES)[number];

export function parseSeedProfile(v: string | undefined, fallback: SeedProfile = "base"): SeedProfile {
  if (v === undefined || v === "") return fallback;
  if ((SEED_PROFILES as readonly string[]).includes(v)) return v as SeedProfile;
  throw new Error(`WEFT_SEED_PROFILE must be one of ${SEED_PROFILES.join(", ")}, got ${JSON.stringify(v)}`);
}

/** The settings row a rich world carries, so POST /v1/sim/reset rebuilds the same profile. Base worlds have none. */
export const SEED_PROFILE_SETTING = "seed.profile";

/** The profile a seeded database was built with: "rich" when it carries the setting, else "base". */
export async function readSeedProfile(db: Db): Promise<SeedProfile> {
  try {
    const [row] = await db.select().from(settings).where(eq(settings.key, SEED_PROFILE_SETTING)).limit(1);
    return row ? parseSeedProfile(JSON.parse(row.valueJson) as string) : "base";
  } catch { return "base"; }
}

/** seedWorld(), then the profile's layer. Leaves the clock at the seed time, frozen, like seedWorld. `showcase: false`
 * builds the rich world without the recorded showcase runs (the world `pnpm seed:record-showcase` records them on). */
export async function seedWorldProfile(weft: SeedTarget, profile: SeedProfile, opts: { log?: (line: string) => void; showcase?: boolean; showcaseFixture?: string } = {}): Promise<RichSummary | null> {
  await seedWorld(weft, opts);
  if (profile === "base") return null;
  const faker = undefined as never;   // the rich layer draws from its own fixed generator, never faker
  try {
    const counts = await seedRichProfile({ db: weft.db, clock: weft.clock, executor: weft.executor, sims: weft.sims, dataDir: weft.dataDir, companyId: "cmp_larkspur", faker }, { showcase: opts.showcase, showcaseFixture: opts.showcaseFixture });
    await weft.db.insert(settings).values({ key: SEED_PROFILE_SETTING, valueJson: JSON.stringify(profile) });
    opts.log?.(`seeded rich profile: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")}`);
    return counts;
  } finally {
    await weft.clock.set(SEED_TIME, 0);
  }
}
