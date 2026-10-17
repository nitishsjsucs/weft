// pnpm phoenix:up | phoenix:down | phoenix:status (docs/wave4.md section 3).
// Runs the pinned Arize Phoenix locally through uvx, bound to 127.0.0.1, telemetry and external resources off, with its
// SQLite data in ~/Developer/projects/weft-notes/phoenix (outside the repo, never committed). One long-lived instance
// serves the whole wave: `up` reuses a running one. The server gets a minimal environment, so no key from this shell
// (OPENAI_API_KEY and the rest) ever reaches it. `down` stops only the process group this script started.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PHOENIX } from "../packages/contracts/src/telemetry";

const httpPort = Number(process.env.WEFT_PHOENIX_PORT ?? PHOENIX.httpPort);
const grpcPort = Number(process.env.WEFT_PHOENIX_GRPC_PORT ?? PHOENIX.grpcPort);
const workDir = process.env.WEFT_PHOENIX_DIR ?? join(homedir(), PHOENIX.workingDir);
const stateDir = dirname(workDir);
const pgidFile = join(stateDir, `phoenix-${httpPort}.pgid`);
const logFile = join(stateDir, `phoenix-${httpPort}.log`);
const url = `http://${PHOENIX.host}:${httpPort}`;
const FORBIDDEN = [3070, 4070, 3170, 4170];

function listening(port: number): boolean {
  return spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.trim().length > 0;
}
async function version(): Promise<string | null> {
  try {
    const r = await fetch(`${url}/arize_phoenix_version`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? (await r.text()).trim() : null;
  } catch { return null; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function readPgid(): number | null {
  try { const n = Number(readFileSync(pgidFile, "utf8").trim()); return Number.isInteger(n) && n > 1 ? n : null; } catch { return null; }
}

async function up(): Promise<void> {
  if (FORBIDDEN.includes(httpPort) || FORBIDDEN.includes(grpcPort)) throw new Error(`port ${httpPort}/${grpcPort} is reserved for pnpm dev or e2e`);
  const running = await version();
  if (running) {
    if (running !== PHOENIX.version) throw new Error(`Phoenix ${running} is on ${url}; wave 4 pins ${PHOENIX.version}`);
    console.log(`Phoenix ${running} already running at ${url} (data ${workDir})`);
    return;
  }
  for (const p of [httpPort, grpcPort]) if (listening(p)) throw new Error(`port ${p} is in use by another process; set WEFT_PHOENIX_PORT and WEFT_PHOENIX_GRPC_PORT`);
  mkdirSync(workDir, { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), LANG: process.env.LANG ?? "en_US.UTF-8", TMPDIR: process.env.TMPDIR ?? "/tmp",
    PHOENIX_PORT: String(httpPort), PHOENIX_GRPC_PORT: String(grpcPort), PHOENIX_HOST: PHOENIX.host, PHOENIX_WORKING_DIR: workDir,
    PHOENIX_TELEMETRY_ENABLED: "false", PHOENIX_ALLOW_EXTERNAL_RESOURCES: "false",
  };
  for (const k of ["UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) if (process.env[k]) env[k] = process.env[k] as string;
  const log = openSync(logFile, "a");
  const child = spawn("uvx", ["--python", PHOENIX.python, "--from", `arize-phoenix==${PHOENIX.version}`, "phoenix", "serve"], { env, detached: true, stdio: ["ignore", log, log] });
  if (!child.pid) throw new Error("could not start uvx");
  writeFileSync(pgidFile, String(child.pid));   // detached: the child leads its own process group
  child.unref();
  const deadline = Date.now() + 180_000;   // the first uvx run downloads CPython and the wheels
  while (Date.now() < deadline) {
    const v = await version();
    if (v) { console.log(`Phoenix ${v} up at ${url} (data ${workDir}, log ${logFile}, pgid ${child.pid})`); return; }
    if (child.exitCode !== null) break;
    await sleep(1000);
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
  rmSync(pgidFile, { force: true });
  throw new Error(`Phoenix did not become ready on ${url}; see ${logFile}`);
}

async function down(): Promise<void> {
  const pgid = readPgid();
  if (!pgid) { console.log(`no Phoenix started by this script on port ${httpPort} (${pgidFile} missing)`); return; }
  try { process.kill(-pgid, "SIGTERM"); } catch { /* already gone */ }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && (listening(httpPort) || listening(grpcPort))) await sleep(250);
  if (listening(httpPort) || listening(grpcPort)) { try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } await sleep(500); }
  rmSync(pgidFile, { force: true });
  console.log(`Phoenix stopped (pgid ${pgid}); ports ${httpPort} and ${grpcPort} ${listening(httpPort) || listening(grpcPort) ? "still busy" : "closed"}`);
}

async function status(): Promise<void> {
  const v = await version();
  console.log(v ? `Phoenix ${v} at ${url} (data ${workDir}, pgid ${readPgid() ?? "not started here"})` : `Phoenix is not running on ${url}`);
}

const cmd = process.argv[2];
const run = cmd === "up" ? up : cmd === "down" ? down : cmd === "status" ? status : null;
if (!run) { console.error("usage: tsx scripts/phoenix.ts up | down | status"); process.exit(2); }
run().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
