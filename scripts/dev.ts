// `pnpm dev` and the E2E runner (SPEC 0 rule 5, 13). Owner: t6-site.
//
// Starts the API (tsx apps/api/src/main.ts) and the web app (next dev -H 127.0.0.1), each in its own process
// group, after checking both ports with lsof and a bind probe. Every group is led by a small guard process that
// kills its whole group if this runner disappears (even on SIGKILL), so nothing is left listening. On SIGINT,
// SIGTERM or SIGHUP the runner sends SIGTERM to each group, waits for the groups to empty, then SIGKILLs what is left.
//
// Secrets: WEFT_SECRETS_FILE, OPENAI_API_KEY and ANTHROPIC_API_KEY reach only the API, never Next. In --e2e mode
// none of them is passed at all (scripted provider).
//
// Flags:
//   --e2e            fresh seed into .data-e2e, scripted provider, clock rate 0, ports 3170 (web) and 4170 (api)
//   --fresh          reset and re-seed the data dir before starting (implied by --e2e; automatic when no db exists)
//   --api-port N     API port (default 4070, e2e 4170; env WEFT_API_PORT)
//   --web-port N     web port (default 3070, e2e 3170; env WEFT_WEB_PORT)
//   --api-only       start only the API
//   --profile P      seed profile for a fresh seed: rich (default, history on every screen) or base (the pinned test
//                    world); env WEFT_SEED_PROFILE. --e2e always seeds base.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const e2e = args.includes("--e2e");
const apiOnly = args.includes("--api-only");
const profile = e2e ? "base" : (flag("--profile") ?? process.env.WEFT_SEED_PROFILE ?? "rich");
if (profile !== "base" && profile !== "rich") { console.error(`dev: --profile must be base or rich, got ${profile}`); process.exit(2); }
const apiPort = Number(flag("--api-port") ?? (e2e ? 4170 : process.env.WEFT_API_PORT ?? 4070));
const webPort = Number(flag("--web-port") ?? (e2e ? 3170 : process.env.WEFT_WEB_PORT ?? 3070));
const root = resolve(import.meta.dirname, "..");
const dataDir = resolve(root, e2e ? (process.env.WEFT_E2E_DATA_DIR ?? ".data-e2e") : (process.env.WEFT_DATA_DIR ?? ".data"));
const log = (msg: string) => console.error(`dev: ${msg}`);

for (const p of [apiPort, webPort]) if (!Number.isInteger(p) || p < 1024 || p > 65535) { log(`bad port ${p}`); process.exit(2); }
if (apiPort === webPort) { log("the api and web ports must differ"); process.exit(2); }

// ---- port checks ---------------------------------------------------------------------------------------------

/** PIDs listening on the port per lsof, or null when lsof is unavailable. */
function lsofListeners(port: number): string[] | null {
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  if (r.error) return null;
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

function bindable(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = createServer();
    s.once("error", () => ok(false));
    s.listen(port, "127.0.0.1", () => s.close(() => ok(true)));
  });
}

async function checkPort(port: number, name: string): Promise<void> {
  const pids = lsofListeners(port);
  if (pids && pids.length) {
    log(`port ${port} (${name}) is in use by pid ${pids.join(", ")} (lsof -nP -iTCP:${port} -sTCP:LISTEN); stop that process or pass --${name}-port`);
    process.exit(1);
  }
  if (!(await bindable(port))) { log(`port ${port} (${name}) cannot be bound on 127.0.0.1; pass --${name}-port`); process.exit(1); }
}

/** PIDs of a next dev (or its next-server child) already running in apps/web. Next 16 allows one per app directory. */
function liveNextDev(webDir: string): string[] {
  const r = spawnSync("pgrep", ["-f", "next dev|next-server"], { encoding: "utf8" });
  if (r.error) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean).filter((pid) => {
    const c = spawnSync("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], { encoding: "utf8" });
    return (c.stdout ?? "").split("\n").some((l) => l === `n${webDir}`);
  });
}

await checkPort(apiPort, "api");
if (!apiOnly) await checkPort(webPort, "web");
if (!apiOnly) {
  const busy = liveNextDev(join(root, "apps/web"));
  if (busy.length) {
    log(`a next dev server is already running in this checkout (pid ${busy.join(", ")}); Next allows one per app directory. Stop it, or run from a separate clone`);
    process.exit(1);
  }
}

// next dev rewrites the tracked apps/web/next-env.d.ts (.next/types to .next/dev/types); put it back on stop.
const nextEnvFile = join(root, "apps/web/next-env.d.ts");
const nextEnvBefore = (() => { try { return readFileSync(nextEnvFile, "utf8"); } catch { return null; } })();
function restoreNextEnv(): void {
  if (nextEnvBefore === null) return;
  try { if (readFileSync(nextEnvFile, "utf8") !== nextEnvBefore) writeFileSync(nextEnvFile, nextEnvBefore); } catch { /* best effort */ }
}

// ---- environment -----------------------------------------------------------------------------------------------

const { WEFT_SECRETS_FILE, OPENAI_API_KEY, ANTHROPIC_API_KEY, ...baseEnv } = process.env;
const shared: NodeJS.ProcessEnv = {
  ...baseEnv,
  WEFT_DATA_DIR: dataDir,
  WEFT_API_PORT: String(apiPort),
  WEFT_WEB_PORT: String(webPort),
  WEFT_DEV_AUTH: "1",
  NEXT_TELEMETRY_DISABLED: "1",
  ...(e2e ? { WEFT_LLM: "scripted", WEFT_CLOCK_RATE: "0", WEFT_E2E: "1" } : {}),
};
const secrets: NodeJS.ProcessEnv = e2e ? {} : Object.fromEntries(
  Object.entries({ WEFT_SECRETS_FILE, OPENAI_API_KEY, ANTHROPIC_API_KEY }).filter(([, v]) => !!v),
);
const apiEnv: NodeJS.ProcessEnv = { ...shared, ...secrets };
const webEnv: NodeJS.ProcessEnv = { ...shared };

const bin = (rel: string, name: string): [string, string[]] => {
  const p = join(root, rel, "node_modules/.bin", name);
  return existsSync(p) ? [p, []] : ["pnpm", ["exec", name]];
};

// ---- seed -------------------------------------------------------------------------------------------------------

if (e2e || args.includes("--fresh") || !existsSync(join(dataDir, "weft.db"))) {
  const [tsx, pre] = bin("", "tsx");
  // Seeding never calls a model and gets no secrets, so it always composes with the scripted provider. Without this,
  // WEFT_LLM=openai reached the seed step and it failed with PROVIDER_CONFIG before the API ever started.
  const { WEFT_BACKGROUND_LLM: _background, ...seedBase } = shared;
  const seedEnv: NodeJS.ProcessEnv = { ...seedBase, WEFT_LLM: "scripted", WEFT_SEED_PROFILE: profile };
  log(`seeding ${dataDir} with the ${profile} profile`);
  for (const cmd of ["reset", "seed"]) {
    const r = spawnSync(tsx, [...pre, "packages/seed/src/cli.ts", cmd], { cwd: root, env: seedEnv, stdio: "inherit" });
    if (r.status !== 0) { log(`db ${cmd} failed (${r.status ?? r.signal})`); process.exit(r.status ?? 1); }
  }
}

// ---- process groups -----------------------------------------------------------------------------------------

// The guard leads the group: it runs the real command in the same group, forwards its exit code, and kills the
// whole group when the runner (its parent) is gone. It ignores SIGTERM and SIGINT itself so it outlives the command.
const GUARD = `
const { spawn } = require("node:child_process");
const parent = Number(process.argv[1]);
const child = spawn(process.argv[2], process.argv.slice(3), { stdio: ["ignore", "inherit", "inherit"] });
let ending = false;
const killGroup = (sig) => { try { process.kill(0, sig); } catch {} };
const end = () => {
  if (ending) return; ending = true;
  killGroup("SIGTERM");
  setTimeout(() => killGroup("SIGKILL"), 3000);
};
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => {});
child.on("error", (e) => { console.error("dev guard: " + e.message); process.exit(127); });
child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
setInterval(() => {
  let alive = process.ppid === parent;
  if (alive) { try { process.kill(parent, 0); } catch { alive = false; } }
  if (!alive) end();
}, 500);
`;

interface Group { name: string; child: ChildProcess; pgid: number }
const groups: Group[] = [];

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
const killGroup = (pgid: number, sig: NodeJS.Signals) => { try { process.kill(-pgid, sig); } catch { /* group gone */ } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function start(name: string, cmd: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const child = spawn(process.execPath, ["-e", GUARD, String(process.pid), cmd, ...argv], { cwd, env, stdio: ["ignore", "inherit", "inherit"], detached: true });
  if (!child.pid) { log(`${name} failed to start`); void stop(1); return; }
  groups.push({ name, child, pgid: child.pid });
  child.on("exit", (code, sig) => {
    if (!stopping) { log(`${name} exited (${code ?? sig}); stopping the rest`); void stop(code || 1); }
  });
}

let stopping = false;
async function stop(code = 0): Promise<never> {
  if (!stopping) {
    stopping = true;
    for (const g of groups) killGroup(g.pgid, "SIGTERM");
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && groups.some((g) => groupAlive(g.pgid))) await sleep(100);
    for (const g of groups) if (groupAlive(g.pgid)) { log(`${g.name} did not stop on SIGTERM; sending SIGKILL to group ${g.pgid}`); killGroup(g.pgid, "SIGKILL"); }
    const hard = Date.now() + 3000;
    while (Date.now() < hard && groups.some((g) => groupAlive(g.pgid))) await sleep(50);
    restoreNextEnv();
    log("stopped");
  }
  process.exit(code);
}
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, () => void stop(0));

const [tsx, tsxPre] = bin("", "tsx");
start("api", tsx, [...tsxPre, "src/main.ts"], join(root, "apps/api"), apiEnv);
if (!apiOnly) {
  const [next, nextPre] = bin("apps/web", "next");
  start("web", next, [...nextPre, "dev", "-H", "127.0.0.1", "-p", String(webPort)], join(root, "apps/web"), webEnv);
}

// ---- readiness ------------------------------------------------------------------------------------------------

async function waitFor(url: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until && !stopping) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.status < 500 || r.status === 501) return true; } catch { /* not yet */ }
    await sleep(250);
  }
  return false;
}

const apiUp = await waitFor(`http://127.0.0.1:${apiPort}/v1/health`, 60_000);
const webUp = apiOnly || (await waitFor(`http://127.0.0.1:${webPort}/`, 120_000));
if (!stopping) {
  if (apiUp && webUp) log(`ready: api http://127.0.0.1:${apiPort}${apiOnly ? "" : `  web http://127.0.0.1:${webPort}`}  data ${dataDir}${e2e ? "  (e2e: scripted provider, clock rate 0)" : ""}. Ctrl+C stops both groups.`);
  else log(`still waiting: api ${apiUp ? "up" : "down"}, web ${webUp ? "up" : "down"}`);
}
