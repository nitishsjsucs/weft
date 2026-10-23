// After commit: one raw timeline bullet per action with the Weft-Chain-Head trailer (best-effort; verify tolerates
// git lagging one action and reports gitLag). Built from structured fields only.
import { eq } from "drizzle-orm";
import type { ToolOutcome } from "@weft/contracts";
import { actions, withWriteLock } from "@weft/db";
import type { Engine } from "./engine";

export function importanceOf(command: string): 0 | 1 | 2 | 3 {
  if (/^(payroll\.submit|it\.order|payroll\.off_cycle)/.test(command)) return 3;
  if (/^(tax\.|people\.set_pay|notices\.send|it\.create)/.test(command)) return 2;
  if (/^(comms\.post_update)/.test(command)) return 0;
  return 1;
}

/** How soon a flush that met its caller's open transaction tries again. */
export const OUTBOX_RETRY_MS = 5;
const retries = new WeakMap<Engine, ReturnType<typeof setTimeout>>();

/**
 * After the outer commit: a platform with an outbox (the durable one) sends the rows the command appended. Never
 * inside a transaction: the Queue send is real I/O that would hold the input gate (docs/cloudflare/design.md 4.2).
 *
 * The pending flag is the world's, not one request's, so the flush can run while another request's transaction is
 * open. The guard cannot see that one: inTx() is scoped to the async context of its own transaction
 * (packages/db/src/tx-guard.ts), so it answers for the caller's transaction only. The world's write lock is what
 * protects the flush: every executor transaction (the only writer of outbox rows) runs inside writeLocked, so once
 * the flush holds the lock no other request's transaction is open and no uncommitted row can be read and sent.
 * inTx() is true here only when the caller is itself still inside a transaction (the lock is re-entrant, so it does
 * not wait for that one): the rows stay pending and the flush tries again shortly, until that transaction has
 * settled. It never throws IO_IN_TX at a caller whose command already committed. Node has no onOutbox and returns
 * at once.
 */
export async function flushOutbox(e: Engine): Promise<void> {
  const h = e.hosted;
  if (!h?.outboxPending || !h.onOutbox) return;
  await withWriteLock(async () => {
    if (!h.outboxPending || !h.onOutbox) return;
    if (h.guard?.inTx()) { flushSoon(e); return; }
    h.outboxPending = false;
    try { h.onOutbox(); } catch (err) { e.log(`outbox flush failed: ${err instanceof Error ? err.message : String(err)}`); }
  });
}

function flushSoon(e: Engine): void {
  if (retries.has(e)) return;
  const t = setTimeout(() => {
    retries.delete(e);
    flushOutbox(e).catch((err: unknown) => e.log(`outbox flush failed: ${err instanceof Error ? err.message : String(err)}`));
  }, OUTBOX_RETRY_MS);
  (t as { unref?: () => void }).unref?.();
  retries.set(e, t);
}

export async function afterCommit(e: Engine, outcome: ToolOutcome | null): Promise<void> {
  await flushOutbox(e);
  if (!outcome || !(outcome.ok && outcome.status === "done") || outcome.actionSeq === null) return;
  const [a] = await e.db.select().from(actions).where(eq(actions.seq, outcome.actionSeq)).limit(1);
  if (!a) return;
  try {
    await e.memory.appendTimeline({ at: a.ts, command: a.command, text: a.summary, importance: importanceOf(a.command), source: `action:${a.seq}`, chainHead: { seq: a.seq, hash: a.hash } });
    e.gitHeadSeq = a.seq;
  } catch (err) {
    e.log(`memory timeline append failed for action ${a.seq}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
