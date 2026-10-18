// Seed profiles for the guided tour (owner: tour). The base world is what every test, pnpm e2e, pnpm demo and the
// evals use, and it never changes here. A rich world is the base world plus the rich layer (owned by the rich-seed
// track, in packages/seed/src/rich.ts exporting seedRich), which pnpm dev and the tour use. Until that file exists a
// "rich" request seeds the base world and reports profile "base", so the tour degrades instead of failing.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import type { Db } from "@weft/db";
import type { SeedTarget } from "@weft/seed";
import { RICH_LAYER, SEED_PROFILE_ENV, SEED_PROFILE_KEY, SeedProfile } from "../../../packages/contracts/src/ext/tour";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** The profile named by WEFT_SEED_PROFILE; anything else is base. */
export function envProfile(env: NodeJS.ProcessEnv = process.env): SeedProfile {
  return SeedProfile.safeParse(env[SEED_PROFILE_ENV]).data ?? "base";
}

/** The profile key a rich world carries, or null (a base world, or no settings table yet). */
export async function storedProfile(db: Db): Promise<SeedProfile | null> {
  try {
    const rows = await db.all<{ v: string }>(sql`SELECT value_json AS v FROM settings WHERE key = ${SEED_PROFILE_KEY}`);
    const raw = rows[0]?.v;
    if (raw === undefined) return null;
    return SeedProfile.safeParse(typeof raw === "string" ? JSON.parse(raw) : raw).data ?? null;
  } catch { return null; }
}

type RichLayer = (target: SeedTarget) => Promise<void>;

/** The rich layer, when the rich-seed track's module is present. */
export async function loadRichLayer(root = repoRoot): Promise<RichLayer | null> {
  const file = join(root, RICH_LAYER.file);
  if (!existsSync(file)) return null;
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const fn = mod[RICH_LAYER.exportName];
  return typeof fn === "function" ? (fn as RichLayer) : null;
}

/**
 * Applies a profile on top of a freshly seeded base world and returns the profile the world now has. Base is a no-op;
 * rich runs the layer and records the key (an upsert, so a layer that writes it too is fine).
 */
export async function applyProfile(target: SeedTarget, profile: SeedProfile, layer?: RichLayer | null): Promise<SeedProfile> {
  if (profile !== "rich") return "base";
  const fn = layer === undefined ? await loadRichLayer() : layer;
  if (!fn) return "base";
  await fn(target);
  await target.db.run(sql`INSERT OR REPLACE INTO settings (key, value_json) VALUES (${SEED_PROFILE_KEY}, ${JSON.stringify("rich")})`);
  return "rich";
}
