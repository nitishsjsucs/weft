// When the real-engine Miniflare cases run (engine-real.test.ts, engine-memory.test.ts). cf4's final acceptance runs
// once cf1-db, cf2-platform and cf3-agent are merged (docs/cloudflare/tracks.md), so the cases are skipped only in a
// checkout that has none of the three. Once all three are here they always run: a part a track has not exported,
// or a missing snapshot, fails them (and the gate case) instead of skipping them. A checkout with only some of the
// three fails the gate case, since the engine cannot be assembled there.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { missingDeps } from "../../src/core/company/deps";
import { mergedTracks } from "../../../../scripts/cf/lib/tracks";
import { CF_DIR } from "./config-files";

export const MANIFEST_FILE = join(CF_DIR, "generated/manifest.json");

const tracks = mergedTracks();
const missing = missingDeps();

export const realEngine = {
  /** The real-engine cases run (and must pass). */
  run: tracks.missing.length === 0 || missing.length === 0,
  merged: tracks.merged,
  unmerged: tracks.missing,
  missingDeps: missing,
};

/** What keeps the real engine from running in this checkout; empty when it can run, or when none of cf1, cf2 and cf3
 * is merged yet (then the cases are skipped and `skipReason` says why). */
export function realEngineProblems(): string[] {
  if (!realEngine.merged.length && realEngine.missingDeps.length) return [];
  const out: string[] = [];
  if (realEngine.unmerged.length && realEngine.missingDeps.length) out.push(`cf4's final acceptance needs cf1-db, cf2-platform and cf3-agent merged; not merged: ${realEngine.unmerged.join(", ")}`);
  for (const m of realEngine.missingDeps) out.push(`not exported: ${m}`);
  if (!existsSync(MANIFEST_FILE)) out.push("no snapshot in apps/cf/generated (run pnpm cf:snapshot)");
  return out;
}

export const skipReason = (): string | null =>
  realEngine.run || realEngine.merged.length ? null : `none of cf1-db, cf2-platform and cf3-agent is merged; ${realEngine.missingDeps.length} parts missing:\n  ${realEngine.missingDeps.join("\n  ")}`;
