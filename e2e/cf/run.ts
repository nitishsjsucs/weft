// pnpm e2e:cf (track cf7-integrate): Playwright with playwright.cf.config.ts, plus a `--url <origin>` option for the
// deployed project (Playwright's own command line has none), passed on as WEFT_CF_URL. Everything else goes to
// `playwright test` unchanged.
//
//   lockf /private/tmp/claude-501/weft-e2e.lock pnpm e2e:cf --project local
//   pnpm e2e:cf --project deployed --url https://weft.nitish-ratakonda.workers.dev
//   pnpm e2e:cf --project=local e2e/cf/cf-tour.spec.ts      (one file: Playwright reads every word after a bare
//                                                            --project as a project name, so use --project=<name>)
import { spawn } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT } from "./auth";

const argv = process.argv.slice(2);
const env = { ...process.env };
const rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--url") { env.WEFT_CF_URL = argv[++i] ?? ""; continue; }
  if (a.startsWith("--url=")) { env.WEFT_CF_URL = a.slice("--url=".length); continue; }
  rest.push(a);
}
if (env.WEFT_CF_URL !== undefined && !/^https?:\/\/[^/]+\/?$/.test(env.WEFT_CF_URL)) {
  console.error(`e2e:cf: --url takes an origin such as https://weft.nitish-ratakonda.workers.dev (got "${env.WEFT_CF_URL}")`);
  process.exit(2);
}
const child = spawn(join(REPO_ROOT, "node_modules/.bin/playwright"), ["test", "-c", join(REPO_ROOT, "playwright.cf.config.ts"), ...rest], { cwd: REPO_ROOT, stdio: "inherit", env });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { try { child.kill(sig); } catch { /* gone */ } });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
