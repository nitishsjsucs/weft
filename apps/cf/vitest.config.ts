import { defineConfig } from "vitest/config";

// The @weft/cf project in `pnpm test`: the pure modules (Lobby policy, SpendDO ledger, tokens, config, memo, the
// alarm plan and hosts, the scripts' helpers) on Node. The Miniflare suite is `pnpm cf:test` (vitest.workerd.config.ts).
export default defineConfig({
  test: {
    name: "@weft/cf",
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
  },
});
