// Build-time read of the hosted landing's stats (server only; docs/cloudflare/design.md 3.5). The snapshot builder
// writes stats.json (the GET /v1/stats shape) from the seeded world; when the export build finds it in public/, the
// landing's HTML carries those numbers, so an unleased visitor sees them with no request at all.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Stats } from "@weft/contracts";
import { FALLBACK_STATS, toLandingStats, type LandingStats } from "./live";

export function readSnapshotStats(file = join(/*turbopackIgnore: true*/ process.cwd(), "public", "stats.json")): LandingStats {
  try { return toLandingStats(JSON.parse(readFileSync(file, "utf8")) as Partial<Stats>, "snapshot"); }
  catch { return FALLBACK_STATS; }
}
