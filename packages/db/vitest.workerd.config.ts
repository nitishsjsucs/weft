import { defineConfig } from "vitest/config";

// `pnpm --filter @weft/db test:workerd`: the conformance cases inside workerd (Miniflare under plain vitest).
export default defineConfig({
  test: { name: "@weft/db:workerd", include: ["test-workerd/**/*.workerd.test.ts"], testTimeout: 90_000, hookTimeout: 120_000 },
});
