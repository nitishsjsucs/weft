// A small SqlStorageLike over node:sqlite for the unit suite: exec returns a cursor with toArray, one and the row
// counts, and transactionSync nests with savepoints the way workerd's does (an inner throw rolls back the inner part).
import { DatabaseSync } from "node:sqlite";
import type { SqlCursorLike, SqlRow, SqlStorageLike } from "../../src/shared/contracts";

export type MemorySql = { sql: SqlStorageLike; transactionSync<T>(fn: () => T): T; db: DatabaseSync };

export function memorySql(): MemorySql {
  const db = new DatabaseSync(":memory:");
  let depth = 0;
  const sql: SqlStorageLike = {
    exec<T extends SqlRow>(query: string, ...bindings: unknown[]): SqlCursorLike<T> {
      const stmt = db.prepare(query);
      const reader = /^\s*(select|with|pragma)|\breturning\b/i.test(query);
      const rows = (reader ? stmt.all(...(bindings as never[])) : (stmt.run(...(bindings as never[])), [])) as T[];
      const written = reader ? 0 : Number((db.prepare("SELECT changes() AS n").get() as { n: number }).n);
      let i = 0;
      return {
        [Symbol.iterator]() { return rows[Symbol.iterator](); },
        next: () => (i < rows.length ? { value: rows[i++]!, done: false } : { value: undefined, done: true }),
        toArray: () => rows,
        one: () => { if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`); return rows[0]!; },
        raw: () => rows.map((r) => Object.values(r)) as never,
        columnNames: rows[0] ? Object.keys(rows[0]) : [],
        rowsRead: rows.length,
        rowsWritten: written,
      };
    },
    get databaseSize() { return 0; },
  };
  return {
    db,
    sql,
    transactionSync<T>(fn: () => T): T {
      const name = `sp${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const out = fn();
        db.exec(`RELEASE ${name}`);
        return out;
      } catch (e) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw e;
      } finally {
        depth -= 1;
      }
    },
  };
}

/**
 * Rows read, as workerd bills them, cannot be asked of node:sqlite, so each statement here is charged by its query
 * plan: a scan of a table (through an index or not) costs the table's rows, an index search costs the rows it returns
 * (index rows and the correlated subqueries' lookups are left out, as they are bounded by what the search returns).
 * Statements that write read nothing here. Enough to tell a read that grows with the table from one that does not.
 * `tables` collects every table a read touched, and `searches` every index search, so a test can show a path never
 * reads a table, or reads one only through the indexes it should.
 */
export function readMeter(s: MemorySql) {
  const meter = { rows: 0, statements: 0, tables: new Set<string>(), searches: [] as string[] };
  const exec = s.sql.exec.bind(s.sql);
  s.sql.exec = ((query: string, ...b: unknown[]) => {
    const cur = exec(query, ...b);
    if (/^\s*(select|with)/i.test(query)) {
      meter.statements += 1;
      const plan = s.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...(b as never[])) as { detail: string }[];
      let scanned = 0;
      for (const p of plan) {
        const m = /^SCAN (\w+)\b/.exec(p.detail);
        if (m) scanned += Number((s.db.prepare(`SELECT COUNT(*) AS n FROM ${m[1]}`).get() as { n: number }).n);
        const t = /^(?:SCAN|SEARCH) (\w+)\b/.exec(p.detail);
        if (t) meter.tables.add(t[1]!);
        if (/^SEARCH /.test(p.detail)) meter.searches.push(p.detail);
      }
      meter.rows += scanned || cur.toArray().length;
    }
    return cur;
  }) as typeof s.sql.exec;
  return meter;
}
