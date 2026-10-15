// Copy of packages/agent/src/busy.ts (routines does not depend on @weft/agent). Run-store writes go through the process write lock and retry SQLITE_BUSY. The libsql client pools connections and
// the open-time PRAGMAs (busy_timeout among them) reach only the first one, so a write on a fresh pooled connection
// can meet SQLITE_BUSY at once while another connection commits. A run-store write must never fail a run for that.
import { withWriteLock } from "@weft/db";

const BUSY = /SQLITE_BUSY|database is locked/i;

export function isBusy(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
    const err = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if ((typeof err.code === "string" && BUSY.test(err.code)) || (typeof err.message === "string" && BUSY.test(err.message))) return true;
    cur = err.cause;
  }
  return false;
}

/** withWriteLock plus up to ~5 s of SQLITE_BUSY retries with a short backoff; other errors are thrown at once. */
export async function lockedWrite<T>(fn: () => Promise<T>, opts: { attempts?: number; baseMs?: number } = {}): Promise<T> {
  const attempts = opts.attempts ?? 40;
  const base = opts.baseMs ?? 10;
  for (let i = 1; ; i++) {
    try {
      return await withWriteLock(fn);
    } catch (e) {
      if (!isBusy(e) || i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, Math.min(base * i, 200)));
    }
  }
}
