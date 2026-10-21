// pnpm cf:dev (docs/cloudflare/design.md 11.5): both Workers under `wrangler dev` on one port (default 5780, track
// cf4-worker's) with their state under .scratch/cf4-worker/cf-dev/, then provisions the pool so the guided tour runs
// against it. The configs are the deploy configs made local (scripts/cf/lib/configs.ts): the scripted provider,
// Turnstile's always-pass test secret, local random secrets in .dev.vars (mode 600, never printed), the bindings
// Miniflare does not emulate swapped for the fakes worker, the web export from apps/web/out when it exists, with the
// snapshot's stats.json copied beside it (the hosted landing fetches /stats.json).
//
//   pnpm cf:dev [--port 5780] [--pool 2] [--dir .scratch/<track>/cf-dev] [--fake] [--detach]
//               [--turnstile-verify-url http://127.0.0.1:<port>/siteverify]                       pnpm cf:dev stop [--dir ...]
//
// --turnstile-verify-url (or WEFT_CF_DEV_TURNSTILE_VERIFY_URL) points the front Worker's siteverify at a local stand-in
// with Cloudflare's published test-secret answers: workerd does not use an HTTPS proxy, so where the internet is
// reachable only through one (a cloud container) the real siteverify is out of reach. The deploy configs never set it.
// The pool must fit one day's restore budget (the showcase and slot-smoke plus --pool slots, each a full restore):
// cf:dev refuses a larger pool at once, and stops waiting when the Lobby defers a restore (state kept from earlier
// runs under --dir can have used today's budget; start from a fresh --dir).
//
// PDFs stay pending locally: the fakes worker's FakeBrowser answers Browser Run's session request with 501, since
// @cloudflare/puppeteer needs a real browser session over a DevTools WebSocket that Miniflare does not emulate. The
// render job fails, is retried and ends in weft-dlq; the deployed smoke checks PDFs end to end.
//
// The weft-ops D1 schema (apps/cf/d1) is applied to the local state first (wrangler d1 migrations apply --local),
// since Miniflare creates the database empty.
// --fake runs the Miniflare suite's fake world engine (no snapshot needed); otherwise run pnpm cf:snapshot first.
// --detach returns once the pool is ready and leaves the server running (its pid is in .scratch/cf4-worker/cf-dev).
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultBudget, emptyUsage, restoresLeft, type BudgetConfig } from "../../apps/cf/src/core/lobby/policy";
import { signAdmin } from "../../apps/cf/src/shared/tokens";
import { APPS_CF, writeLocalConfigs } from "./lib/configs";
import { ensureEnvValue, hex, REPO_ROOT } from "./lib/env-file";

export const DEFAULT_DEV_DIR = join(REPO_ROOT, ".scratch/cf4-worker/cf-dev");
/** --dir (repo-relative or absolute), so each track keeps its own state (cf7 runs on port 5800 under .scratch/cf7). */
const devDir = (argv: string[]): string => {
  const i = argv.indexOf("--dir");
  const d = i >= 0 ? argv[i + 1] : undefined;
  return d ? (d.startsWith("/") ? d : join(REPO_ROOT, d)) : DEFAULT_DEV_DIR;
};
let DEV_DIR = DEFAULT_DEV_DIR;
export const DEFAULT_PORT = 5780;
const TURNSTILE_PASS = "1x0000000000000000000000000000000AA";

export function portInUse(port: number): boolean {
  try {
    return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
  } catch {
    return false;
  }
}

/** The local secrets every Worker reads from .dev.vars (generated once, kept under the dev dir). */
export function devVars(dir: string): Record<string, string> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "secrets.env");
  const v: Record<string, string> = {};
  for (const name of ["WEFT_SESSION_SECRET", "WEFT_CTX_SECRET", "WEFT_PROXY_SECRET", "WEFT_SMOKE_TOKEN", "WEFT_ADMIN_TOKEN", "WEFT_VAULT_KEY"]) {
    v[name] = ensureEnvValue(file, name, () => hex(32)).value;
  }
  v.TURNSTILE_SECRET = TURNSTILE_PASS;
  return v;
}

/** Why the pool cannot be provisioned in one day (null when it can): the showcase, slot-smoke and every pool slot are
 * one full restore each, and the Lobby starts only as many as fit the provisioning ceiling. */
export function poolRestoreProblem(pool: number, budget: BudgetConfig = defaultBudget()): string | null {
  if (!Number.isInteger(pool) || pool < 1) return `--pool ${pool} is not a whole number of slots (1 or more)`;
  const fit = restoresLeft(emptyUsage(), budget);
  const worlds = pool + 2;
  if (worlds <= fit) return null;
  return `--pool ${pool} needs ${worlds} full restores (the showcase, slot-smoke and ${pool} slots, ${budget.fullRestoreRows.toLocaleString("en-US")} rows each), `
    + `but one day's restore budget (${Math.max(budget.provisionRowsCeiling, budget.rowsWrittenShare).toLocaleString("en-US")} rows written) fits ${fit}: use --pool ${Math.max(1, fit - 2)} or less`;
}

/** The siteverify URL for a local run (--turnstile-verify-url, else WEFT_CF_DEV_TURNSTILE_VERIFY_URL), or null. */
export function turnstileVerifyUrl(argv: string[], env: NodeJS.ProcessEnv = process.env): string | null {
  const i = argv.indexOf("--turnstile-verify-url");
  const v = (i >= 0 ? argv[i + 1] : undefined) ?? env.WEFT_CF_DEV_TURNSTILE_VERIFY_URL ?? "";
  if (!v) return null;
  let u: URL;
  try { u = new URL(v); } catch { throw new Error(`--turnstile-verify-url ${v} is not a URL`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`--turnstile-verify-url ${v} is not an http(s) URL`);
  return u.toString();
}

/** Worlds the Lobby left unrestored for today's budget ("restore deferred"), as the ops readout lists them. */
export const deferredWorlds = (slots: readonly { name: string; state: string; error?: string | null }[]): string[] =>
  slots.filter((s) => s.state !== "ready" && /restore deferred/.test(s.error ?? "")).map((s) => s.name);

async function waitFor(url: string, ms: number): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error(`${url} did not answer within ${ms / 1000} s; see ${join(DEV_DIR, "dev.log")}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function admin(origin: string, token: string, method: string, path: string, body?: unknown): Promise<Response> {
  const text = body === undefined ? "" : JSON.stringify(body);
  return fetch(`${origin}${path}`, { method, headers: { "x-weft-admin": await signAdmin({ token, method, path, body: text }), ...(text ? { "content-type": "application/json" } : {}) }, body: text || undefined });
}

function stop(): void {
  const pidFile = join(DEV_DIR, "dev.pid");
  if (!existsSync(pidFile)) { console.log("cf:dev: not running"); return; }
  const pid = Number(readFileSync(pidFile, "utf8"));
  try { process.kill(-pid, "SIGTERM"); } catch { /* gone */ }
  rmSync(pidFile, { force: true });
  console.log(`cf:dev: stopped process group ${pid}`);
}

async function main(argv: string[]): Promise<void> {
  DEV_DIR = devDir(argv);
  if (argv[0] === "stop") return stop();
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] ?? null : null; };
  const port = Number(arg("--port") ?? DEFAULT_PORT);
  const fake = argv.includes("--fake");
  const pool = Number(arg("--pool") ?? 2);
  const poolProblem = poolRestoreProblem(pool);
  if (poolProblem) throw new Error(poolProblem);
  const verifyUrl = turnstileVerifyUrl(argv);
  if (portInUse(port)) throw new Error(`port ${port} is in use; pick another with --port`);
  if (!fake && !existsSync(join(APPS_CF, "generated/manifest.json"))) throw new Error("no snapshot in apps/cf/generated: run pnpm cf:snapshot first (or pass --fake)");
  mkdirSync(DEV_DIR, { recursive: true });
  const origin = `http://localhost:${port}`;
  const webOut = join(REPO_ROOT, "apps/web/out");
  let assetsDir = webOut;
  if (!existsSync(join(webOut, "index.html"))) {
    assetsDir = join(DEV_DIR, "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "index.html"), "<!doctype html><title>Weft (cf:dev)</title><p>No static export yet: run WEFT_STATIC_EXPORT=1 NEXT_PUBLIC_WEFT_HOSTED=1 pnpm --filter @weft/web build.</p>\n");
    console.log("cf:dev: apps/web/out has no static export; serving a placeholder page (the API works)");
  }
  // The landing's numbers (pnpm cf:build does the same for the deploy). The assets manifest is read at start.
  const stats = join(APPS_CF, "generated/stats.json");
  if (existsSync(stats)) copyFileSync(stats, join(assetsDir, "stats.json"));
  const paths = writeLocalConfigs({
    dir: DEV_DIR, engine: fake ? "fake" : "real", origin, poolSize: pool, assetsDir, configMemoMs: 1000,
    ...(verifyUrl ? { frontVars: { TURNSTILE_VERIFY_URL: verifyUrl } } : {}),
  });
  if (verifyUrl) console.log(`cf:dev: siteverify goes to ${verifyUrl}`);
  const vars = devVars(DEV_DIR);
  writeFileSync(join(DEV_DIR, ".dev.vars"), Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });

  const log = openSync(join(DEV_DIR, "dev.log"), "a");
  // weft-ops: the extras' job ledger, run catalog and failed jobs need their tables before the first job.
  execFileSync(join(REPO_ROOT, "node_modules/.bin/wrangler"), ["d1", "migrations", "apply", "weft-ops", "--local", "--persist-to", join(DEV_DIR, "state"), "-c", paths.core], {
    cwd: APPS_CF, stdio: ["ignore", log, log], env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  const child = spawn(join(REPO_ROOT, "node_modules/.bin/wrangler"), [
    "dev", "-c", paths.front, "-c", paths.core, "-c", paths.fakes, "--port", String(port), "--ip", "127.0.0.1",
    "--persist-to", join(DEV_DIR, "state"), "--log-level", "warn", "--show-interactive-dev-session=false",
  ], { cwd: APPS_CF, detached: true, stdio: ["ignore", log, log], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  writeFileSync(join(DEV_DIR, "dev.pid"), String(child.pid));
  const kill = () => { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ } rmSync(join(DEV_DIR, "dev.pid"), { force: true }); };
  try {
    await waitFor(`${origin}/api/_session`, 180_000);
    const r = await admin(origin, vars.WEFT_ADMIN_TOKEN!, "POST", "/api/_admin/provision", {});
    if (r.status !== 200) throw new Error(`provision answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const t0 = Date.now();
    for (;;) {
      const ops = (await (await admin(origin, vars.WEFT_ADMIN_TOKEN!, "GET", "/api/_admin/ops")).json()) as { lobby: { slots: { name: string; state: string; error: string | null }[] } };
      if (ops.lobby.slots.every((s) => s.state === "ready")) break;
      const deferred = deferredWorlds(ops.lobby.slots);
      if (deferred.length) throw new Error(`the Lobby deferred ${deferred.join(", ")}: today's restore budget is used (state from earlier runs is kept under ${DEV_DIR.replace(REPO_ROOT + "/", "")}; use a fresh --dir, or wait for 00:00 UTC)`);
      if (ops.lobby.slots.some((s) => s.state === "failed")) throw new Error(`a world failed to restore: ${JSON.stringify(ops.lobby.slots)}`);
      if (Date.now() - t0 > 300_000) throw new Error("the pool was not ready within 5 minutes");
      await new Promise((res) => setTimeout(res, 1000));
    }
  } catch (e) {
    kill();
    throw e;
  }
  console.log(`cf:dev: ${origin} (pool ready, ${fake ? "fake" : "real"} engine, data ${DEV_DIR.replace(REPO_ROOT + "/", "")}, log dev.log, pid ${child.pid})`);
  if (argv.includes("--detach")) { child.unref(); return; }
  process.on("SIGINT", () => { kill(); process.exit(0); });
  process.on("SIGTERM", () => { kill(); process.exit(0); });
  await new Promise<void>((res) => child.on("exit", () => res()));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e: unknown) => { console.error(`cf:dev: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
