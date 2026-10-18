// Applies a seed profile on top of the freshly seeded base world in $WEFT_DATA_DIR (owner: tour). scripts/dev.ts runs
// it after `cli.ts seed` (frozen, base only) when the profile is rich. Base is a no-op. Never calls a model.
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SeedTarget } from "@weft/seed";
import { applyProfile, envProfile, loadRichLayer } from "../apps/api/src/seed-profile";

type CreateWeft = (opts: { dataDir: string; testMode?: boolean; seeding?: boolean }) => Promise<SeedTarget & { close(): Promise<void> }>;
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const dataDir = resolve(process.env.WEFT_DATA_DIR ?? join(repoRoot, ".data"));
const profile = envProfile();

if (profile === "base") {
  console.log("seed profile base: nothing to add");
} else if (!(await loadRichLayer())) {
  console.log("seed profile rich requested, but packages/seed/src/rich.ts is not there yet: the world stays base");
} else {
  const { createWeft } = (await import(pathToFileURL(join(repoRoot, "apps/api/src/compose.ts")).href)) as { createWeft: CreateWeft };
  const weft = await createWeft({ dataDir, seeding: true });
  try {
    const t0 = Date.now();
    const got = await applyProfile(weft, profile);
    console.log(`seed profile ${got} in ${Date.now() - t0} ms`);
  } finally { await weft.close(); }
}
