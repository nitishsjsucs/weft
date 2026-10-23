import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";
import { browserUse } from "./e2e/browser";
import { LOCAL } from "./e2e/cf/auth";

// The hosted checks on Workers (docs/cloudflare/design.md 11.5 and 11.6; track cf7-integrate). Two projects:
//
// - `local`: the whole stack under `pnpm cf:dev` on http://localhost:5800 (localhost, not 127.0.0.1: the front Worker
//   checks Origin against WEFT_PUBLIC_ORIGIN, which cf:dev sets to http://localhost:<port>). Two webServers start it
//   from fresh state: the siteverify stub on 5809 (Cloudflare's test-secret answers, e2e/cf/siteverify-stub.ts) and
//   e2e/cf/local-stack.ts, which runs `cf:dev --port 5800 --pool 2 --dir .scratch/cf7/cf-dev-e2e
//   --turnstile-verify-url http://localhost:5809/turnstile/v0/siteverify` on a removed state dir. It needs
//   `pnpm cf:snapshot` and the hosted export first. Fixed ports: run it through the shared lock,
//   `lockf /private/tmp/claude-501/weft-e2e.lock pnpm e2e:cf --project local`.
// - `deployed`: the deployed URL from WEFT_CF_URL (or `pnpm e2e:cf --project deployed --url <origin>`, e2e/cf/run.ts).
//   No server starts. Every leased slot comes from the operator lease (POST /api/_admin/lease), never a Turnstile
//   challenge, and the visitor spec (which starts real Turnstile leases with the test sitekey) is local only.
//
// Tokens come from files read with awk (e2e/cf/auth.ts): the cf:dev state dir's secrets.env locally, the cf secrets
// file for the deployed URL. Specs run one at a time in file order with one worker; the pool has 2 slots.
const argv = process.argv.slice(2);
const requested = new Set<string>();
argv.forEach((a, i) => {
  if (a === "--project") for (let j = i + 1; j < argv.length && !argv[j]!.startsWith("-"); j++) requested.add(argv[j]!);
  else if (a.startsWith("--project=")) requested.add(a.slice("--project=".length));
});
const deployedUrl = process.env.WEFT_CF_URL?.replace(/\/$/, "") ?? null;
const wantLocal = requested.size === 0 || requested.has("local");
const wantDeployed = requested.has("deployed") || (requested.size === 0 && deployedUrl !== null);
if (requested.has("deployed") && !deployedUrl) throw new Error("--project deployed needs the deployed origin: set WEFT_CF_URL, or run pnpm e2e:cf --project deployed --url https://weft.nitish-ratakonda.workers.dev");

const use = {
  ...browserUse,
  actionTimeout: 30_000,
  navigationTimeout: 60_000,
  trace: "retain-on-failure" as const,
  viewport: { width: 1440, height: 900 },
};

// The project list does not depend on the command line (worker processes load this file without it); only the
// webServers and global-setup's work do. global-setup reads the selection from WEFT_CF_SELECTED (same process).
const projects: PlaywrightTestConfig["projects"] = [{ name: "local", use: { ...use, baseURL: LOCAL.origin } }];
if (deployedUrl) projects.push({ name: "deployed", testIgnore: /cf-visitor\.spec\.ts$/, use: { ...use, baseURL: deployedUrl } });
process.env.WEFT_CF_SELECTED = [wantLocal ? "local" : null, wantDeployed ? "deployed" : null].filter(Boolean).join(",");

export default defineConfig({
  testDir: "e2e/cf",
  testMatch: /cf-.*\.spec\.ts$/,
  globalSetup: "./e2e/cf/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  outputDir: "test-results/cf",
  projects,
  webServer: wantLocal
    ? [
        {
          name: "siteverify",
          command: `node_modules/.bin/tsx e2e/cf/siteverify-stub.ts --port ${LOCAL.stubPort}`,
          url: `http://localhost:${LOCAL.stubPort}/health`,
          reuseExistingServer: false,
          timeout: 30_000,
          stdout: "pipe",
          stderr: "pipe",
          gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
        },
        {
          name: "cf:dev",
          command: `node_modules/.bin/tsx e2e/cf/local-stack.ts --port ${LOCAL.port} --stub-port ${LOCAL.stubPort} --dir ${LOCAL.dir}`,
          url: `${LOCAL.origin}/api/_session`,
          wait: { stdout: /pool ready/ },
          reuseExistingServer: false,
          timeout: 420_000,
          stdout: "pipe",
          stderr: "pipe",
          gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 },
        },
      ]
    : undefined,
});
