// A small SqlStorageLike over node:sqlite for the unit suite: exec returns a cursor with toArray, one and the row
// counts, and transactionSync nests with savepoints the way workerd's does (an inner throw rolls back the inner part).
import { DatabaseSync } from "node:sqlite";
import type { SqlCursorLike, SqlRow, SqlStorageLike } from "../../src/shared/contracts";

export function memorySql(): { sql: SqlStorageLike; transactionSync<T>(fn: () => T): T; db: DatabaseSync } {
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
