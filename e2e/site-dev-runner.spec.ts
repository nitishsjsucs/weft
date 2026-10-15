// scripts/dev.ts leaves nothing running (SPEC 0 rule 5). Owner: t6-site.
// Starts the runner API-only on a spare port in its own process group, as a terminal would, then stops it two
// ways: Ctrl+C (SIGINT to the whole foreground group) and a SIGKILLed runner (the guard must clean up). After
// each, lsof must show no listener and no process from the run may remain. Also: a busy port is refused before
// the seed runs, and the secrets variables reach the API process in dev mode but never in --e2e (read with ps -E).
// The web group gets the same environment minus the secrets by construction; starting a second `next dev` here
// would collide with the E2E web server in the same apps/web folder.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const ROOT = join(import.meta.dirname, "..");
const PORT = Number(process.env.WEFT_E2E_RUNNER_PORT ?? 4216);
const DATA = join(ROOT, ".data-e2e", "runner");

const listening = (port: number) => spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).stdout.trim();
const leftovers = (port: number) => spawnSync("pgrep", ["-f", `api-port ${port}`], { encoding: "utf8" }).stdout.trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every process descended from `root` (the runner, both guards and the API), from one `ps` snapshot. */
function descendants(root: number): number[] {
  const rows = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).stdout.trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  const out: number[] = [];
  const walk = (p: number) => { for (const [pid, ppid] of rows) if (ppid === p && pid) { out.push(pid!); walk(pid!); } };
  walk(root);
  return out;
}
const alive = (pids: number[]) => pids.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });

function startRunner(extraArgs: string[] = [], extraEnv: NodeJS.ProcessEnv = {}): { child: ChildProcess; ready: Promise<void>; output: () => string; exited: Promise<number | null> } {
  const child = spawn(join(ROOT, "node_modules/.bin/tsx"), ["scripts/dev.ts", "--api-only", "--api-port", String(PORT), "--web-port", String(PORT + 1), ...extraArgs], {
    cwd: ROOT, env: { ...process.env, WEFT_DATA_DIR: DATA, WEFT_E2E_DATA_DIR: join(DATA, "e2e"), WEFT_E2E: "1", ...extraEnv }, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  let out = "";
  const ready = new Promise<void>((resolve, reject) => {
    const on = (b: Buffer) => { out += b.toString(); if (out.includes("dev: ready")) resolve(); };
    child.stdout!.on("data", on);
    child.stderr!.on("data", on);
    child.once("exit", (code) => reject(new Error(`runner exited early (${code}):\n${out}`)));
  });
  ready.catch(() => { /* a test that expects an early exit awaits `exited` instead */ });
  return { child, ready, output: () => out, exited };
}

/** The initial environment of a process, from `ps -E` (values here never contain spaces). */
function envOf(pid: number): Record<string, string> {
  const words = spawnSync("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().split(/\s+/);
  return Object.fromEntries(words.filter((w) => /^[A-Z_][A-Z0-9_]*=/.test(w)).map((w) => [w.slice(0, w.indexOf("=")), w.slice(w.indexOf("=") + 1)]));
}
const apiProcess = (tree: number[]) => tree.find((pid) => spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.includes("src/main.ts"));

async function gone(port: number, tree: number[], ms = 12_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && (listening(port) || leftovers(port) || alive(tree).length)) await sleep(200);
}

test.describe("dev runner", () => {
  test.skip(!!listening(PORT) || !!listening(PORT + 1), `port ${PORT} or ${PORT + 1} is busy`);
  test.setTimeout(90_000);

  test("Ctrl+C stops every process group", async () => {
    const r = startRunner();
    await r.ready;
    expect(listening(PORT)).not.toBe("");
    const tree = descendants(r.child.pid!);
    expect(tree.length).toBeGreaterThanOrEqual(3);   // runner, guard, API
    process.kill(-r.child.pid!, "SIGINT");   // what a terminal sends to its foreground group
    await gone(PORT, tree);
    expect(listening(PORT), r.output()).toBe("");
    expect(leftovers(PORT)).toBe("");
    expect(alive(tree)).toEqual([]);
    expect(r.output()).toContain("dev: stopped");
  });

  test("a busy port is refused before anything is seeded or started", async () => {
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen(PORT, "127.0.0.1", () => r()));
    try {
      const r = startRunner();
      const code = await r.exited;
      expect(code, r.output()).toBe(1);
      expect(r.output()).toContain(`port ${PORT} (api) is in use by pid ${process.pid}`);
      expect(r.output()).not.toContain("seeded");
      expect(leftovers(PORT)).toBe("");
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });

  test("secrets reach the API in dev mode and never in --e2e", async ({}, info) => {
    test.setTimeout(180_000);   // two seeds: the merged world's payroll history takes about 25 s to seed
    const secrets = info.outputPath("fake.secrets.env");
    writeFileSync(secrets, "# test fixture, not a real key\nOPENAI_API_KEY=weft-test-not-a-key\n");
    const env = { WEFT_SECRETS_FILE: secrets, OPENAI_API_KEY: "weft-test-not-a-key", WEFT_LLM: "scripted" };
    for (const mode of ["dev", "e2e"] as const) {
      const r = startRunner(mode === "e2e" ? ["--e2e"] : [], env);
      await r.ready;
      const tree = descendants(r.child.pid!);
      const api = apiProcess(tree);
      expect(api, `the API process in ${mode} mode`).toBeTruthy();
      const seen = envOf(api!);
      if (mode === "dev") {
        expect(seen.WEFT_SECRETS_FILE).toBe(secrets);
        expect(seen.OPENAI_API_KEY).toBe("weft-test-not-a-key");
      } else {
        expect(seen.WEFT_SECRETS_FILE).toBeUndefined();
        expect(seen.OPENAI_API_KEY).toBeUndefined();
        expect(seen.WEFT_LLM).toBe("scripted");
        expect(seen.WEFT_CLOCK_RATE).toBe("0");
      }
      process.kill(-r.child.pid!, "SIGINT");
      await gone(PORT, tree);
      expect(alive(tree)).toEqual([]);
    }
  });

  test("a SIGKILLed runner still leaves nothing behind (the guard cleans up)", async () => {
    const r = startRunner();
    await r.ready;
    // Kill only the runner's node process, the way a crash or `kill -9` would; tsx's parent goes with it.
    const tree = descendants(r.child.pid!);
    const runner = spawnSync("pgrep", ["-f", `scripts/dev.ts --api-only --api-port ${PORT}`], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
    for (const pid of runner) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* already gone */ } }
    await gone(PORT, tree);
    expect(listening(PORT)).toBe("");
    expect(leftovers(PORT)).toBe("");
    expect(alive(tree)).toEqual([]);
  });
});
