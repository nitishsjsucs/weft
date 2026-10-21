// A node:sqlite stand-in for the part of a SQLite Durable Object's ctx.storage the SQL spend store uses (sql.exec and
// transactionSync, cf-db.ts DurableStorageLike), with a statement log so tests can count what a call read.
import { DatabaseSync } from "node:sqlite";
import type { SqlCursorLike, SqlRow } from "../../../contracts/src/ext/cf-db";
import type { SqlSpendStorage } from "../../src/spend-sql";

export interface TestStorage extends SqlSpendStorage {
  readonly db: DatabaseSync;
  /** Every statement run, in order. */
  readonly log: string[];
  /** Rows returned by SELECT statements (what a scan would at least read). */
  rowsReturned: number;
  close(): void;
}

export function sqliteStorage(db: DatabaseSync = new DatabaseSync(":memory:")): TestStorage {
  let depth = 0;
  const log: string[] = [];
  const s: TestStorage = {
    db,
    log,
    rowsReturned: 0,
    sql: {
      exec<T extends SqlRow = SqlRow>(query: string, ...bindings: unknown[]): SqlCursorLike<T> {
        log.push(query.replace(/\s+/g, " ").trim());
        const stmt = db.prepare(query);
        const isRead = /^\s*select/i.test(query);
        const rows = (isRead ? stmt.all(...(bindings as never[])) : (stmt.run(...(bindings as never[])), [])) as unknown as T[];
        if (isRead) s.rowsReturned += rows.length;
        let i = 0;
        const cursor = {
          next: () => (i < rows.length ? { value: rows[i++]!, done: false as const } : { value: undefined, done: true as const }),
          toArray: () => rows.slice(i),
          one: () => { if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`); return rows[0]!; },
          raw: () => rows.map((r) => Object.values(r)).values() as never,
          columnNames: rows[0] ? Object.keys(rows[0]) : [],
          rowsRead: rows.length,
          rowsWritten: 0,
          [Symbol.iterator]: () => rows.values(),
        };
        return cursor as unknown as SqlCursorLike<T>;
      },
      get databaseSize() { return 0; },
    },
    transactionSync<T>(fn: () => T): T {
      const name = `sp${depth}`;
      db.exec(depth === 0 ? "BEGIN" : `SAVEPOINT ${name}`);
      depth++;
      try {
        const v = fn();
        depth--;
        db.exec(depth === 0 ? "COMMIT" : `RELEASE ${name}`);
        return v;
      } catch (e) {
        depth--;
        db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${name}`);
        throw e;
      }
    },
    close() { db.close(); },
  };
  return s;
}
