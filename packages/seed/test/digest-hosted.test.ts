// The world digest and the hosted tables (migration 0008_hosted.sql; docs/cloudflare/tracks.md cf0-contracts): empty
// hosted tables leave the digest exactly as before they existed, so the base digest and every pinned eval digest are
// unchanged; once they hold rows they count (BLOBs as hex); hosted runtime state, the SQL memory repo (git memory
// never counted either) and workerd's tables never count.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closeDb, migrate, openDb, type Db } from "@weft/db";
import { commands, createSimClock } from "@weft/core";
import { createExecutor } from "@weft/executor";
import { createSimulators } from "@weft/sim";
import { DIRTY_TABLE, HOSTED_TABLES } from "../../contracts/src/ext/cf-db";
import { digestDb, dumpDb, SEED_CLOCK, seedWorld } from "../src/index";

/** The base world's digest (README, docs/tracks/rich-seed.md): what tests, e2e and the eval worlds build on. */
const BASE_DIGEST = "dca6930b3d5e040b2955776aa01b86ac38128370cbba20ab894183e5b499c6c4";

describe("the base world digest", () => {
  it("is unchanged with the hosted tables migrated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weft-digest-base-"));
    const db = openDb({ dataDir: dir });
    try {
      await migrate(db);
      const tables = (await db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`)).map((t) => t.name);
      for (const t of HOSTED_TABLES) expect(tables).toContain(t);
      const clock = await createSimClock({ db, initial: { at: SEED_CLOCK, rate: 0 } });
      const executor = await createExecutor({ db, clock, dataDir: dir, commands, simulators: createSimulators, testMode: true });
      try {
        await seedWorld({ db, clock, executor, sims: createSimulators({ db, clock }), dataDir: dir });
      } finally { await executor.close(); }
      const dump = await dumpDb(db);
      for (const t of HOSTED_TABLES) expect(dump).not.toHaveProperty(t);
      expect(await digestDb(db)).toBe(BASE_DIGEST);
    } finally { await closeDb(db); rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});

describe("hosted tables in the dump", () => {
  let dir: string;
  let db: Db;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "weft-digest-hosted-"));
    db = openDb({ dataDir: dir });
    await migrate(db);
  });
  afterAll(async () => { await closeDb(db); rmSync(dir, { recursive: true, force: true }); });

  it("leave the dump alone while empty and count once they hold a row, BLOBs as hex", async () => {
    const empty = await digestDb(db);
    expect(Object.keys(await dumpDb(db)).filter((t) => (HOSTED_TABLES as readonly string[]).includes(t))).toEqual([]);
    await db.run(sql`INSERT INTO blobs (key, idx, bytes) VALUES ('blob:ab', 0, ${Buffer.from([0, 1, 254, 255])})`);
    await db.run(sql`INSERT INTO run_files (path, body) VALUES ('companies/cmp_x/runs/run_0001/artifacts/1-a.json', '{}')`);
    const dump = await dumpDb(db);
    expect(dump.blobs).toEqual([{ key: "blob:ab", idx: 0, bytes: { $blob: "0001feff" } }]);
    expect(dump.run_files).toEqual([{ path: "companies/cmp_x/runs/run_0001/artifacts/1-a.json", body: "{}" }]);
    expect(await digestDb(db)).not.toBe(empty);
    await db.run(sql`DELETE FROM blobs`);
    await db.run(sql`DELETE FROM run_files`);
    expect(await digestDb(db)).toBe(empty);
  });

  it("never count kv_state, run handle tokens, the SQL memory repo or the dirty-key table", async () => {
    const empty = await digestDb(db);
    await db.run(sql`INSERT INTO kv_state (key, value) VALUES ('world.id', 'slot-1:gen-7')`);
    await db.run(sql`INSERT INTO mem_objects (sha, type, body) VALUES ('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', 'blob', ${Buffer.from([])})`);
    await db.run(sql`INSERT INTO mem_refs (name, sha) VALUES ('refs/heads/main', 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')`);
    const memory = await dumpDb(db);
    for (const t of ["mem_objects", "mem_refs", "mem_log"]) expect(memory).not.toHaveProperty(t);
    await db.run(sql`DELETE FROM mem_objects`);
    await db.run(sql`DELETE FROM mem_refs`);
    await db.run(sql.raw(`CREATE TABLE "${DIRTY_TABLE}" (tbl TEXT NOT NULL, pk TEXT NOT NULL)`));
    await db.run(sql.raw(`INSERT INTO "${DIRTY_TABLE}" (tbl, pk) VALUES ('workers', 'wrk_0001')`));
    expect(await digestDb(db)).toBe(empty);
    await db.run(sql`INSERT INTO run_handles (run_id, token, nonce) VALUES ('run_0001', 'secret-a', 'n1')`);
    const one = await dumpDb(db);
    expect(one.run_handles).toEqual([{ run_id: "run_0001" }]);
    const withA = await digestDb(db);
    await db.run(sql`UPDATE run_handles SET token = 'secret-b', nonce = 'n2'`);
    expect(await digestDb(db)).toBe(withA);
    await db.run(sql`DELETE FROM run_handles`);
    await db.run(sql`DELETE FROM kv_state`);
    await db.run(sql.raw(`DROP TABLE "${DIRTY_TABLE}"`));
  });

  // The node:sqlite emulator (WEFT_DB=durable-emu) refuses CREATE TABLE "_cf_*" with SQLITE_AUTH exactly as workerd
  // does (verified in Miniflare by cf1-db), so there is no stand-in table to create; the libsql run pins the rule.
  it.skipIf(process.env.WEFT_DB === "durable-emu")("skip workerd's reserved _cf_ tables, which refuse every read there", async () => {
    const before = await digestDb(db);
    await db.run(sql.raw(`CREATE TABLE "_cf_KV" (key TEXT PRIMARY KEY, value BLOB)`));
    await db.run(sql.raw(`INSERT INTO "_cf_KV" (key, value) VALUES ('k', x'00')`));
    expect(await dumpDb(db)).not.toHaveProperty("_cf_KV");
    expect(await digestDb(db)).toBe(before);
    await db.run(sql.raw(`DROP TABLE "_cf_KV"`));
  });
});
