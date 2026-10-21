import { defineProject } from "vitest/config";

// The @weft/db project in `pnpm test`; the workerd conformance run has its own config (vitest.workerd.config.ts).
export default defineProject({
  test: { name: "@weft/db", include: ["test/**/*.test.ts"] },
});
