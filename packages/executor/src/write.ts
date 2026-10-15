// Every executor write goes through writeLocked(): the process-wide withWriteLock, then the thunk, retried with backoff
// while another connection holds SQLite's write lock. Writers outside the lock (the scaffold clock and scheduler
// cursor today) make BEGIN IMMEDIATE fail at once with SQLITE_BUSY, because busy_timeout reaches only the first pooled
// connection. The thunk opens its own transaction, so a retry repeats the whole transaction and nothing half-applies.
import { withWriteLock } from "@weft/db";

const MAX_ATTEMPTS = 14;   // about 2.5 s of backoff in total

export function isBusy(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export function writeLocked<T>(thunk: () => Promise<T>): Promise<T> {
  return withWriteLock(async () => {
    let wait = 5;
    for (let attempt = 1; ; attempt++) {
      try { return await thunk(); } catch (err) {
        if (!isBusy(err) || attempt >= MAX_ATTEMPTS) throw err;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 250);
      }
    }
  });
}
