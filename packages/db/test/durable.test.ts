// The durable facade beside libsql (docs/cloudflare/design.md 4.2): the same result shapes and errors for the same
// statements, the same __drizzle_migrations rows, the meter's rows, tables, spans and commit versions, WorldScope and
// the per-world write lock, the SQL text helpers, and openDb under WEFT_DB=durable-emu. Owner: cf1-db.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { NODE_WORLD } from "../../contracts/src/ext/cf-db";
import { closeDb, currentTransaction, emulatorOf, openDb, withWriteLock, type Db } from "../src/client";
import { durableHandleOf, libsqlArg, openDurableDb, sqlLiteral } from "../src/durable";
import { DurableEmulator } from "../src/emu";
import { createSqlMeter } from "../src/meter";
import { migrate } from "../src/migrate";
import { keyedWithReset, worldScope } from "../src/scope";
import { parameterCount, splitStatements, statementKind, tablesOf, targetTable } from "../src/sqltext";
import { createTxGuard } from "../src/tx-guard";
import { kvState, outbox } from "../src/schema";

const dirs: string[] = [];
const dbs: Db[] = [];
afterAll(async () => { for (const db of dbs) await closeDb(db); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function libsqlDb(): Db { const d = mkdtempSync(join(tmpdir(), "weft-libsql-")); dirs.push(d); const db = openDb({ dataDir: d }); dbs.push(db); return db; }
function durable() { const emu = new DurableEmulator(); const h = openDurableDb(emu); return { ...h, emu }; }

/** The statements both drivers run, and what each returned (rows as drizzle sees them, plus run results). */
async function exercise(db: Db): Promise<unknown[]> {
  const out: unknown[] = [];
  await migrate(db);
  out.push(await db.all(sql`SELECT hash, created_at, id FROM __drizzle_migrations ORDER BY created_at`));
  const r1 = await db.run(sql`INSERT INTO kv_state (key, value) VALUES ('a', '1')`);
  out.push({ rowsAffected: r1.rowsAffected, lastInsertRowid: String(r1.lastInsertRowid), columns: r1.columns, rows: r1.rows.length });
  const r2 = await db.run(sql`UPDATE kv_state SET value = '2' WHERE key = 'a' AND value = '1'`);
  const r3 = await db.run(sql`UPDATE kv_state SET value = '3' WHERE key = 'a' AND value = '1'`);
  out.push([r2.rowsAffected, r3.rowsAffected]);
  const sel = await db.run(sql`SELECT key, value, 1 AS key FROM kv_state`);
  out.push({ rowsAffected: sel.rowsAffected, lastInsertRowid: sel.lastInsertRowid ?? null, columns: sel.columns, row: { ...sel.rows[0] }, length: sel.rows[0]!.length, indexed: Array.prototype.slice.call(sel.rows[0]) });
  await db.insert(outbox).values([{ id: "o1", kind: "ocr", body: "{}", createdAt: "2026-10-26T15:30:00Z" }, { id: "o2", kind: "pdf", body: "{}", createdAt: "2026-10-26T15:31:00Z" }]);
  out.push(await db.select().from(outbox).orderBy(outbox.id));
  out.push(await db.insert(kvState).values({ key: "b", value: "x" }).returning());
  out.push(await db.query.kvState.findMany({ orderBy: (t, { asc }) => [asc(t.key)] }));
  out.push(await db.batch([db.insert(kvState).values({ key: "c", value: "y" }), db.select().from(kvState)]).then((r) => r.map((x) => (Array.isArray(x) ? x.length : (x as { rowsAffected: number }).rowsAffected))));
  out.push(await db.all(sql`SELECT ${true} AS t, ${false} AS f, typeof(${3}) AS ty, ${3} || '' AS s, ${new Date(0)} AS d, ${5n} AS b, hex(${new Uint8Array([1, 2])}) AS h`));
  out.push(await db.all(sql`SELECT x'0a0b' AS blob`).then((r) => r.map((x) => Object.prototype.toString.call((x as { blob: unknown }).blob))));
  const errs: unknown[] = [];
  for (const q of [sql`INSERT INTO kv_state (key, value) VALUES ('a', 'dup')`, sql`SELEC 1`, sql`SELECT * FROM nope`, sql`INSERT INTO kv_state (key) VALUES ('z')`]) {
    const e = await db.run(q).then(() => null, (err: { message: string; cause?: { code?: string; extendedCode?: string; message?: string } }) => ({ code: err.cause?.code, extendedCode: err.cause?.extendedCode, message: err.cause?.message }));
    errs.push(e);
  }
  out.push(errs);
  out.push(await db.run(sql`INSERT INTO kv_state (key, value) VALUES (${undefined as unknown as string}, 'u')`).then(() => "ok", (e: { cause?: Error; message: string }) => (e.cause ?? e).message));
  // Transactions: commit, inner rollback, outer rollback.
  await db.transaction(async (tx) => {
    await tx.insert(kvState).values({ key: "t1", value: "1" });
    await tx.transaction(async (sp) => { await sp.insert(kvState).values({ key: "t2", value: "2" }); throw new Error("inner"); }).catch(() => undefined);
    await tx.insert(kvState).values({ key: "t3", value: "3" });
  });
  await db.transaction(async (tx) => { await tx.insert(kvState).values({ key: "t4", value: "4" }); throw new Error("outer"); }).catch(() => undefined);
  out.push(await db.all(sql`SELECT key FROM kv_state ORDER BY key`));
  return out;
}

describe("the facade gives libsql's answers", () => {
  it("for results, errors, migrations and transactions", { timeout: 60_000 }, async () => {
    const lib = await exercise(libsqlDb());
    const { db, emu } = durable();
    const dur = await exercise(db);
    expect(dur).toEqual(lib);
    emu.close();
  });

  it("refuses a linear transaction and values over 2 MB; inlines more than 100 parameters", async () => {
    const { db, emu } = durable();
    await migrate(db);
    await expect(db.$client.transaction("write")).rejects.toMatchObject({ code: "UNSUPPORTED_LINEAR_TRANSACTION" });
    const big = await db.run(sql`INSERT INTO kv_state (key, value) VALUES ('big', ${"x".repeat(2 * 1024 * 1024 + 1)})`).then(() => null, (e: { cause?: { code?: string } }) => e.cause?.code);
    expect(big).toBe("SQL_VALUE_TOO_LARGE");
    const keys = Array.from({ length: 60 }, (_, i) => `k${i}`);
    const r = await db.run(sql`INSERT INTO kv_state (key, value) VALUES ${sql.join(keys.map((k) => sql`(${k}, ${`it's ${k}`})`), sql`, `)}`);
    expect(r.rowsAffected).toBe(60);
    expect(await db.all(sql`SELECT value FROM kv_state WHERE key = 'k59'`)).toEqual([{ value: "it's k59" }]);
    expect(libsqlArg(true)).toBe(1);
    expect(libsqlArg(new Date(5))).toBe(5);
    expect(() => libsqlArg(undefined)).toThrow(/undefined/);
    expect(() => libsqlArg(Number.NaN)).toThrow(/finite/);
    expect(() => libsqlArg(2n ** 60n)).toThrow(/range/);
    expect([sqlLiteral(3), sqlLiteral(1.5), sqlLiteral(-0), sqlLiteral(null), sqlLiteral("a'b"), sqlLiteral(new Uint8Array([255, 1])), sqlLiteral("nul\u0000")]).toEqual(["3.0", "1.5", "-0.0", "NULL", "'a''b'", "X'ff01'", "CAST(X'6e756c00' AS TEXT)"]);
    emu.close();
  });

  it("executeMultiple drops the PRAGMAs workerd refuses and passes foreign_keys", async () => {
    const { db, emu } = durable();
    await db.$client.executeMultiple("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=OFF;");
    expect(emu.sql.exec("PRAGMA foreign_keys").one().foreign_keys).toBe(0);
    await db.$client.executeMultiple("PRAGMA foreign_keys=ON");
    expect(emu.sql.exec("PRAGMA foreign_keys").one().foreign_keys).toBe(1);
    emu.close();
  });
});

describe("the meter", () => {
  it("counts rows and tables per statement and per span, and bumps versions once per commit", async () => {
    const meter = createSqlMeter();
    const emu = new DurableEmulator();
    const { db } = openDurableDb(emu, { meter });
    await migrate(db);
    meter.reset();
    const commits: { seq: number; tables: string[] }[] = [];
    const off = meter.onCommit((c) => commits.push(c));
    const { usage } = await meter.measure(async () => {
      await db.insert(kvState).values({ key: "a", value: "1" });
      const inner = await meter.measure(() => db.select().from(kvState));
      expect(inner.usage).toMatchObject({ statements: 1, tablesRead: ["kv_state"], tablesWritten: [] });
      await db.transaction(async (tx) => {
        await tx.insert(outbox).values({ id: "o1", kind: "ocr", body: "{}", createdAt: "x" });
        await tx.update(kvState).set({ value: "2" }).where(sql`key = 'a'`);
      });
      await db.transaction(async (tx) => { await tx.insert(outbox).values({ id: "o2", kind: "ocr", body: "{}", createdAt: "x" }); throw new Error("no"); }).catch(() => undefined);
      await db.run(sql`UPDATE kv_state SET value = 'x' WHERE key = 'nope'`);
    });
    expect(usage.statements).toBe(6);
    expect(usage.tablesWritten).toEqual(["kv_state", "outbox"]);
    expect(usage.rowsWritten).toBeGreaterThanOrEqual(4);
    // One autocommit insert, one committed transaction; the rolled-back one and the no-op update bump nothing.
    expect(commits).toEqual([{ seq: 1, tables: ["kv_state"] }, { seq: 2, tables: ["kv_state", "outbox"] }]);
    expect(meter.versions(["kv_state", "outbox", "workers"])).toEqual({ kv_state: 2, outbox: 1, workers: 0 });
    expect(meter.totals().statements).toBe(6);
    off();
    await db.insert(kvState).values({ key: "b", value: "1" });
    expect(commits).toHaveLength(2);
    expect(meter.version("kv_state")).toBe(3);
    emu.close();
  });

  it("names tables from drizzle's quoted identifiers and bare names", () => {
    const known = new Set(["workers", "payrolls", "kv_state", "proposals"]);
    expect(tablesOf(`select "id" from "workers" left join "payrolls" on "payrolls"."worker_id" = "workers"."id"`, known)).toEqual({ read: ["payrolls", "workers"], written: [] });
    expect(tablesOf(`UPDATE proposals SET status = 'executed' WHERE id = ? AND status = 'approved'`, known)).toEqual({ read: [], written: ["proposals"] });
    expect(tablesOf(`insert into "kv_state" ("key") select "id" from "workers"`, known)).toEqual({ read: ["workers"], written: ["kv_state"] });
    expect(tablesOf(`delete from "kv_state" where "key" in (select "key" from "kv_state")`, known)).toEqual({ read: ["kv_state"], written: ["kv_state"] });
    expect(targetTable(`WITH x AS (SELECT 1) INSERT INTO "workers" SELECT * FROM x`)).toBe("workers");
    expect(targetTable(`CREATE UNIQUE INDEX IF NOT EXISTS "w_i" ON "workers" ("id")`)).toBe("w_i");
    expect(statementKind("  -- c\n  PRAGMA foreign_keys")).toBe("pragma");
    expect(statementKind("WITH a AS (SELECT 1) SELECT * FROM a")).toBe("read");
  });
});

describe("SQL text", () => {
  it("splits scripts and keeps trigger bodies whole", () => {
    expect(splitStatements("SELECT 1; -- a; b\nSELECT 'x;y'; CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT CASE WHEN 1 THEN 2 END; INSERT INTO b VALUES (1); END; /* ; */ ;")).toEqual([
      "SELECT 1", "-- a; b\nSELECT 'x;y'", "CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT CASE WHEN 1 THEN 2 END; INSERT INTO b VALUES (1); END",
    ]);
    expect(parameterCount("SELECT ?, ?, '?', :a, :a, \"?\"")).toBe(3);
  });
});

describe("WorldScope and the write lock", () => {
  it("keys values by world and defaults to Node's one world", async () => {
    expect(worldScope.current()).toBe(NODE_WORLD);
    const counter = worldScope.keyed(() => ({ n: 0 }));
    counter().n++;
    await worldScope.run("slot-1", async () => { counter().n += 10; await Promise.resolve(); expect(worldScope.current()).toBe("slot-1"); });
    await worldScope.run("slot-2", async () => { counter().n += 100; });
    expect(counter().n).toBe(1);
    expect(worldScope.run("slot-1", () => counter().n)).toBe(10);
    const k = keyedWithReset((w) => ({ w }));
    expect(worldScope.run("slot-3", () => k.get().w)).toBe("slot-3");
    k.drop("slot-3");
    expect(() => worldScope.run("", () => 1)).toThrow();
  });

  it("serializes writes within a world, never across worlds, and stays re-entrant", async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const a = worldScope.run("w-a", () => withWriteLock(async () => { order.push("a1"); await held; order.push("a2"); }));
    const a2 = worldScope.run("w-a", () => withWriteLock(async () => { order.push("a-second"); }));
    const b = worldScope.run("w-b", () => withWriteLock(async () => { order.push("b"); await withWriteLock(async () => { order.push("b-nested"); }); }));
    await b;
    expect(order).toEqual(["a1", "b", "b-nested"]);
    release();
    await a; await a2;
    expect(order).toEqual(["a1", "b", "b-nested", "a2", "a-second"]);
  });
});

describe("the IO_IN_TX guard", () => {
  it("is on for the whole outer transaction only", async () => {
    const guard = createTxGuard();
    expect(guard.inTx()).toBe(false);
    await guard.within(async () => {
      expect(guard.inTx()).toBe(true);
      expect(() => guard.assertNotInTx("an R2 put")).toThrow(/IO_IN_TX: an R2 put/);
      await guard.within(async () => expect(guard.inTx()).toBe(true));
    });
    expect(guard.inTx()).toBe(false);
  });
});

describe("openDb under WEFT_DB=durable-emu", () => {
  it("runs on the emulator, migrates the same and keeps libsql's transaction tracking off", async () => {
    const prev = process.env.WEFT_DB;
    process.env.WEFT_DB = "durable-emu";
    const d = mkdtempSync(join(tmpdir(), "weft-emu-open-"));
    dirs.push(d);
    try {
      const db = openDb({ dataDir: d });
      expect(emulatorOf(db)).not.toBeNull();
      expect(durableHandleOf(db)).not.toBeNull();
      await migrate(db);
      await migrate(db);
      expect((await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM __drizzle_migrations`))[0]!.n).toBe(9);
      await db.transaction(async () => { expect(currentTransaction(db)).toBeNull(); });
      await closeDb(db);
      // The file is a SQLite database libsql opens too.
      delete process.env.WEFT_DB;
      const lib = openDb({ dataDir: d });
      expect((await lib.all<{ n: number }>(sql`SELECT count(*) AS n FROM __drizzle_migrations`))[0]!.n).toBe(9);
      await lib.transaction(async (tx) => { expect(currentTransaction(lib)).toBe(tx); });
      expect(currentTransaction(lib)).toBeNull();
      await closeDb(lib);
    } finally {
      if (prev === undefined) delete process.env.WEFT_DB; else process.env.WEFT_DB = prev;
    }
  });
});
