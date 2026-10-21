import { defineConfig } from "@playwright/test";
import { browserUse } from "./e2e/browser";

// E2E golden paths (SPEC 12, 13). Owner: t6-site.
// `pnpm e2e` starts scripts/dev.ts --e2e (fresh seed into .data-e2e, scripted provider, clock rate 0) on web 3170
// and api 4170, waits for /api/v1/health through the web proxy (so both servers are up), warms the pages, then
// runs GP1 to GP5 one at a time. Every test resets the world first (fixtures.ts). On teardown Playwright sends
// SIGTERM to the runner, which stops both process groups; the default SIGKILL would skip that cleanup.
const WEB = Number(process.env.WEFT_E2E_WEB_PORT ?? 3170);
const API = Number(process.env.WEFT_E2E_API_PORT ?? 4170);

export default defineConfig({
  testDir: "e2e",
  testMatch: /(gp\d+|site)-.*\.spec\.ts$/,
  globalSetup: "./e2e/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // SPEC 12: 30 s for every wait, action and navigation; a golden path is several page visits, so the whole
  // test gets 120 s.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: `http://127.0.0.1:${WEB}`,
    ...browserUse,
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `node_modules/.bin/tsx scripts/dev.ts --e2e --web-port ${WEB} --api-port ${API}`,
    url: `http://127.0.0.1:${WEB}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
  },
});
