// pnpm cf:dev (docs/cloudflare/design.md 11.5): both Workers under `wrangler dev` on one port (default 5780, track
// cf4-worker's) with their state under .scratch/cf4-worker/cf-dev/, then provisions the pool so the guided tour runs
// against it. The configs are the deploy configs made local (scripts/cf/lib/configs.ts): the scripted provider,
// Turnstile's always-pass test secret, local random secrets in .dev.vars (mode 600, never printed), the bindings
// Miniflare does not emulate swapped for the fakes worker, the web export from apps/web/out when it exists.
//
//   pnpm cf:dev [--port 5780] [--pool 2] [--fake] [--detach]     pnpm cf:dev stop
//
// --fake runs the Miniflare suite's fake world engine (no snapshot needed); otherwise run pnpm cf:snapshot first.
// --detach returns once the pool is ready and leaves the server running (its pid is in .scratch/cf4-worker/cf-dev).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signAdmin } from "../../apps/cf/src/shared/tokens";
import { APPS_CF, writeLocalConfigs } from "./lib/configs";
import { ensureEnvValue, hex, REPO_ROOT } from "./lib/env-file";

export const DEV_DIR = join(REPO_ROOT, ".scratch/cf4-worker/cf-dev");
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
  if (argv[0] === "stop") return stop();
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] ?? null : null; };
  const port = Number(arg("--port") ?? DEFAULT_PORT);
  const fake = argv.includes("--fake");
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
  const paths = writeLocalConfigs({ dir: DEV_DIR, engine: fake ? "fake" : "real", origin, poolSize: Number(arg("--pool") ?? 2), assetsDir, configMemoMs: 1000 });
  const vars = devVars(DEV_DIR);
  writeFileSync(join(DEV_DIR, ".dev.vars"), Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });

  const log = openSync(join(DEV_DIR, "dev.log"), "a");
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
      const ops = (await (await admin(origin, vars.WEFT_ADMIN_TOKEN!, "GET", "/api/_admin/ops")).json()) as { lobby: { slots: { name: string; state: string }[] } };
      if (ops.lobby.slots.every((s) => s.state === "ready")) break;
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
