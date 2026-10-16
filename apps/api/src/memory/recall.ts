// Memory recall at run start (harness 9.5 and 18 item 4, Muse and Instinct style). Owner: w2-memory (docs/wave2.md).
// Returns a <recall> block within RECALL_BUDGET, or "" to leave the context pack unchanged. The runtime appends a
// non-empty block inside <context>; recalled text is memory content, so it is escaped and never carries instructions.
// Code picks the subjects (trigger refs, then ids and aliases named in the request) and runs at most 4 searches.
// The one-pager always leads; until the first digest writes it, recall stays "" so wave 1 packs are unchanged.
// Every non-empty recall is logged in memory_recalls; a tainted hit taints the run through the executor's path.
import { eq } from "drizzle-orm";
import { memoryRecalls, type Db } from "@weft/db";
import { memoryBinding } from "./binding";

export interface RecallInput { companyId: string; runId: string; kind: "chat" | "routine"; query: string; subjectRefs: string[] }

export function createMemoryRecall(db: Db): (input: RecallInput) => Promise<string> {
  return async (input) => {
    const b = memoryBinding(db);
    if (!b || !b.recallEnabled || typeof b.memory.recall !== "function") return "";
    // Once per run: a run that already recalled (for example after a requeue) gets nothing new.
    if ((await db.select({ id: memoryRecalls.id }).from(memoryRecalls).where(eq(memoryRecalls.runId, input.runId)).limit(1)).length) return "";
    const out = await b.memory.recall({ request: input.query, subjectRefs: input.subjectRefs }).catch(() => null);
    if (!out || !out.block) return "";
    // Taint first: if the run cannot be marked, the untrusted text never reaches the pack.
    const tainted = out.items.find((i) => i.taintedBy);
    if (tainted) {
      try { await b.taintRun(input.runId, `memory:${tainted.path.split("#")[0]}`); } catch { return ""; }
    }
    await db.insert(memoryRecalls).values({ runId: input.runId, pathsJson: JSON.stringify(out.items.map((i) => i.path)), chars: out.block.length, ts: b.clock.now() });
    return out.block;
  };
}
