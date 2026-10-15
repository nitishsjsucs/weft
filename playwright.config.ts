import { defineConfig } from "@playwright/test";

// E2E golden paths (SPEC 12, 13). `pnpm e2e` starts scripts/dev.ts --e2e (fresh seed, scripted provider,
// clock rate 0) on web 3170 and api 4170; each spec calls POST /v1/sim/reset in beforeEach.
const WEB = Number(process.env.WEFT_E2E_WEB_PORT ?? 3170);
const API = Number(process.env.WEFT_E2E_API_PORT ?? 4170);

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${WEB}`, channel: "chrome", trace: "retain-on-failure" },
  webServer: {
    command: `pnpm exec tsx scripts/dev.ts --e2e --web-port ${WEB} --api-port ${API}`,
    url: `http://127.0.0.1:${WEB}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
