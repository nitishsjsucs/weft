// scripts/dev.ts leaves nothing running (SPEC 0 rule 5). Owner: t6-site.
// Starts the runner API-only on a spare port in its own process group, as a terminal would, then stops it two
// ways: Ctrl+C (SIGINT to the whole foreground group) and a SIGKILLed runner (the guard must clean up). After
// each, lsof must show no listener and no process from the run may remain.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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

function startRunner(): { child: ChildProcess; ready: Promise<void>; output: () => string } {
  const child = spawn(join(ROOT, "node_modules/.bin/tsx"), ["scripts/dev.ts", "--api-only", "--api-port", String(PORT), "--web-port", String(PORT + 1)], {
    cwd: ROOT, env: { ...process.env, WEFT_DATA_DIR: DATA, WEFT_E2E: "1" }, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const ready = new Promise<void>((resolve, reject) => {
    const on = (b: Buffer) => { out += b.toString(); if (out.includes("dev: ready")) resolve(); };
    child.stdout!.on("data", on);
    child.stderr!.on("data", on);
    child.once("exit", (code) => reject(new Error(`runner exited early (${code}):\n${out}`)));
  });
  return { child, ready, output: () => out };
}

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
