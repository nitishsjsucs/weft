import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// The hosted web checks (track cf5-web; docs/cloudflare/tracks.md cf5-web). `pnpm --filter @weft/web e2e:hosted`
// serves the hosted static export (apps/web/out, built with WEFT_STATIC_EXPORT=1 NEXT_PUBLIC_WEFT_HOSTED=1) through
// `wrangler dev` with an assets-only Worker, so `_redirects`, `_headers`, html_handling and not_found_handling behave as
// Workers static assets do. Nothing reaches Cloudflare: the browser's /api calls and the /api/_live socket are answered
// by the tests (the mock world), and Turnstile's script is a stub. Port 5790 is cf5's (check it is free first; run
// through the shared lock: lockf /private/tmp/claude-501/weft-e2e.lock pnpm --filter @weft/web e2e:hosted).
const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEFT_HOSTED_WEB_PORT ?? 5790);
const INSPECTOR = PORT + 1;
// wrangler writes a .wrangler state folder beside its config, so the config lives in the worktree's .scratch.
const scratch = join(here, "../../.scratch/cf5-web/e2e-hosted");
mkdirSync(scratch, { recursive: true });
const wranglerConfig = join(scratch, "wrangler.assets.jsonc");
writeFileSync(wranglerConfig, JSON.stringify({
  name: "weft-hosted-web-check",
  compatibility_date: "2026-10-01",
  // The same asset settings as apps/cf/wrangler.front.jsonc (design 9.4), without the Worker.
  assets: { directory: join(here, "out"), html_handling: "force-trailing-slash", not_found_handling: "404-page" },
}, null, 2));

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
    channel: "chrome",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `node ../../node_modules/wrangler/bin/wrangler.js dev -c ${wranglerConfig} --ip 127.0.0.1 --port ${PORT} --inspector-port ${INSPECTOR} --persist-to ${join(scratch, "state")}`,
    env: { WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(scratch, "logs"), CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" },
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
