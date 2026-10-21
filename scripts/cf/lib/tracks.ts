// The tracks cf4's real engine builds on (docs/cloudflare/tracks.md: cf4's final acceptance runs once cf1-db,
// cf2-platform and cf3-agent are merged). A track counts as merged when a file only it adds is in the checkout. Once
// all three are, the real-engine Miniflare cases run and must pass: a missing export or a missing snapshot fails
// them instead of skipping them (apps/cf/test/support/real-engine.ts). Until cf3-agent's @weft/mcp entry exists, the
// bundles and the suite resolve "@weft/mcp" to an empty placeholder, so deps.ts reports createRemoteMcpHandler as
// missing, the real engine refuses to boot, and pnpm cf:deploy refuses such a build.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./env-file";

export const TRACK_FILES = {
  "cf1-db": "packages/db/src/durable.ts",
  "cf2-platform": "apps/api/src/platform/durable.ts",
  "cf3-agent": "apps/mcp/src/index.ts",
} as const;
export type TrackId = keyof typeof TRACK_FILES;

export function mergedTracks(root = REPO_ROOT): { merged: TrackId[]; missing: TrackId[] } {
  const ids = Object.keys(TRACK_FILES) as TrackId[];
  const merged = ids.filter((t) => existsSync(join(root, TRACK_FILES[t])));
  return { merged, missing: ids.filter((t) => !merged.includes(t)) };
}

/** cf3-agent's portable @weft/mcp entry (no node: imports), which CompanyDO's /mcp loads. */
export const MCP_ENTRY = TRACK_FILES["cf3-agent"];
export const MCP_PLACEHOLDER = "apps/cf/src/core/company/mcp-placeholder.ts";

/** The bundler alias that stands in for @weft/mcp while its entry is absent; empty once cf3-agent is merged. */
export function mcpAlias(root = REPO_ROOT): Record<string, string> {
  return existsSync(join(root, MCP_ENTRY)) ? {} : { "@weft/mcp": join(root, MCP_PLACEHOLDER) };
}
