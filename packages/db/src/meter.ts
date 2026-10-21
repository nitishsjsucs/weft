// The facade meter (docs/cloudflare/design.md 4.2 and 4.5): rows read and written and the tables each statement read
// and wrote, per measured span (one per request on CompanyDO) and in total, plus one version per table that each
// commit writing it bumps. The versions feed the ETag/304 middleware and the WebSocket feed; the totals feed the
// clean-slot check and the Lobby's daily counters. Versions live in memory, so they start again after a restart and
// the first poll after one computes normally.
import { AsyncLocalStorage } from "node:async_hooks";
import type { SqlCommit, SqlMeter, SqlUsage } from "../../contracts/src/ext/cf-db";

export interface StatementUsage {
  rowsRead: number;
  rowsWritten: number;
  tablesRead: readonly string[];
  tablesWritten: readonly string[];
}

class Span {
  statements = 0;
  rowsRead = 0;
  rowsWritten = 0;
  readonly read = new Set<string>();
  readonly written = new Set<string>();
  add(s: StatementUsage): void {
    this.statements++;
    this.rowsRead += s.rowsRead;
    this.rowsWritten += s.rowsWritten;
    for (const t of s.tablesRead) this.read.add(t);
    for (const t of s.tablesWritten) this.written.add(t);
  }
  usage(): SqlUsage {
    return { statements: this.statements, rowsRead: this.rowsRead, rowsWritten: this.rowsWritten, tablesRead: [...this.read].sort(), tablesWritten: [...this.written].sort() };
  }
}

export interface SqlMeterControl extends SqlMeter {
  /** Records one executed statement against the total and every span open in the current async context. */
  record(s: StatementUsage): void;
  /** Records a commit (an outer transaction, or an autocommit write) that wrote `tables`. */
  commit(tables: Iterable<string>): void;
}

export function createSqlMeter(): SqlMeterControl {
  const spans = new AsyncLocalStorage<readonly Span[]>();
  let total = new Span();
  const versions = new Map<string, number>();
  const listeners = new Set<(c: SqlCommit) => void>();
  let seq = 0;
  return {
    async measure<T>(fn: () => Promise<T>) {
      const span = new Span();
      // Awaited inside the span's context: a drizzle query builder is a thenable that runs only when awaited.
      const value = await spans.run([...(spans.getStore() ?? []), span], async () => await fn());
      return { value, usage: span.usage() };
    },
    totals: () => total.usage(),
    reset() { total = new Span(); },
    version: (table) => versions.get(table) ?? 0,
    versions(tables) {
      const out: Record<string, number> = {};
      for (const t of tables) out[t] = versions.get(t) ?? 0;
      return out;
    },
    onCommit(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    record(s) {
      total.add(s);
      for (const span of spans.getStore() ?? []) span.add(s);
    },
    commit(tables) {
      const list = [...new Set(tables)].sort();
      if (list.length === 0) return;
      for (const t of list) versions.set(t, (versions.get(t) ?? 0) + 1);
      const c: SqlCommit = { seq: ++seq, tables: list };
      for (const l of [...listeners]) {
        try { l(c); } catch { /* a listener never fails a commit */ }
      }
    },
  };
}
