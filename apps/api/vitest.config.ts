import { defineProject } from "vitest/config";

// Each test here builds a seeded world (createTestWeft), which takes about a second alone and much longer while the
// whole repo's suite runs in parallel, so the timeouts are generous and files run one at a time.
export default defineProject({
  test: { name: "@weft/api", testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false },
});
