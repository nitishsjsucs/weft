// The after-commit outbox flush (docs/cloudflare/design.md 3.4 and 4.2, track cf2-platform). The pending flag is the
// world's, so one request's flush can meet another request's open transaction. It must neither send inside that
// transaction nor throw IO_IN_TX at a caller whose command already committed, and every committed row is still sent.
import { describe, expect, it } from "vitest";
import { withWriteLock } from "@weft/db";
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

/** A facade-wide guard: inTx is true for every caller while any transaction of the world is open (design 4.2). */
function facadeGuard() {
  let open = false;
  const g: TxGuard & { open(v: boolean): void } = {
    inTx: () => open,
    assertNotInTx: (what) => { if (open) throw Object.assign(new Error(`IO_IN_TX: ${what}`), { code: "IO_IN_TX" }); },
    open: (v) => { open = v; },
  };
  return g;
}

describe("the outbox flush", () => {
  it("meeting another request's open transaction, it neither throws IO_IN_TX nor sends; it sends once that commits", async () => {
    const guard = facadeGuard();
    const { e, hosted, sent, logs } = world(guard);
    guard.open(true);
    await expect(flushOutbox(e)).resolves.toBeUndefined();
    expect(sent).toEqual([]);
    expect(hosted.outboxPending).toBe(true);
    await sleep(OUTBOX_RETRY_MS * 4);
    expect(sent).toEqual([]);   // still open: the retry left the rows pending again
    guard.open(false);
    await sleep(OUTBOX_RETRY_MS * 6);
    expect(sent).toEqual(["after commit"]);
    expect(hosted.outboxPending).toBe(false);
    expect(logs).toEqual([]);
  });

  it("waits for an executor transaction that holds the write lock, so it never reads rows that transaction has not committed", async () => {
    const { e, sent } = world({ inTx: () => false, assertNotInTx: () => undefined });   // a guard scoped to the caller sees nothing
    const order: string[] = [];
    let release!: () => void;
    const held = withWriteLock(async () => { order.push("tx open"); await new Promise<void>((r) => { release = r; }); order.push("tx commit"); });
    await sleep(1);
    const flushed = flushOutbox(e).then(() => order.push(`flushed ${sent.length}`));
    await sleep(10);
    expect(sent).toEqual([]);
    release();
    await held;
    await flushed;
    expect(order).toEqual(["tx open", "tx commit", "flushed 1"]);
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
