// Memory snapshots (harness 18 item 6): a bundle round-trips through bundleMemory and restoreMemory with git
// bundle verify; a corrupt bundle is refused and the live repo is untouched. Owner: w2-memory.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeWorld, type World } from "../fixtures";
import { bundleMemory, restoreMemory, verifyBundle } from "../../src/memory/bundle";

const worlds: World[] = [];
afterEach(async () => { for (const w of worlds.splice(0)) await w.close(); });

// The git repository's bundles; with WEFT_MEMORY=sqlite the world's memory is the SQL repo (bundle-sql.test.ts).
describe.skipIf(process.env.WEFT_MEMORY === "sqlite")("memory bundles", () => {
  it("round-trips: bundle, change the repo, restore the bundle", async () => {
    const w = await makeWorld();
    worlds.push(w);
    const root = join(w.dir, "companies", "cmp_larkspur", "memory");
    const h = await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" });
    await w.executor.agent.exec(h, { callId: "n", command: "memory.write_note", args: { path: "workstreams/a.md", title: "A", body: "1. first", sources: ["action:1"] } });
    const before = readFileSync(join(root, "workstreams/a.md"), "utf8");
    const b = await bundleMemory(root, join(w.dir, "companies", "cmp_larkspur", "bundles"));
    expect(b.path).toMatch(/bundles\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.bundle$/);
    expect(b.head).toBe(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    expect(await verifyBundle(b.path)).toBe(b.head);

    await w.executor.agent.exec(h, { callId: "m", command: "memory.write_note", args: { path: "workstreams/a.md", title: "A", body: "1. changed", sources: ["action:1"] } });
    expect(readFileSync(join(root, "workstreams/a.md"), "utf8")).not.toBe(before);

    const r = await restoreMemory(b.path, root, "2026-10-26T16:00:00.000Z");
    expect(r.head).toBe(b.head);
    expect(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(b.head);
    expect(readFileSync(join(root, "workstreams/a.md"), "utf8")).toBe(before);
    expect(r.replaced && existsSync(join(r.replaced, "workstreams/a.md"))).toBe(true);
  });

  it("refuses a corrupt bundle and leaves the live repo alone", async () => {
    const w = await makeWorld();
    worlds.push(w);
    const root = join(w.dir, "companies", "cmp_larkspur", "memory");
    const b = await bundleMemory(root, join(w.dir, "bundles"));
    const bytes = readFileSync(b.path);
    writeFileSync(b.path, bytes.subarray(0, Math.floor(bytes.length / 2)));
    await expect(restoreMemory(b.path, root)).rejects.toMatchObject({ code: "BUNDLE_INVALID" });
    expect(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(b.head);
  });
});
