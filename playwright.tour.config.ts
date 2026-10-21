import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { browserUse } from "./e2e/browser";

// The guided tour's browser specs (owner: tour), separate from `pnpm e2e`: the main config's testMatch
// (gp\d+|site) never picks up e2e/tour, so its base seed and digests are untouched. `pnpm e2e:tour` starts
// scripts/dev.ts --e2e on its own data dir (.data-e2e-tour, never .data or .data-e2e) and its own ports
// (WEFT_TOUR_WEB_PORT, WEFT_TOUR_API_PORT; default 5640 and 5641). --e2e brings the scripted provider and clock rate 0
// and always seeds base; every test then rebuilds the rich world with POST /v1/sim/reset { profile: "rich" }
// (e2e/tour/tour-fixtures.ts). WEFT_TOUR_LIVE=1 (opt-in, never in CI) runs the same server on live gpt-5.6-luna with a
// $0.05 cap.
const WEB = Number(process.env.WEFT_TOUR_WEB_PORT ?? 5640);
const API = Number(process.env.WEFT_TOUR_API_PORT ?? 5641);
const LIVE = process.env.WEFT_TOUR_LIVE === "1";

const command = LIVE
  ? `node_modules/.bin/tsx scripts/dev.ts --fresh --profile rich --web-port ${WEB} --api-port ${API}`
  : `node_modules/.bin/tsx scripts/dev.ts --e2e --web-port ${WEB} --api-port ${API}`;
const env: Record<string, string> = LIVE
  ? {
      WEFT_DATA_DIR: ".data-e2e-tour-live", WEFT_LLM: "openai", WEFT_LIVE_OPENAI: "1", WEFT_CLOCK_RATE: "0",
      WEFT_SECRETS_FILE: process.env.WEFT_SECRETS_FILE ?? join(homedir(), "Developer/projects/.weft.secrets.env"),
      WEFT_LIVE_USD_CAP: "0.05", WEFT_TRACE: "off",
    }
  : { WEFT_E2E_DATA_DIR: ".data-e2e-tour" };

export default defineConfig({
  testDir: "e2e/tour",
  testMatch: /tour-.*\.spec\.ts$/,
  globalSetup: "./e2e/tour/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  outputDir: "test-results/tour",
  use: {
    baseURL: `http://127.0.0.1:${WEB}`,
    ...browserUse,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command,
    env,
    url: `http://127.0.0.1:${WEB}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
  },
});
