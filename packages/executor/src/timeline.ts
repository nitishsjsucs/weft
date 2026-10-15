// After commit: one raw timeline bullet per action with the Weft-Chain-Head trailer (best-effort; verify tolerates
// git lagging one action and reports gitLag). Built from structured fields only.
import { eq } from "drizzle-orm";
import type { ToolOutcome } from "@weft/contracts";
import { actions } from "@weft/db";
import type { Engine } from "./engine";

export function importanceOf(command: string): 0 | 1 | 2 | 3 {
  if (/^(payroll\.submit|it\.order|payroll\.off_cycle)/.test(command)) return 3;
  if (/^(tax\.|people\.set_pay|notices\.send|it\.create)/.test(command)) return 2;
  if (/^(comms\.post_update)/.test(command)) return 0;
  return 1;
}

export async function afterCommit(e: Engine, outcome: ToolOutcome | null): Promise<void> {
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
