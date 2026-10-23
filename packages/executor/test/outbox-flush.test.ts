// The after-commit outbox flush (docs/cloudflare/design.md 3.4 and 4.2, track cf2-platform). The pending flag is the
// world's, so one request's flush can meet another request's open transaction. The IO_IN_TX guard cannot see that
// one (inTx() is scoped to the async context of its own transaction); the world's write lock holds the flush until it
// commits. The guard does see the caller's own transaction when the flush is reached from inside one. Either way the
// flush must neither send inside a transaction nor throw IO_IN_TX at a caller whose command already committed, and
// every committed row is still sent. The guard here is the real one (createTxGuard), so its scoping is the facade's.
import { describe, expect, it } from "vitest";
import { createTxGuard, withWriteLock } from "@weft/db";
import type { TxGuard } from "../../contracts/src/ext/cf-db";
import { NODE_HOSTED, type Engine, type EngineHosted } from "../src/engine";
import { flushOutbox, OUTBOX_RETRY_MS } from "../src/timeline";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function world(guard: TxGuard | null) {
  const sent: string[] = [];
  const logs: string[] = [];
  const hosted: EngineHosted = {
    ephemeralReadIds: true, outbox: { slot: "slot-1", gen: 1 }, outboxPending: true, guard, systemAllowlists: new Map(),
    onOutbox: () => { sent.push(guard?.inTx() ? "inside a transaction" : "after commit"); },
  };
  const e = { hosted, log: (l: string) => logs.push(l) } as unknown as Engine;
  return { e, hosted, sent, logs };
}

/** An executor transaction as writeLocked runs one: the world's write lock, then the facade's outer transaction. */
const executorTx = <T>(guard: ReturnType<typeof createTxGuard>, body: () => Promise<T>) => withWriteLock(() => guard.within(body));

describe("the outbox flush", () => {
  it("waits for another request's executor transaction, which the guard cannot see, and sends once that commits", async () => {
    const guard = createTxGuard();
    const { e, sent, logs } = world(guard);
    const order: string[] = [];
    let release!: () => void;
    const held = executorTx(guard, async () => {
      order.push(`tx open, inTx ${guard.inTx()}`);
      await new Promise<void>((r) => { release = r; });
      order.push("tx commit");
    });
    await sleep(1);
    // This request's own async context has no transaction, so inTx() is false here although the other one is open:
    // only the write lock keeps the flush from reading rows that transaction has not committed.
    expect(guard.inTx()).toBe(false);
    const flushed = flushOutbox(e).then(() => order.push(`flushed ${sent.length}`));
    await sleep(10);
    expect(sent).toEqual([]);
    release();
    await held;
    await flushed;
    expect(order).toEqual(["tx open, inTx true", "tx commit", "flushed 1"]);
    expect(sent).toEqual(["after commit"]);
    expect(logs).toEqual([]);
  });

  it("reached while its caller's own transaction is open, it neither throws IO_IN_TX nor sends; it sends once that commits", async () => {
    const guard = createTxGuard();
    const { e, hosted, sent, logs } = world(guard);
    // A command run from inside another transaction's body: the write lock is re-entrant there, so it does not wait,
    // and the guard, which sees this context's transaction, is what keeps the send out of it.
    await executorTx(guard, async () => {
      await expect(flushOutbox(e)).resolves.toBeUndefined();
      expect(sent).toEqual([]);
      expect(hosted.outboxPending).toBe(true);
      await sleep(OUTBOX_RETRY_MS * 4);
      expect(sent).toEqual([]);   // still open: each retry left the rows pending again
    });
    expect(guard.inTx()).toBe(false);
    await sleep(OUTBOX_RETRY_MS * 6);
    expect(sent).toEqual(["after commit"]);
    expect(hosted.outboxPending).toBe(false);
    expect(logs).toEqual([]);
  });

  it("a failing send is logged, never thrown at the caller", async () => {
    const { e, hosted, logs } = world(null);
    hosted.onOutbox = () => { throw new Error("queue unavailable"); };
    await expect(flushOutbox(e)).resolves.toBeUndefined();
    expect(logs).toEqual(["outbox flush failed: queue unavailable"]);
  });

  it("does nothing on Node, without waiting for the write lock", async () => {
    const e = { hosted: NODE_HOSTED, log: () => undefined } as unknown as Engine;
    let release!: () => void;
    const held = withWriteLock(() => new Promise<void>((r) => { release = r; }));
    let done = false;
    const p = flushOutbox(e).then(() => { done = true; });
    await sleep(5);
    expect(done).toBe(true);
    release();
    await held; await p;
  });
});
