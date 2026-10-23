import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { browserUse } from "../../e2e/browser";

// The hosted web checks (track cf5-web; docs/cloudflare/tracks.md cf5-web). `pnpm --filter @weft/web e2e:hosted`
// serves the hosted static export (apps/web/out, built with WEFT_STATIC_EXPORT=1 NEXT_PUBLIC_WEFT_HOSTED=1) through
// `wrangler dev` with an assets-only Worker, so `_redirects`, `_headers`, html_handling and not_found_handling behave as
// Workers static assets do. Nothing reaches Cloudflare: the browser's /api calls and the /api/_live socket are answered
// by the tests (the mock world), and Turnstile's script is a stub. Port 5790 is cf5's (check it is free first; run
// through the shared lock: lockf /private/tmp/claude-501/weft-e2e.lock pnpm --filter @weft/web e2e:hosted). The browser
// is Google Chrome, or the binary WEFT_PW_EXECUTABLE names (e2e/browser.ts).
const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEFT_HOSTED_WEB_PORT ?? 5790);
const INSPECTOR = PORT + 1;
// wrangler writes a .wrangler state folder beside its config, so the config lives in the worktree's .scratch. The
// webServer command writes it (e2e/hosted-wrangler.ts) just before wrangler starts; loading this file writes nothing.
const scratch = join(here, "../../.scratch/cf5-web/e2e-hosted");
const wranglerConfig = join(scratch, "wrangler.assets.jsonc");

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.pw\.ts$/,
  globalSetup: "./e2e/hosted-global-setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: "../../test-results/web-hosted",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...browserUse,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `node e2e/hosted-wrangler.ts ${wranglerConfig} ${join(here, "out")} && node ../../node_modules/wrangler/bin/wrangler.js dev -c ${wranglerConfig} --ip 127.0.0.1 --port ${PORT} --inspector-port ${INSPECTOR} --persist-to ${join(scratch, "state")}`,
    env: { WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(scratch, "logs"), CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" },
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
