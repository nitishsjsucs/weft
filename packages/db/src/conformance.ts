// The transaction conformance cases (docs/cloudflare/design.md 11.3), written once and run three times: on the
// node:sqlite emulator (packages/db/test/conformance.test.ts), inside workerd through Miniflare
// (test-workerd/conformance.workerd.test.ts, `pnpm --filter @weft/db test:workerd`), and on a deployed Durable Object
// through runConformance below (CompanyDO's scratch `conformance` object, design 9.2 step 5). Each case returns a JSON
// observation and every runner compares it with the same `expect` value, so the emulator stays pinned to the real
// runtime.
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { DurableStorageLike } from "../../contracts/src/ext/cf-db";
import { openDurableDb } from "./durable";
import { createTxGuard } from "./tx-guard";

export interface CaseHost {
  readonly storage: DurableStorageLike;
  /** A timer: from outside an open transaction's context it fires only once the input gate opens. */
  sleep(ms: number): Promise<void>;
  /** Delivers a second event to this object (it waits for the input gate) and returns what SUBS[name] returned. */
  deliver(name: keyof typeof SUBS): Promise<unknown>;
  readonly platform: "emulator" | "workerd";
}

/** A case's result as both runners see it: what `run` returned, or the message it (or the runtime) failed with. */
export type Outcome = { ok: true; value: unknown } | { ok: false; error: string };

export interface ConformanceCase {
  name: string;
  /** Pinned in design 11.3. */
  covers: string;
  run(h: CaseHost): Promise<unknown>;
  /** Read in a new event after `run`, for cases that reset the object. */
  after?(h: CaseHost): Promise<unknown>;
  expect: Outcome;
  expectAfter?: unknown;
  /** Cases that wait out workerd's 30 s input-gate timeout. */
  slow?: boolean;
}

export const GATE_TIMEOUT_MESSAGE = "A call to blockConcurrencyWhile() in a Durable Object waited for too long. The call was canceled and the Durable Object was reset.";

export function messageOf(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  // workerd adds " at offset N" to errors it can place; the emulator cannot. No case pins an offset.
  return m.replace(/ at offset \d+(?=: SQLITE_)/, "");
}

const micro = () => Promise.resolve();
const setup = (h: CaseHost, ddl = "CREATE TABLE IF NOT EXISTS t (v TEXT)") => h.storage.sql.exec(ddl);
const ins = (h: CaseHost, v: string) => { h.storage.sql.exec("INSERT INTO t (v) VALUES (?)", v); };
const rows = (h: CaseHost) => h.storage.sql.exec("SELECT v FROM t ORDER BY rowid").toArray().map((r) => r.v);
const failure = async (p: Promise<unknown>) => { try { await p; return "no error"; } catch (e) { return messageOf(e); } };
const syncFailure = (fn: () => unknown) => { try { fn(); return "no error"; } catch (e) { return messageOf(e); } };

const kv = sqliteTable("kv", { k: text("k").primaryKey(), v: text("v").notNull(), n: integer("n") });
const facade = (h: CaseHost) => {
  h.storage.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL, n INTEGER)");
  return openDurableDb(h.storage);
};
const kvRows = async (db: ReturnType<typeof facade>["db"]) => (await db.select().from(kv).orderBy(kv.k)).map((r) => `${r.k}=${r.v}`);

/** Second-event bodies (`deliver`). */
export const SUBS = {
  async interleaveProbe(h: CaseHost) {
    const seen = rows(h);
    ins(h, "probe");
    return { seen };
  },
};

export const CASES: ConformanceCase[] = [
  // ---- closure-form transactions on the raw storage ----------------------------------------------------------
  {
    name: "raw rollback after microtask and timer awaits",
    covers: "rollback after microtask and timer awaits",
    async run(h) {
      setup(h);
      const err = await failure(h.storage.transaction(async () => { ins(h, "a"); await micro(); ins(h, "b"); await h.sleep(5); ins(h, "c"); throw new Error("boom"); }));
      return { err, rows: rows(h) };
    },
    expect: { ok: true, value: { err: "boom", rows: [] } },
  },
  {
    name: "raw nested rollback is inner only",
    covers: "inner-only nested rollback",
    async run(h) {
      setup(h);
      let inner = "";
      await h.storage.transaction(async () => {
        ins(h, "a");
        inner = await failure(h.storage.transaction(async () => { ins(h, "b"); await h.sleep(5); ins(h, "b2"); throw new Error("inner"); }));
        await h.sleep(5);
        ins(h, "c");
      });
      return { inner, rows: rows(h) };
    },
    expect: { ok: true, value: { inner: "inner", rows: ["a", "c"] } },
  },
  {
    name: "raw outer throw rolls back an inner commit",
    covers: "outer throw rolls back an inner commit",
    async run(h) {
      setup(h);
      const err = await failure(h.storage.transaction(async () => {
        ins(h, "a");
        await h.storage.transaction(async () => { await h.sleep(5); ins(h, "b"); });
        await micro();
        throw new Error("outer");
      }));
      return { err, rows: rows(h) };
    },
    expect: { ok: true, value: { err: "outer", rows: [] } },
  },
  {
    name: "raw transactionSync nested in an async transaction",
    covers: "transactionSync nested in an async transaction",
    async run(h) {
      setup(h);
      let sync = "";
      await h.storage.transaction(async () => {
        ins(h, "a");
        await h.sleep(5);
        sync = syncFailure(() => h.storage.transactionSync(() => { ins(h, "b"); throw new Error("sync"); }));
        h.storage.transactionSync(() => ins(h, "c"));
      });
      const kept = rows(h);
      const err = await failure(h.storage.transaction(async () => { h.storage.transactionSync(() => ins(h, "d")); await micro(); throw new Error("outer"); }));
      return { sync, kept, err, rows: rows(h) };
    },
    expect: { ok: true, value: { sync: "sync", kept: ["a", "c"], err: "outer", rows: ["a", "c"] } },
  },
  {
    name: "raw transactionSync nests and rolls back alone",
    covers: "transactionSync nested in an async transaction",
    async run(h) {
      setup(h);
      let inner = "";
      h.storage.transactionSync(() => {
        ins(h, "a");
        inner = syncFailure(() => h.storage.transactionSync(() => { ins(h, "b"); throw new Error("i"); }));
        ins(h, "c");
      });
      const value = h.storage.transactionSync(() => 42);
      return { inner, value, rows: rows(h) };
    },
    expect: { ok: true, value: { inner: "i", value: 42, rows: ["a", "c"] } },
  },
  {
    name: "raw error identity and return values",
    covers: "error identity",
    async run(h) {
      setup(h);
      class Mine extends Error { code = "MINE"; }
      const e1 = new Mine("mine");
      const seen: unknown[] = [];
      try { await h.storage.transaction(async () => { ins(h, "x"); await h.sleep(1); throw e1; }); } catch (e) { seen.push(e === e1, (e as Mine).code, e instanceof Mine); }
      try { h.storage.transactionSync(() => { throw e1; }); } catch (e) { seen.push(e === e1); }
      try { await h.storage.transaction(async () => { await h.storage.transaction(async () => { throw e1; }); }); } catch (e) { seen.push(e === e1); }
      const value = await h.storage.transaction(async () => { await h.sleep(1); return { x: 1 }; });
      return { seen, value, rows: rows(h) };
    },
    expect: { ok: true, value: { seen: [true, "MINE", true, true, true], value: { x: 1 }, rows: [] } },
  },

  // ---- the facade: drizzle callbacks inside storage.transaction ----------------------------------------------
  {
    name: "facade writes after awaits roll back, top level",
    covers: "writes issued from the drizzle callback after awaits roll back on throw, top level",
    async run(h) {
      const { db } = facade(h);
      const err = await failure(db.transaction(async (tx) => {
        await tx.insert(kv).values({ k: "a", v: "1" });
        await micro();
        await tx.insert(kv).values({ k: "b", v: "2" });
        await h.sleep(5);
        await tx.run(sql`UPDATE kv SET v = 'changed' WHERE k = 'a'`);
        await db.insert(kv).values({ k: "c", v: "via the top-level db" });
        throw new Error("top");
      }));
      return { err, rows: await kvRows(db) };
    },
    expect: { ok: true, value: { err: "top", rows: [] } },
  },
  {
    name: "facade writes after awaits roll back, nested",
    covers: "writes issued from the drizzle callback after awaits roll back on throw, nested",
    async run(h) {
      const { db } = facade(h);
      let inner = "";
      await db.transaction(async (tx) => {
        await tx.insert(kv).values({ k: "a", v: "1" });
        inner = await failure(tx.transaction(async (sp) => {
          await sp.insert(kv).values({ k: "b", v: "2" });
          await h.sleep(5);
          await sp.insert(kv).values({ k: "c", v: "3" });
          await micro();
          await sp.transaction(async (sp2) => { await h.sleep(1); await sp2.insert(kv).values({ k: "d", v: "4" }); });
          throw new Error("inner");
        }));
        await h.sleep(5);
        await tx.insert(kv).values({ k: "e", v: "5" });
      });
      const afterInner = await kvRows(db);
      const outer = await failure(db.transaction(async (tx) => {
        await tx.transaction(async (sp) => { await h.sleep(1); await sp.insert(kv).values({ k: "f", v: "6" }); });
        await micro();
        throw new Error("outer");
      }));
      return { inner, afterInner, outer, rows: await kvRows(db) };
    },
    expect: { ok: true, value: { inner: "inner", afterInner: ["a=1", "e=5"], outer: "outer", rows: ["a=1", "e=5"] } },
  },
  {
    name: "facade refuses a linear transaction",
    covers: "facadeClient.transaction() throws UNSUPPORTED_LINEAR_TRANSACTION",
    async run(h) {
      const { db } = facade(h);
      const e = await db.$client.transaction("write").then(() => null, (err: { code?: string; message?: string }) => err);
      return { code: e?.code ?? null, starts: e?.message?.startsWith("UNSUPPORTED_LINEAR_TRANSACTION") ?? false, rows: await kvRows(db) };
    },
    expect: { ok: true, value: { code: "UNSUPPORTED_LINEAR_TRANSACTION", starts: true, rows: [] } },
  },
  {
    name: "facade error identity and SQLite codes",
    covers: "error identity",
    async run(h) {
      const { db } = facade(h);
      h.storage.sql.exec("CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY, v TEXT)");
      h.storage.sql.exec("CREATE TRIGGER IF NOT EXISTS log_no_update BEFORE UPDATE ON log BEGIN SELECT RAISE(ABORT, 'log is append-only'); END");
      const mine = new Error("mine");
      const same = await db.transaction(async () => { await h.sleep(1); throw mine; }).then(() => false, (e) => e === mine);
      const sameNested = await db.transaction(async (tx) => tx.transaction(async () => { throw mine; })).then(() => false, (e) => e === mine);
      await db.insert(kv).values({ k: "a", v: "1" });
      const dup = await db.insert(kv).values({ k: "a", v: "2" }).then(() => null, (e: { cause?: { code?: string; extendedCode?: string; message?: string } }) => e.cause);
      await db.run(sql`INSERT INTO log (v) VALUES ('x')`);
      const trig = await db.run(sql`UPDATE log SET v = 'y'`).then(() => null, (e: { cause?: { code?: string; extendedCode?: string; message?: string } }) => e.cause);
      return {
        same, sameNested,
        dup: { code: dup?.code, extendedCode: dup?.extendedCode, message: dup?.message },
        trig: { code: trig?.code, extendedCode: trig?.extendedCode, message: trig?.message },
      };
    },
    expect: { ok: true, value: {
      same: true, sameNested: true,
      dup: { code: "SQLITE_CONSTRAINT", extendedCode: "SQLITE_CONSTRAINT_PRIMARYKEY", message: "SQLITE_CONSTRAINT: UNIQUE constraint failed: kv.k" },
      trig: { code: "SQLITE_CONSTRAINT", extendedCode: "SQLITE_CONSTRAINT_TRIGGER", message: "SQLITE_CONSTRAINT: log is append-only" },
    } },
  },

  {
    name: "facade result shapes and bindings, as libsql gives them",
    covers: "the facade returns libsql's ResultSet (test/durable.test.ts compares libsql itself)",
    async run(h) {
      const { db } = facade(h);
      const ins = await db.run(sql`INSERT INTO kv (k, v, n) VALUES ('a', '1', 7)`);
      const cas = await db.run(sql`UPDATE kv SET v = '2' WHERE k = 'a' AND v = '1'`);
      const miss = await db.run(sql`UPDATE kv SET v = '3' WHERE k = 'a' AND v = '1'`);
      const sel = await db.run(sql`SELECT k, v, 1 AS k FROM kv`);
      const returning = await db.insert(kv).values({ k: "b", v: "x", n: 2 }).returning();
      const batch = await db.batch([db.insert(kv).values({ k: "c", v: "y" }), db.select().from(kv)]);
      const bound = await db.all(sql`SELECT ${true} AS t, ${false} AS f, typeof(${3}) AS ty, ${3} || '' AS s, ${new Date(0)} AS d, ${5n} AS b, hex(${new Uint8Array([1, 2])}) AS hx, typeof(x'0a') AS bt`);
      const dup = await db.run(sql`INSERT INTO kv (k, v) VALUES ('a', 'dup')`).then(() => null, (e: { cause?: { code?: string; extendedCode?: string; message?: string } }) => e.cause);
      const missing = await db.run(sql`SELECT * FROM nope`).then(() => null, (e: { cause?: { code?: string; message?: string } }) => e.cause);
      return {
        ins: { rowsAffected: ins.rowsAffected, lastInsertRowid: String(ins.lastInsertRowid), columns: ins.columns },
        cas: cas.rowsAffected, miss: miss.rowsAffected,
        sel: { rowsAffected: sel.rowsAffected, lastInsertRowid: sel.lastInsertRowid ?? null, columns: sel.columns, row: { ...sel.rows[0] }, length: sel.rows[0]!.length, indexed: Array.prototype.slice.call(sel.rows[0]) },
        returning, batch: batch.map((x) => (Array.isArray(x) ? x.length : (x as { rowsAffected: number }).rowsAffected)), bound,
        dup: { code: dup?.code, extendedCode: dup?.extendedCode, message: dup?.message },
        missing: { code: missing?.code, message: missing?.message },
      };
    },
    expect: { ok: true, value: {
      ins: { rowsAffected: 1, lastInsertRowid: "1", columns: [] },
      cas: 1, miss: 0,
      sel: { rowsAffected: 0, lastInsertRowid: null, columns: ["k", "v", "k"], row: { k: "a", v: "2" }, length: 3, indexed: ["a", "2", 1] },
      returning: [{ k: "b", v: "x", n: 2 }],
      batch: [1, 3],
      bound: [{ t: 1, f: 0, ty: "real", s: "3.0", d: 0, b: 5, hx: "0102", bt: "blob" }],
      dup: { code: "SQLITE_CONSTRAINT", extendedCode: "SQLITE_CONSTRAINT_PRIMARYKEY", message: "SQLITE_CONSTRAINT: UNIQUE constraint failed: kv.k" },
      missing: { code: "SQLITE_ERROR", message: "SQLITE_ERROR: no such table: nope" },
    } },
  },

  // ---- negative shapes: unreachable through the facade, pinned here --------------------------------------------
  {
    name: "raw linear begin and commit hangs and resets",
    covers: "a raw linear begin/commit is kept as a negative test (hang and reset)",
    slow: true,
    async run(h) {
      setup(h);
      // libsql's linear shape: begin opens a transaction whose closure waits on a promise created outside it;
      // statements are issued from the caller; commit resolves the promise. A timer between two statements is
      // gated by the held input gate, so commit is never reached.
      let commit!: () => void;
      const done = new Promise<void>((r) => { commit = r; });
      const finished = h.storage.transaction(() => done);
      finished.catch(() => undefined);
      ins(h, "l1");
      await h.sleep(5);
      ins(h, "l2");
      commit();
      await finished;
      return { rows: rows(h) };
    },
    after: async (h) => ({ rows: rows(h) }),
    expect: { ok: false, error: GATE_TIMEOUT_MESSAGE },
    // The caller's first write ran before the closure started (workerd starts it on a later turn), so it was never
    // part of the transaction and survives the reset.
    expectAfter: { rows: ["l1"] },
  },
  {
    name: "raw deferred rollback keeps the caller's writes, top level",
    covers: "a deferred promise awaited inside ctx.storage.transaction leaves writes from the caller's async context in place after a reported rollback",
    async run(h) {
      setup(h);
      let rollback!: (e: Error) => void;
      const done = new Promise<never>((_, r) => { rollback = r; });
      done.catch(() => undefined);
      const finished = h.storage.transaction(async () => { ins(h, "inside"); await done; });
      await micro();
      ins(h, "from-caller");
      rollback(new Error("rollback"));
      const err = await failure(finished);
      return { err, rows: rows(h) };
    },
    expect: { ok: true, value: { err: "rollback", rows: ["from-caller"] } },
  },
  {
    name: "raw deferred rollback keeps the caller's writes, nested",
    covers: "the same, nested",
    async run(h) {
      setup(h);
      let err = "";
      await h.storage.transaction(async () => {
        ins(h, "a");
        let rollback!: (e: Error) => void;
        const done = new Promise<never>((_, r) => { rollback = r; });
        done.catch(() => undefined);
        const finished = h.storage.transaction(async () => { ins(h, "inside"); await done; });
        await micro();
        ins(h, "from-caller");
        rollback(new Error("rollback"));
        err = await failure(finished);
        ins(h, "c");
      });
      return { err, rows: rows(h) };
    },
    expect: { ok: true, value: { err: "rollback", rows: ["a", "from-caller", "c"] } },
  },

  // ---- gating, counters, triggers, PRAGMAs, limits ---------------------------------------------------------------
  {
    name: "a second event waits for the open transaction",
    covers: "interleave gating",
    async run(h) {
      setup(h);
      const tx = h.storage.transaction(async () => { ins(h, "tx-start"); await h.sleep(60); ins(h, "tx-end"); });
      const probe = h.deliver("interleaveProbe");
      await tx;
      const seen = await probe;
      return { seen, rows: rows(h) };
    },
    expect: { ok: true, value: { seen: { seen: ["tx-start", "tx-end"] }, rows: ["tx-start", "tx-end", "probe"] } },
  },
  {
    name: "rowsAffected from changes(), never from rowsWritten",
    covers: "changes() against rowsWritten",
    async run(h) {
      const s = h.storage.sql;
      s.exec("CREATE TABLE p (id TEXT PRIMARY KEY, status TEXT NOT NULL, seq INTEGER, note TEXT)");
      s.exec("CREATE INDEX p_status ON p (status)");
      const ins3 = s.exec("INSERT INTO p (id, status, seq, note) VALUES ('p1', 'pending', NULL, 'n'), ('p2', 'pending', NULL, 'n'), ('p3', 'done', 1, 'n')");
      ins3.toArray();
      const cas = s.exec("UPDATE p SET status = 'approved' WHERE id = 'p1' AND status = 'pending'");
      cas.toArray();
      const casChanges = s.exec("SELECT changes() AS c").one().c;
      const plain = s.exec("UPDATE p SET note = 'm' WHERE id = 'p2'");
      plain.toArray();
      const none = s.exec("UPDATE p SET status = 'approved' WHERE id = 'p1' AND status = 'pending'");
      none.toArray();
      const upsert = s.exec("INSERT INTO p (id, status, seq, note) VALUES ('p2', 'pending', NULL, 'x') ON CONFLICT(id) DO UPDATE SET note = excluded.note");
      upsert.toArray();
      const del = s.exec("DELETE FROM p WHERE id = 'p3'");
      del.toArray();
      const { db } = openDurableDb(h.storage);
      const res = await db.run(sql`UPDATE p SET status = 'executed', seq = 7 WHERE id = 'p1' AND status = 'approved' AND seq IS NULL`);
      const again = await db.run(sql`UPDATE p SET status = 'executed', seq = 8 WHERE id = 'p1' AND status = 'approved' AND seq IS NULL`);
      const insert = await db.run(sql`INSERT INTO p (id, status) VALUES ('p9', 'pending')`);
      return {
        rowsWritten: { insert3: ins3.rowsWritten, cas: cas.rowsWritten, plain: plain.rowsWritten, none: none.rowsWritten, upsert: upsert.rowsWritten, del: del.rowsWritten },
        casChanges,
        facade: { cas: res.rowsAffected, again: again.rowsAffected, insert: insert.rowsAffected, rowid: String(insert.lastInsertRowid) },
      };
    },
    expect: { ok: true, value: {
      rowsWritten: { insert3: 9, cas: 2, plain: 1, none: 0, upsert: 1, del: 1 },
      casChanges: 1,
      facade: { cas: 1, again: 0, insert: 1, rowid: "3" },
    } },
  },
  {
    name: "append-only triggers, dirty-key triggers and the trigger dance in transactionSync",
    covers: "triggers; the trigger dance in transactionSync",
    async run(h) {
      const s = h.storage.sql;
      s.exec("CREATE TABLE log (id INTEGER PRIMARY KEY, v TEXT)");
      s.exec("CREATE TRIGGER log_no_update BEFORE UPDATE ON log BEGIN SELECT RAISE(ABORT, 'log is append-only'); END");
      s.exec("CREATE TRIGGER log_no_delete BEFORE DELETE ON log BEGIN SELECT RAISE(ABORT, 'log is append-only'); END");
      s.exec("CREATE TABLE st (k TEXT PRIMARY KEY, v TEXT)");
      s.exec("CREATE TABLE dirty (tbl TEXT NOT NULL, pk TEXT NOT NULL, PRIMARY KEY (tbl, pk))");
      s.exec("CREATE TRIGGER st_dirty_ins AFTER INSERT ON st BEGIN INSERT INTO dirty (tbl, pk) SELECT 'st', NEW.k WHERE NOT EXISTS (SELECT 1 FROM dirty WHERE tbl = 'st' AND pk = NEW.k); END");
      s.exec("CREATE TRIGGER st_dirty_upd AFTER UPDATE ON st BEGIN INSERT INTO dirty (tbl, pk) SELECT 'st', OLD.k WHERE NOT EXISTS (SELECT 1 FROM dirty WHERE tbl = 'st' AND pk = OLD.k); END");
      s.exec("INSERT INTO log (v) VALUES ('a'), ('b')");
      const upd = syncFailure(() => s.exec("UPDATE log SET v = 'z'"));
      const delr = syncFailure(() => s.exec("DELETE FROM log WHERE id = 1"));
      const first = s.exec("INSERT INTO st (k, v) VALUES ('x', '1') ON CONFLICT(k) DO UPDATE SET v = excluded.v");
      first.toArray();
      s.exec("INSERT INTO st (k, v) VALUES ('x', '2') ON CONFLICT(k) DO UPDATE SET v = excluded.v");
      // INSERT OR IGNORE in a trigger body under an outer UPSERT: the outer conflict policy wins and it fails.
      s.exec("CREATE TABLE dirty2 (tbl TEXT NOT NULL, pk TEXT NOT NULL, PRIMARY KEY (tbl, pk))");
      s.exec("CREATE TRIGGER st_dirty2 AFTER UPDATE ON st BEGIN INSERT OR IGNORE INTO dirty2 (tbl, pk) VALUES ('st', OLD.k); END");
      s.exec("INSERT INTO dirty2 (tbl, pk) VALUES ('st', 'x')");
      const orIgnore = syncFailure(() => s.exec("INSERT INTO st (k, v) VALUES ('x', '3') ON CONFLICT(k) DO UPDATE SET v = excluded.v"));
      const dirty = s.exec("SELECT tbl, pk FROM dirty ORDER BY pk").toArray();
      // The delta reset's dance: drop the append-only trigger, delete log rows past the seed, recreate it.
      h.storage.transactionSync(() => {
        s.exec("DROP TRIGGER log_no_delete");
        s.exec("DELETE FROM log WHERE id > 1");
        s.exec("CREATE TRIGGER log_no_delete BEFORE DELETE ON log BEGIN SELECT RAISE(ABORT, 'log is append-only'); END");
      });
      const delAgain = syncFailure(() => s.exec("DELETE FROM log"));
      const drop = s.exec("DROP TABLE dirty");
      drop.toArray();
      return {
        upd, delr, firstRowsWritten: first.rowsWritten, orIgnore, dirty,
        log: s.exec("SELECT id, v FROM log ORDER BY id").toArray(), delAgain,
        // DROP TABLE's rowsWritten is a billing count, not a behavior: Miniflare's workerd reports 0 and the deployed
        // runtime 2 (measured 2026-10-23 on weft.nitish-ratakonda.workers.dev). The delta reset's DROP TABLE wipes cost
        // that much more in production; nothing depends on the exact value.
        dropRowsWrittenAtMost2: drop.rowsWritten <= 2,
      };
    },
    expect: { ok: true, value: {
      upd: "log is append-only: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)",
      delr: "log is append-only: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)",
      firstRowsWritten: 4,
      orIgnore: "UNIQUE constraint failed: dirty2.tbl, dirty2.pk: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)",
      dirty: [{ tbl: "st", pk: "x" }],
      log: [{ id: 1, v: "a" }],
      delAgain: "log is append-only: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)",
      dropRowsWrittenAtMost2: true,
    } },
  },
  {
    name: "PRAGMAs: workerd's refusals, the facade's filter and deferred foreign keys",
    covers: "PRAGMAs",
    async run(h) {
      const s = h.storage.sql;
      const q = (text: string) => { try { return s.exec(text).toArray(); } catch (e) { return messageOf(e); } };
      s.exec("CREATE TABLE par (id TEXT PRIMARY KEY)");
      s.exec("CREATE TABLE chi (id TEXT PRIMARY KEY, pid TEXT REFERENCES par(id))");
      const refused = { journal_mode: q("PRAGMA journal_mode=WAL"), busy_timeout: q("PRAGMA busy_timeout=5000"), user_version: q("PRAGMA user_version"), integrity_check: q("PRAGMA integrity_check") };
      const allowed = { foreign_keys: q("PRAGMA foreign_keys"), table_info: (q("PRAGMA table_info(chi)") as unknown[]).length, fk_list: (q("PRAGMA foreign_key_list(chi)") as unknown[]).length, fk_check: q("PRAGMA foreign_key_check") };
      const immediate = syncFailure(() => s.exec("INSERT INTO chi VALUES ('c1', 'p1')"));
      const deferred = syncFailure(() => h.storage.transactionSync(() => { s.exec("PRAGMA defer_foreign_keys = ON"); s.exec("INSERT INTO chi VALUES ('c2', 'p2')"); s.exec("INSERT INTO par VALUES ('p2')"); }));
      const offTop = (() => { s.exec("PRAGMA foreign_keys = OFF"); const v = s.exec("PRAGMA foreign_keys").one(); s.exec("PRAGMA foreign_keys = ON"); return v; })();
      const offInTx = h.storage.transactionSync(() => { s.exec("PRAGMA foreign_keys = OFF"); return s.exec("PRAGMA foreign_keys").one(); });
      const { db } = openDurableDb(h.storage);
      const multi = await failure(db.$client.executeMultiple("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;"));
      return { refused, allowed, immediate, deferred, offTop, offInTx, multi, chi: s.exec("SELECT id FROM chi").toArray() };
    },
    expect: { ok: true, value: {
      refused: { journal_mode: "not authorized: SQLITE_AUTH", busy_timeout: "not authorized: SQLITE_AUTH", user_version: "not authorized: SQLITE_AUTH", integrity_check: "not authorized: SQLITE_AUTH" },
      allowed: { foreign_keys: [{ foreign_keys: 1 }], table_info: 2, fk_list: 1, fk_check: [] },
      immediate: "FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)",
      deferred: "no error",
      // The earlier writes opened workerd's implicit transaction, inside which the PRAGMA is a no-op.
      offTop: { foreign_keys: 1 },
      offInTx: { foreign_keys: 1 },
      multi: "no error",
      chi: [{ id: "c2" }],
    } },
  },
  {
    name: "more than 100 parameters: refused raw, inlined by the facade with the same stored values",
    covers: "more than 100 parameters",
    async run(h) {
      const s = h.storage.sql;
      const cols = Array.from({ length: 51 }, (_, i) => `c${i}`);
      s.exec(`CREATE TABLE wide (id INTEGER PRIMARY KEY, ${cols.map((c) => `${c} TEXT`).join(", ")}, n INTEGER, r REAL, b BLOB)`);
      const raw = syncFailure(() => s.exec(`SELECT ${Array.from({ length: 101 }, () => "?").join(", ")}`, ...Array.from({ length: 101 }, (_, i) => i)));
      const { db } = openDurableDb(h.storage);
      const vals = (row: number) => [row, ...cols.map((_, i) => (i % 3 === 0 ? i : i % 3 === 1 ? `it's ${i}` : null)), 42, 1.5, new Uint8Array([1, 2, 3])];
      const insertRows = async (from: number, count: number) => {
        const ph = `(${["?", ...cols.map(() => "?"), "?", "?", "?"].join(", ")})`;
        const args = Array.from({ length: count }, (_, i) => vals(from + i)).flat();
        return db.$client.execute({ sql: `INSERT INTO wide (id, ${cols.join(", ")}, n, r, b) VALUES ${Array.from({ length: count }, () => ph).join(", ")}`, args });
      };
      const one = await insertRows(1, 1);   // 55 parameters: bound
      const two = await insertRows(2, 2);   // 110 parameters: inlined
      const typed = s.exec(`SELECT id, typeof(c0) AS t0, c0, c1, typeof(c2) AS t2, n, typeof(n) AS tn, r, hex(b) AS b FROM wide ORDER BY id`).toArray();
      return { raw, affected: [one.rowsAffected, two.rowsAffected], typed };
    },
    expect: { ok: true, value: {
      raw: "too many SQL variables: SQLITE_ERROR",
      affected: [1, 2],
      typed: [
        { id: 1, t0: "text", c0: "0.0", c1: "it's 1", t2: "null", n: 42, tn: "integer", r: 1.5, b: "010203" },
        { id: 2, t0: "text", c0: "0.0", c1: "it's 1", t2: "null", n: 42, tn: "integer", r: 1.5, b: "010203" },
        { id: 3, t0: "text", c0: "0.0", c1: "it's 1", t2: "null", n: 42, tn: "integer", r: 1.5, b: "010203" },
      ],
    } },
  },
  {
    name: "the 2 MB guard, statement and column limits, bindings and transaction statements",
    covers: "the 2 MB guard; limits",
    async run(h) {
      const s = h.storage.sql;
      s.exec("CREATE TABLE big (v TEXT)");
      const { db } = openDurableDb(h.storage);
      const tooBig = await db.run(sql`INSERT INTO big (v) VALUES (${"x".repeat(2 * 1024 * 1024 + 1)})`).then(() => null, (e: { cause?: { code?: string } }) => e.cause?.code ?? "no code");
      const fits = await db.run(sql`INSERT INTO big (v) VALUES (${"x".repeat(2 * 1024 * 1024 - 64)})`).then((r) => r.rowsAffected);
      const longStmt = syncFailure(() => s.exec(`SELECT '${"y".repeat(100_000)}' AS v`));
      const okStmt = syncFailure(() => s.exec(`SELECT '${"y".repeat(99_000)}' AS v`));
      const wideTable = syncFailure(() => s.exec(`CREATE TABLE w (${Array.from({ length: 101 }, (_, i) => `c${i} INT`).join(", ")})`));
      const wideTableGone = s.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'w'").one().n;
      const wideSelect = syncFailure(() => s.exec(`SELECT ${Array.from({ length: 101 }, (_, i) => `${i} AS c${i}`).join(", ")}`));
      const multiBind = syncFailure(() => s.exec("INSERT INTO big VALUES (?); INSERT INTO big VALUES (?)", "a", "b"));
      const multiLast = s.exec("INSERT INTO big VALUES ('m1'); SELECT count(*) AS n FROM big WHERE v = ?", "m1").toArray();
      const wrongCount = syncFailure(() => s.exec("INSERT INTO big VALUES (?)"));
      const begin = syncFailure(() => s.exec("BEGIN"));
      const savepoint = syncFailure(() => s.exec("SAVEPOINT sp1"));
      const empty = syncFailure(() => s.exec("  -- only a comment"));
      const bound = s.exec("SELECT ? AS b, ? AS n, ? AS u, typeof(?) AS i", true, NaN, undefined, 3).one();
      const bigint = syncFailure(() => s.exec("SELECT ? AS v", 5n));
      const viaFacade = (await db.all<{ b: number; i: string; d: number }>(sql`SELECT ${true} AS b, typeof(${3}) AS i, ${5n} AS d`))[0];
      const one = syncFailure(() => s.exec("SELECT 1 AS a WHERE 0").one());
      const many = syncFailure(() => s.exec("SELECT 1 AS a UNION ALL SELECT 2").one());
      const dqs = s.exec('SELECT "not a column" AS v').one();
      return { tooBig, fits, longStmt, okStmt, wideTable, wideTableGone, wideSelect, multiBind, multiLast, wrongCount, begin: begin.slice(0, 60), savepoint: savepoint.slice(0, 60), empty, bound, bigint, viaFacade, one, many, dqs };
    },
    expect: { ok: true, value: {
      tooBig: "SQL_VALUE_TOO_LARGE", fits: 1,
      longStmt: "statement too long: SQLITE_TOOBIG", okStmt: "no error",
      wideTable: "too many columns on w: SQLITE_ERROR", wideTableGone: 0,
      wideSelect: "too many columns in result set: SQLITE_ERROR",
      multiBind: "When executing multiple SQL statements in a single call, only the last statement can have parameters.",
      multiLast: [{ n: 1 }],
      wrongCount: "Wrong number of parameter bindings for SQL query.",
      begin: "To execute a transaction, please use the state.storage.trans",
      savepoint: "To execute a transaction, please use the state.storage.trans",
      empty: "SQL code did not contain a statement.",
      bound: { b: "true", n: null, u: null, i: "real" },
      bigint: "Cannot convert a BigInt value to a number",
      viaFacade: { b: 1, i: "real", d: 5 },
      one: "Expected exactly one result from SQL query, but got no results.",
      many: "Expected exactly one result from SQL query, but got multiple results.",
      dqs: { v: "not a column" },
    } },
  },
  {
    name: "IO_IN_TX inside a transaction only",
    covers: "IO_IN_TX",
    async run(h) {
      setup(h);
      const guard = createTxGuard();
      const { db } = openDurableDb(h.storage, { guard });
      const outside = syncFailure(() => guard.assertNotInTx("fetch"));
      let inside = "";
      let nested = "";
      let elsewhere = "";
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const other = (async () => { await gate; elsewhere = syncFailure(() => guard.assertNotInTx("queue send")); })();
      await db.transaction(async (tx) => {
        await h.sleep(1);
        inside = syncFailure(() => guard.assertNotInTx("fetch"));
        await tx.transaction(async () => { nested = syncFailure(() => guard.assertNotInTx("RPC")); });
        release();
        await micro();
      });
      await other;
      const after = syncFailure(() => guard.assertNotInTx("fetch"));
      return { outside, inside: inside.slice(0, 41), nested: nested.slice(0, 39), elsewhere, after, inTxAfter: guard.inTx() };
    },
    expect: { ok: true, value: { outside: "no error", inside: "IO_IN_TX: fetch inside a database transac", nested: "IO_IN_TX: RPC inside a database transac", elsewhere: "no error", after: "no error", inTxAfter: false } },
  },
  {
    name: "deleteAll wipes the database and is refused inside a transaction",
    covers: "full restore uses deleteAll()",
    async run(h) {
      const s = h.storage.sql;
      s.exec("CREATE TABLE a1 (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)");
      s.exec("CREATE INDEX a1_v ON a1 (v)");
      s.exec("INSERT INTO a1 (v) VALUES ('x')");
      const inTx = await failure(h.storage.transaction(async () => { await h.storage.deleteAll(); }));
      await h.storage.deleteAll();
      const left = s.exec("SELECT name FROM sqlite_master").toArray();
      s.exec("CREATE TABLE a1 (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)");
      s.exec("INSERT INTO a1 (v) VALUES ('y')");
      return { inTx, left, ids: s.exec("SELECT id FROM a1").toArray() };
    },
    expect: { ok: true, value: { inTx: "Cannot call deleteAll() within a transaction", left: [], ids: [{ id: 1 }] } },
  },
];

// ---- the deployed run ------------------------------------------------------------------------------------------------

/** Key order does not matter and undefined properties are dropped, as in the vitest runners' toEqual. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, canonical(o[k])]));
  }
  return v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export interface ConformanceRunOptions {
  /** Delivers SUBS[name] as a second event to this object (CompanyDO: an RPC to itself, queued behind the input gate). */
  deliver?(name: keyof typeof SUBS): Promise<unknown>;
  sleep?(ms: number): Promise<void>;
  /** The slow cases wait out the 30 s input-gate timeout and reset the object; off by default on a deployed object. */
  includeSlow?: boolean;
}
export interface ConformanceCaseResult { name: string; ok: boolean; skipped?: boolean; detail?: string }

/** Names only the fields that differ (top level, then inside `value`), so a long result never hides the difference. */
function mismatch(expected: unknown, got: unknown): string {
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const diffs: string[] = [];
  const walk = (e: unknown, g: unknown, at: string) => {
    if (obj(e) && obj(g)) {
      for (const k of new Set([...Object.keys(e), ...Object.keys(g)])) walk(e[k], g[k], at ? `${at}.${k}` : k);
      return;
    }
    if (JSON.stringify(e) !== JSON.stringify(g)) diffs.push(`${at || "result"}: expected ${JSON.stringify(e)?.slice(0, 300)}, got ${JSON.stringify(g)?.slice(0, 300)}`);
  };
  walk(expected, got, "");
  return diffs.join("; ").slice(0, 1500) || `expected ${JSON.stringify(expected).slice(0, 400)}, got ${JSON.stringify(got).slice(0, 400)}`;
}
export interface ConformanceRun { passed: number; failed: number; skipped: number; cases: ConformanceCaseResult[] }

/**
 * Runs the design 11.3 cases one after another on a live Durable Object's storage, wiping it with deleteAll() before
 * each case and after the last (every case expects an empty database). A case that needs a second event is skipped
 * without `deliver`; the slow cases are skipped unless `includeSlow`, since they reset the object they run on.
 */
export async function runConformance(storage: DurableStorageLike, opts: ConformanceRunOptions = {}): Promise<ConformanceRun> {
  const out: ConformanceRun = { passed: 0, failed: 0, skipped: 0, cases: [] };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let delivered = false;
  const host: CaseHost = {
    storage, platform: "workerd", sleep,
    deliver: async (name) => {
      delivered = true;
      if (!opts.deliver) throw new Error("NO_DELIVER: this run has no second-event channel");
      return opts.deliver(name);
    },
  };
  for (const c of CASES) {
    if (c.slow && !opts.includeSlow) {
      out.skipped++;
      out.cases.push({ name: c.name, ok: true, skipped: true, detail: "waits out the 30 s input-gate timeout and resets the object; covered in Miniflare and on the emulator" });
      continue;
    }
    await storage.deleteAll();
    delivered = false;
    let got: Outcome;
    try { got = { ok: true, value: await c.run(host) }; } catch (e) { got = { ok: false, error: messageOf(e) }; }
    if (delivered && !opts.deliver) {
      out.skipped++;
      out.cases.push({ name: c.name, ok: true, skipped: true, detail: "needs a second event and this run has none" });
      continue;
    }
    let ok = same(got, c.expect);
    let detail = ok ? undefined : mismatch(c.expect, got);
    if (ok && c.after) {
      let after: Outcome;
      try { after = { ok: true, value: await c.after(host) }; } catch (e) { after = { ok: false, error: messageOf(e) }; }
      ok = same(after, { ok: true, value: c.expectAfter });
      if (!ok) detail = `after: expected ${JSON.stringify(c.expectAfter).slice(0, 400)}, got ${JSON.stringify(after).slice(0, 400)}`;
    }
    if (ok) out.passed++; else out.failed++;
    out.cases.push({ name: c.name, ok, ...(detail ? { detail } : {}) });
  }
  await storage.deleteAll();
  return out;
}

/** Runs one second-event body (SUBS[name]) on this storage: what a deployed object answers to its own `deliver` RPC. */
export async function runConformanceSub(storage: DurableStorageLike, name: string): Promise<unknown> {
  if (!Object.hasOwn(SUBS, name)) throw new Error(`no conformance sub ${name.slice(0, 40)}`);
  const host: CaseHost = { storage, platform: "workerd", sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)), deliver: () => Promise.reject(new Error("a sub delivers nothing")) };
  return SUBS[name as keyof typeof SUBS](host);
}
