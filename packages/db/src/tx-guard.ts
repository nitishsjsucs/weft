// The runtime IO_IN_TX guard (docs/cloudflare/design.md 4.2). A transaction body that waits on real I/O holds the
// Durable Object's input gate and resets the object at the 30 s timeout (verified locally), so on the durable
// platform every I/O seam (the R2-backed BlobStore, the provider transports, the Queue producer, every DO RPC stub)
// calls assertNotInTx() first and a test fails with IO_IN_TX instead of a deploy hanging. inTx() is scoped to the
// async context of the outer transaction: work in another context (a second request, a background run started
// before the transaction) is not inside it.
import { AsyncLocalStorage } from "node:async_hooks";
import { DURABLE_DB_ERRORS, type TxGuard } from "../../contracts/src/ext/cf-db";

/** The facade's errors: `code` is one of DURABLE_DB_ERRORS or a SQLite code mapped from workerd's message. */
export class DurableDbError extends Error {
  constructor(readonly code: string, message: string, readonly extendedCode: string = code, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DurableDbError";
  }
}

interface TxToken { open: boolean }

export interface TxGuardControl extends TxGuard {
  /** Runs `fn` as the body of an outer transaction: inTx() is true in its async context until it settles. */
  within<T>(fn: () => Promise<T>): Promise<T>;
}

export function createTxGuard(): TxGuardControl {
  const als = new AsyncLocalStorage<TxToken>();
  return {
    inTx: () => als.getStore()?.open === true,
    assertNotInTx(what: string) {
      if (als.getStore()?.open) {
        throw new DurableDbError(DURABLE_DB_ERRORS.ioInTx, `IO_IN_TX: ${what} inside a database transaction. A transaction holds the Durable Object's input gate; do the I/O before the transaction or after it commits.`);
      }
    },
    async within(fn) {
      if (als.getStore()?.open) return fn();
      const token: TxToken = { open: true };
      try { return await als.run(token, fn); } finally { token.open = false; }
    },
  };
}
