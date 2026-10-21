// Snapshots and resets (docs/cloudflare/design.md 4.6) on the emulator, over Weft's real schema: chunks under 90 KB
// restore every table to the manifest digests (rowids, sqlite_sequence and the append-only triggers included); the
// dirty-key triggers record what a session touches; a delta reset puts it back in one transactionSync and checks the
// digests; a mismatch rolls the reset back. Owner: cf1-db.
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { DIRTY_TABLE } from "../../contracts/src/ext/cf-db";
import { DurableEmulator } from "../src/emu";
import { openDurableDb } from "../src/durable";
import { migrate, migrationsDir } from "../src/migrate";
import { journalHash, readMigrationsFromDir } from "../src/migrations";
import {
  armDirtyTracking, buildSnapshot, decodeSnapshot, deltaReset, dirtyKeys, encodeSnapshot, MAX_CHUNK_BYTES, restoreChunks, restoreSnapshot, snapshotTables,
  verifyAgainstManifest, beginRestore, finishRestore, type Snapshot,
} from "../src/snapshot";

const migrations = readMigrationsFromDir(migrationsDir());
const JH = journalHash(migrations);

/** Inserts one row, filling every NOT NULL column without a default from its type unless `values` names it. */
async function fill(db: ReturnType<typeof openDurableDb>["db"], table: string, values: Record<string, string | number | Uint8Array | null>): Promise<void> {
  const cols = await db.all<{ name: string; notnull: number; type: string; dflt_value: unknown; pk: number }>(sql.raw(`PRAGMA table_info("${table}")`));
  const row: Record<string, unknown> = {};
  for (const c of cols) {
    if (c.name in values) row[c.name] = values[c.name];
    else if (c.notnull && c.dflt_value === null && !(c.pk && /^INTEGER$/i.test(c.type))) row[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : `${c.name}-x`;
  }
  const names = Object.keys(row);
  await db.run(sql`INSERT INTO ${sql.identifier(table)} (${sql.join(names.map((n) => sql.identifier(n)), sql`, `)}) VALUES (${sql.join(names.map((n) => sql`${row[n]}`), sql`, `)})`);
}

/** A small world on the real schema: a company and its workers (a foreign key), an append-only log, an AUTOINCREMENT
 * table with a deleted last row, a table without a primary key, and a blob too large to inline. */
async function sourceWorld(): Promise<{ emu: DurableEmulator; snap: Snapshot }> {
  const emu = new DurableEmulator();
  const { db } = openDurableDb(emu);
  await migrate(db);
  await fill(db, "companies", { id: "cmp_larkspur" });
  for (let i = 1; i <= 12; i++) await fill(db, "workers", { id: `wrk_${String(i).padStart(4, "0")}`, company_id: "cmp_larkspur" });
  for (let i = 1; i <= 40; i++) {
    await db.run(sql`INSERT INTO kv_state (key, value) VALUES (${`k${i}`}, ${`v${i}`.repeat(i)})`);
    await db.run(sql`INSERT INTO outbox (id, kind, body, created_at) VALUES (${`obx_${i}`}, 'ocr', ${JSON.stringify({ i, text: "x".repeat(3000) })}, '2026-10-26T15:30:00Z')`);
  }
  for (let i = 1; i <= 3; i++) await fill(db, "exec_calls", { run_id: "run_1", call_id: `c${i}` });
  await db.run(sql`INSERT INTO blobs (key, idx, bytes) VALUES ('big', 0, ${new Uint8Array(200_000).map((_, i) => i % 251)})`);
  await db.run(sql`INSERT INTO mem_objects (sha, type, body) VALUES (${"a".repeat(40)}, 'blob', ${new Uint8Array([1, 2, 3])})`);
  for (let seq = 1; seq <= 5; seq++) await fill(db, "actions", { seq, action_id: `act_${seq}` });
  for (let i = 1; i <= 4; i++) await fill(db, "run_steps", { run_id: "run_1", n: i });
  await db.run(sql`DELETE FROM run_steps WHERE rowid = (SELECT max(rowid) FROM run_steps)`);
  await new Promise((r) => setImmediate(r));
  const snap = buildSnapshot(emu, { journalHash: JH, extra: { note: "test" } });
  return { emu, snap };
}

describe("snapshot", () => {
  it("chunks stay under 90 KB, bind only rows too large to inline, and list parents first", async () => {
    const { snap, emu } = await sourceWorld();
    for (const c of snap.chunks) {
      if (c.args) expect(c.rows).toBe(1);
      else expect(new TextEncoder().encode(c.sql).byteLength).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    }
    expect(snap.chunks.some((c) => c.args && c.table === "blobs")).toBe(true);
    const order = snap.manifest.tables.map((t) => t.name);
    expect(order.indexOf("companies")).toBeLessThan(order.indexOf("workers"));
    expect(snap.manifest.sequences.run_steps).toBe(4);
    expect(snap.manifest.tables.find((t) => t.name === "exec_calls")!.key).toEqual(["rowid"]);
    expect(snap.manifest.extra).toEqual({ note: "test" });
    expect(snapshotTables(emu).map((t) => t.name)).not.toContain("__drizzle_migrations");
    emu.close();
  });

  it("a full restore reproduces every table, sqlite_sequence and the triggers", async () => {
    const { snap, emu: src } = await sourceWorld();
    src.close();
    const emu = new DurableEmulator();
    emu.sql.exec("CREATE TABLE leftover (x)");
    const out = await restoreSnapshot(emu, snap, migrations, JH);
    expect(out.digest).toBe(snap.manifest.digest);
    expect(out.rowsWritten).toBeGreaterThan(snap.manifest.rows);
    expect(emu.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'leftover'").one().n).toBe(0);
    expect(emu.sql.exec("SELECT seq FROM sqlite_sequence WHERE name = 'run_steps'").one().seq).toBe(4);
    expect(() => emu.sql.exec("UPDATE actions SET seq = seq")).toThrow(/append-only/);
    expect(verifyAgainstManifest(emu, snap.manifest).mismatched).toEqual([]);
    // The migrations table matches a plain migration.
    const fresh = new DurableEmulator();
    await migrate(openDurableDb(fresh).db);
    expect(emu.sql.exec("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at").toArray()).toEqual(fresh.sql.exec("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at").toArray());
    fresh.close();
    emu.close();
  });

  it("restores in steps, as the Workflow does, and refuses other migrations", async () => {
    const { snap, emu: src } = await sourceWorld();
    src.close();
    const emu = new DurableEmulator();
    await emu.deleteAll();
    expect(() => beginRestore(emu, snap, migrations, "0".repeat(64))).toThrow(/journal hash/);
    const begin = beginRestore(emu, snap, migrations, JH);
    const half = Math.ceil(snap.chunks.length / 2);
    restoreChunks(emu, snap.chunks, 0, half);
    await new Promise((r) => setImmediate(r));
    restoreChunks(emu, snap.chunks, half);
    const done = finishRestore(emu, snap, begin.triggers);
    expect(done.digest).toBe(snap.manifest.digest);
    emu.close();
  });

  it("round-trips through the file encoding", async () => {
    const { snap, emu } = await sourceWorld();
    emu.close();
    const files = await encodeSnapshot(snap);
    const back = await decodeSnapshot(files);
    expect(back.manifest).toEqual(JSON.parse(JSON.stringify(snap.manifest)));
    expect(back.chunks.length).toBe(snap.chunks.length);
    const target = new DurableEmulator();
    expect((await restoreSnapshot(target, back, migrations, JH)).digest).toBe(snap.manifest.digest);
    target.close();
  });
});

describe("delta reset", () => {
  async function restored(): Promise<{ emu: DurableEmulator; snap: Snapshot }> {
    const { snap, emu: src } = await sourceWorld();
    src.close();
    const emu = new DurableEmulator();
    await restoreSnapshot(emu, snap, migrations, JH);
    return { emu, snap };
  }

  it("records touched keys once and puts the session back, twice", async () => {
    const { emu, snap } = await restored();
    const { db } = openDurableDb(emu);
    for (let round = 0; round < 2; round++) {
      await db.transaction(async (tx) => {
        await tx.run(sql`INSERT INTO kv_state (key, value) VALUES ('new', 'x') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
        await tx.run(sql`UPDATE kv_state SET value = 'changed' WHERE key = 'k3'`);
        await tx.run(sql`UPDATE kv_state SET value = 'changed again' WHERE key = 'k3'`);
        await tx.run(sql`DELETE FROM outbox WHERE id = 'obx_7'`);
        await tx.run(sql`UPDATE kv_state SET key = 'k4-renamed' WHERE key = 'k4'`);
      });
      await fill(db, "actions", { seq: 6, action_id: "act_6" });
      await fill(db, "run_steps", { run_id: "run_2", n: 9 });
      await db.run(sql`DELETE FROM exec_calls WHERE call_id = 'c2'`);
      await new Promise((r) => setImmediate(r));
      const keys = dirtyKeys(emu);
      expect([...keys.keys()].sort()).toEqual(["actions", "exec_calls", "kv_state", "outbox", "run_steps"]);
      expect(keys.get("kv_state")!.sort()).toEqual(['["k3"]', '["k4"]', '["k4-renamed"]', '["new"]']);
      const out = deltaReset(emu, snap);
      expect(out.tables).toEqual(["actions", "exec_calls", "kv_state", "outbox", "run_steps"]);
      // kv_state k3, k4, k4-renamed and new; outbox obx_7; actions 6; one run step; exec_calls c2.
      expect(out.keys).toBe(8);
      // Rows present to delete: k3, k4-renamed, new, action 6 and the run step (k4, obx_7 and c2 were already gone).
      expect(out.deleted).toBe(5);
      // Seed rows to put back: k3, k4, obx_7 and c2.
      expect(out.reinserted).toBe(4);
      expect(verifyAgainstManifest(emu, snap.manifest).mismatched).toEqual([]);
      expect(emu.sql.exec(`SELECT count(*) AS n FROM ${DIRTY_TABLE}`).one().n).toBe(0);
      expect(emu.sql.exec("SELECT seq FROM sqlite_sequence WHERE name = 'run_steps'").one().seq).toBe(4);
      expect(() => emu.sql.exec("DELETE FROM actions")).toThrow(/append-only/);
    }
    // Tracking is idempotent to arm again.
    armDirtyTracking(emu, snap.manifest.tables);
    emu.close();
  });

  it("throws and rolls back when the reset would not reach the manifest", async () => {
    const { emu, snap } = await restored();
    emu.sql.exec("UPDATE kv_state SET value = 'touched' WHERE key = 'k1'");
    // A row changed behind the triggers' back: drop them, change it, re-arm.
    for (const t of emu.sql.exec("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '_weft_dirty_kv_state%'").toArray()) emu.sql.exec(`DROP TRIGGER "${t.name}"`);
    emu.sql.exec("UPDATE kv_state SET value = 'untracked' WHERE key = 'k2'");
    armDirtyTracking(emu, snap.manifest.tables);
    await new Promise((r) => setImmediate(r));
    expect(() => deltaReset(emu, snap)).toThrow(/kv_state do not match the manifest/);
    // Nothing moved: k1 is still touched and still dirty.
    expect(emu.sql.exec("SELECT value FROM kv_state WHERE key = 'k1'").one().value).toBe("touched");
    expect(dirtyKeys(emu).get("kv_state")).toEqual(['["k1"]']);
    emu.close();
  });
});
