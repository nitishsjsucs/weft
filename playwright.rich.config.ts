import { defineConfig } from "@playwright/test";

// The rich-data crawl (e2e/rich-data.spec.ts): `pnpm e2e:rich` seeds the rich profile fresh into .data-rich with the
// scripted provider and a frozen clock, then visits every audited screen and fails on an empty state that the rich
// profile should fill. Separate from `pnpm e2e`, which always runs on the base seed.
const WEB = Number(process.env.WEFT_RICH_WEB_PORT ?? 3270);
const API = Number(process.env.WEFT_RICH_API_PORT ?? 4270);

export default defineConfig({
  testDir: "e2e",
  testMatch: /rich-data\.spec\.ts$/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 600_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  outputDir: "test-results/rich",
  use: { baseURL: `http://127.0.0.1:${WEB}`, channel: "chrome", actionTimeout: 30_000, navigationTimeout: 90_000, viewport: { width: 1440, height: 900 } },
  webServer: {
    command: `node_modules/.bin/tsx scripts/dev.ts --fresh --profile rich --web-port ${WEB} --api-port ${API}`,
    url: `http://127.0.0.1:${WEB}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
    env: { WEFT_DATA_DIR: process.env.WEFT_RICH_DATA_DIR ?? ".data-rich", WEFT_LLM: "scripted", WEFT_CLOCK_RATE: "0", WEFT_SECRETS_FILE: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" },
  },
});
