// memory:bundle and memory:restore for the SQL repo (WEFT_MEMORY=sqlite): the same verified git bundle format as the
// git repo's, a round trip that restores HEAD and every file, the replaced history bundled beside it, and a corrupt
// bundle refused with the repo untouched. Owner: cf1-db.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, migrate, openDb, type Db } from "@weft/db";
import { bundleSqlMemory, restoreSqlMemory, verifyBundle } from "../../src/memory/bundle";
import { SqlRepo } from "../../src/memory/repo-sql";

const dirs: string[] = [];
const dbs: Db[] = [];
afterAll(async () => { for (const db of dbs) await closeDb(db); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
async function repoDb(): Promise<{ db: Db; repo: SqlRepo; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "weft-memsql-bundle-test-"));
  dirs.push(dir);
  const db = openDb({ dataDir: dir });
  await migrate(db);
  dbs.push(db);
  return { db, repo: new SqlRepo(db), dir };
}

describe("SQL memory bundles", () => {
  it("round-trips: bundle, change the repo, restore the bundle", { timeout: 60_000 }, async () => {
    const { db, repo, dir } = await repoDb();
    await repo.init([{ path: "README.md", text: "# memory\n" }, { path: "knowledge/.keep.md", text: "" }], { message: "memory: initialise", date: "2026-10-26T15:30:00.000Z" });
    await repo.commit({ changes: [{ path: "workstreams/a.md", text: "1. first\n" }], message: "note: a", date: "2026-10-26T15:31:00.000Z" });
    const b = await bundleSqlMemory(db, join(dir, "bundles"));
    expect(b.path).toMatch(/bundles\/2026-10-26T15-31-00Z\.bundle$/);
    expect(b.head).toBe(await repo.head());
    expect(await verifyBundle(b.path)).toBe(b.head);

    await repo.commit({ changes: [{ path: "workstreams/a.md", text: "1. changed\n" }], message: "note: a again", date: "2026-10-26T15:32:00.000Z" });
    expect(await repo.read("workstreams/a.md")).toBe("1. changed\n");

    const out = await restoreSqlMemory(b.path, db, { keepDir: join(dir, "replaced") });
    expect(out.head).toBe(b.head);
    repo.clearCache();
    expect(await repo.head()).toBe(b.head);
    expect(await repo.read("workstreams/a.md")).toBe("1. first\n");
    expect(await repo.list()).toEqual(["README.md", "knowledge/.keep.md", "workstreams/a.md"]);
    expect(out.replaced && existsSync(out.replaced)).toBe(true);
    // The replaced history is a bundle too: restoring it brings the change back.
    await restoreSqlMemory(out.replaced!, db);
    repo.clearCache();
    expect(await repo.read("workstreams/a.md")).toBe("1. changed\n");
  });

  it("refuses a corrupt bundle and leaves the repo alone", { timeout: 60_000 }, async () => {
    const { db, repo, dir } = await repoDb();
    await repo.init([{ path: "README.md", text: "# memory\n" }], { message: "memory: initialise", date: "2026-10-26T15:30:00.000Z" });
    const b = await bundleSqlMemory(db, join(dir, "bundles"));
    const bytes = readFileSync(b.path);
    writeFileSync(b.path, bytes.subarray(0, Math.floor(bytes.length / 2)));
    await expect(restoreSqlMemory(b.path, db)).rejects.toMatchObject({ code: "BUNDLE_INVALID" });
    expect(await repo.head()).toBe(b.head);
  });

  it("refuses to bundle a database without a memory repo", async () => {
    const { db, dir } = await repoDb();
    await expect(bundleSqlMemory(db, join(dir, "bundles"))).rejects.toMatchObject({ code: "NOT_A_REPO" });
  });
});
