// POST /v1/sim/reset while background work is still writing (owner: t2-world). Under heavy machine load the e2e
// fixture's reset answered 500: rmSync of the memory repos failed with ENOTEMPTY because a `git` child process of an
// in-flight memory write was still adding objects, and the reset had already dropped every table, so the next
// reset failed too. These tests run resets concurrently with that kind of work.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureTestPrincipals } from "@weft/core";
import { serialGit } from "@weft/executor";
import { digestDb } from "@weft/seed";
import { createTestWeft, type TestWeft } from "../src/testing";
import { ERROR_LOG } from "../src/http/errors";

let weft: TestWeft;
let expected: string;
beforeAll(async () => {
  const fresh = await createTestWeft();
  expected = await digestDb(fresh.db);
  await fresh.close();
  weft = await createTestWeft();
  await ensureTestPrincipals(weft.db);
});
afterAll(async () => { await weft.close(); });

const post = (path: string, body: unknown = {}) =>
  weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: JSON.stringify(body) });
const reset = async () => {
  const res = await post("/v1/sim/reset");
  const text = await res.text();
  return { status: res.status, text };
};
const errorLog = () => { const f = join(weft.dataDir, ERROR_LOG); return existsSync(f) ? readFileSync(f, "utf8") : ""; };

/**
 * Stands in for a slow `git commit` under load: a child process that keeps adding object files to the memory repo
 * for `ms`, queued on the git queue like every memory write. Resolves `started` once it is writing.
 */
function slowGitWriter(ms: number): { started: Promise<void>; done: Promise<void> } {
  const objects = join(weft.dataDir, "companies", "cmp_larkspur", "memory", ".git", "objects", "zz");
  let begin!: () => void;
  const started = new Promise<void>((r) => { begin = r; });
  const done = serialGit(() => new Promise<void>((resolve, reject) => {
    const script = `const fs=require("node:fs"),p=require("node:path");const d=process.argv[1];const end=Date.now()+Number(process.argv[2]);let i=0;
fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,"o"+i++),"x");process.stdout.write("ready\\n");
while(Date.now()<end){try{fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,"o"+i++),"x");}catch{}}`;
    const child = spawn(process.execPath, ["-e", script, objects, String(ms)], { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.once("data", () => begin());
    child.on("error", reject);
    child.on("exit", () => { begin(); resolve(); });
  }));
  return { started, done };
}

describe("POST /v1/sim/reset under concurrent background work", () => {
  it("waits for a git process still writing into the memory repo instead of answering 500", async () => {
    const writer = slowGitWriter(400);
    await writer.started;
    const r = await reset();
    expect(r.status, `${r.text}\n${errorLog()}`).toBe(200);
    await writer.done;
    // The writer finished before the repo was removed, so nothing it wrote survives into the new world.
    expect(existsSync(join(weft.dataDir, "companies", "cmp_larkspur", "memory", ".git", "objects", "zz"))).toBe(false);
    expect(await digestDb(weft.db)).toBe(expected);
    await ensureTestPrincipals(weft.db);
  });

  it("settles agent runs, routine runs and scheduler ticks started before the reset", async () => {
    for (let i = 0; i < 3; i++) {
      // Work a golden path leaves behind: a routine run and a chat run in the background, a clock move whose handlers
      // write memory, and a scheduler tick in flight when the reset arrives.
      const routine = await post("/v1/routines/rt_people_digest/trigger");
      expect(routine.status, await routine.clone().text()).toBe(200);
      const chat = await post("/v1/agent/runs", { text: "Who starts next week?", pageContext: null, threadId: null });
      expect(chat.status, await chat.clone().text()).toBe(202);
      const tick = weft.scheduler.kick();
      const writer = slowGitWriter(150);
      const r = await reset();
      expect(r.status, `${r.text}\n${errorLog()}`).toBe(200);
      await Promise.all([tick, writer.done]);
      expect(await digestDb(weft.db)).toBe(expected);
      await ensureTestPrincipals(weft.db);
    }
  });

  it("serializes concurrent resets, so each one answers 200 and the world matches a fresh seed", async () => {
    const writer = slowGitWriter(150);
    const results = await Promise.all([reset(), reset(), reset()]);
    await writer.done;
    expect(results.map((r) => r.status), `${results.map((r) => r.text).join("\n")}\n${errorLog()}`).toEqual([200, 200, 200]);
    expect(await digestDb(weft.db)).toBe(expected);
    await ensureTestPrincipals(weft.db);
  });
});
