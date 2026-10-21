import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { mcpAlias } from "../../scripts/cf/lib/tracks";

// pnpm cf:test (docs/cloudflare/design.md 11.4): the Miniflare suite. Each file starts both Workers from the real
// wrangler configs through wrangler's createTestHarness (test/support/harness.ts) and talks to them over HTTP and RPC,
// so it runs under plain vitest 5.0.4 (no vitest-pool-workers release supports it). Files run one at a time: each
// harness is a workerd process, and the machine is shared. `pnpm cf:test apps/cf/test/extras` runs one folder.
// Until cf3-agent's @weft/mcp entry is merged, the suite resolves @weft/mcp to the same placeholder the bundles use.
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  test: {
    name: "@weft/cf workerd",
    include: ["test/**/*.test.ts"],
    exclude: ["test/unit/**", "**/node_modules/**"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 180_000,
    teardownTimeout: 60_000,
    reporters: ["default"],
  },
  resolve: { alias: { "@cf": resolve(root, "src"), ...mcpAlias() } },
});
