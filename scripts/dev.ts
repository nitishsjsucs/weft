// `pnpm dev` (scaffold; t6-site owns it from here). Starts the API and the web app in their own process groups,
// checks ports first, passes WEFT_SECRETS_FILE only to the API, and kills both groups on SIGINT or SIGTERM.
// Flags: --e2e (fresh seed, scripted provider, clock rate 0), --api-port N, --web-port N.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const e2e = args.includes("--e2e");
const apiPort = Number(flag("--api-port") ?? process.env.WEFT_API_PORT ?? (e2e ? 4170 : 4070));
const webPort = Number(flag("--web-port") ?? process.env.WEFT_WEB_PORT ?? (e2e ? 3170 : 3070));
const root = join(import.meta.dirname, "..");
const dataDir = process.env.WEFT_DATA_DIR ?? join(root, e2e ? ".data-e2e" : ".data");

function portFree(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = createServer();
    s.once("error", () => ok(false));
    s.listen(port, "127.0.0.1", () => s.close(() => ok(true)));
  });
}

for (const p of [apiPort, webPort]) {
  if (!(await portFree(p))) { console.error(`dev: port ${p} is in use (lsof -nP -iTCP:${p} -sTCP:LISTEN); pick another with --api-port or --web-port`); process.exit(1); }
}

const { WEFT_SECRETS_FILE, OPENAI_API_KEY, ANTHROPIC_API_KEY, ...baseEnv } = process.env;
const shared = { ...baseEnv, WEFT_DATA_DIR: dataDir, WEFT_API_PORT: String(apiPort), WEFT_WEB_PORT: String(webPort), WEFT_DEV_AUTH: "1" };
const apiEnv: NodeJS.ProcessEnv = {
  ...shared,
  ...(WEFT_SECRETS_FILE && !e2e ? { WEFT_SECRETS_FILE } : {}),
  ...(e2e ? { WEFT_LLM: "scripted", WEFT_CLOCK_RATE: "0" } : {}),
};
void OPENAI_API_KEY; void ANTHROPIC_API_KEY;   // never forwarded to Next; the API reads the key from WEFT_SECRETS_FILE

if (e2e) {
  const env = { ...shared, WEFT_CLOCK_RATE: "0" };
  for (const cmd of ["reset", "seed"]) {
    const r = spawnSync("pnpm", ["exec", "tsx", "packages/seed/src/cli.ts", cmd], { cwd: root, env, stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
}

const children: ChildProcess[] = [];
function start(name: string, cmd: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(cmd, argv, { cwd, env, stdio: "inherit", detached: true });   // own process group
  child.on("exit", (code, sig) => { console.error(`dev: ${name} exited (${code ?? sig})`); void stop(code ?? 1); });
  children.push(child);
  return child;
}

let stopping = false;
async function stop(code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.pid && c.exitCode === null) { try { process.kill(-c.pid, "SIGTERM"); } catch { /* gone */ } }
  await new Promise((r) => setTimeout(r, 1500));
  for (const c of children) if (c.pid && c.exitCode === null) { try { process.kill(-c.pid, "SIGKILL"); } catch { /* gone */ } }
  process.exit(code);
}
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

start("api", "pnpm", ["exec", "tsx", "src/main.ts"], join(root, "apps/api"), apiEnv);
const nextArgs = e2e ? ["exec", "next", "dev", "-H", "127.0.0.1", "-p", String(webPort)] : ["exec", "next", "dev", "-H", "127.0.0.1", "-p", String(webPort)];
start("web", "pnpm", nextArgs, join(root, "apps/web"), shared);
console.log(`dev: api http://127.0.0.1:${apiPort}  web http://127.0.0.1:${webPort}  data ${dataDir}`);
