import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The @weft/cf project in `pnpm test`: the pure modules (Lobby policy, SpendDO ledger, tokens, config, memo, the
// alarm plan and hosts, the scripts' helpers) on Node, and the Lobby's lease assignment over a fake ctx where awaits
// interleave freely ("cloudflare:workers" is a stand-in here). The Miniflare suite is `pnpm cf:test`
// (vitest.workerd.config.ts).
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    name: "@weft/cf",
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
  },
  resolve: { alias: { "cloudflare:workers": resolve(root, "test/unit/cloudflare-workers.ts") } },
});
