// Memory recall at run start (harness 9.5 and 18 item 4, Muse and Instinct style). Owner: w2-memory (docs/wave2.md).
// Returns a <recall> block within RECALL_BUDGET, or "" to leave the context pack unchanged. The runtime appends a
// non-empty block inside <context>; recalled text is memory content, so it is escaped and never carries instructions.
// Code picks the subjects (trigger refs, then ids and aliases named in the request) and runs at most 4 searches.
// The one-pager leads once the first digest writes it; before that (wave 4, FM4) recall still returns the subject
// dossiers and term hits, so a world that never ran the digest is not silently without memory. Worlds that must keep
// wave 1 packs byte-identical switch recall off with recallEnabled.
// Every non-empty recall is logged in memory_recalls; a tainted hit taints the run through the executor's path.
// On hosted, semantic candidates may join the block (semantic.ts, off by default).
import { eq } from "drizzle-orm";
import { memoryRecalls, type Db } from "@weft/db";
import { memoryBinding, type MemoryBinding } from "./binding";
import { withSemanticRecall } from "./semantic";

/** A failed semantic source costs the run nothing but its semantic lines; it is reported, never silent. */
function semanticFailed(b: MemoryBinding, e: unknown): void {
  try {
    if (b.semantic?.onError) { b.semantic.onError(e); return; }
    const msg = b.redact(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);
    console.warn(`memory recall: semantic candidates failed, recall stayed lexical: ${msg}`);
  } catch { /* reporting never fails a run */ }
}

export interface RecallInput { companyId: string; runId: string; kind: "chat" | "routine"; query: string; subjectRefs: string[] }

export function createMemoryRecall(db: Db): (input: RecallInput) => Promise<string> {
  return async (input) => {
    const b = memoryBinding(db);
    if (!b || !b.recallEnabled || typeof b.memory.recall !== "function") return "";
    // Once per run: a run that already recalled (for example after a requeue) gets nothing new.
    if ((await db.select({ id: memoryRecalls.id }).from(memoryRecalls).where(eq(memoryRecalls.runId, input.runId)).limit(1)).length) return "";
    // A routine run never recalls tainted text: its autoAllow writes (the weekly digest post, the new hire welcome)
    // depend on the run staying untainted, so it gets trusted candidates only. Chat runs are read-only and may be
    // tainted by what they recall.
    const trustedOnly = input.kind === "routine";
    const lexical = await b.memory.recall({ request: input.query, subjectRefs: input.subjectRefs, trustedOnly }).catch(() => null);
    // Hybrid recall (cf6-extras): semantic candidates, re-verified at HEAD, join the block only where a platform
    // attached a source and its flag is on; otherwise this is the lexical outcome itself. A failing source never
    // costs the run its lexical recall.
    const out = b.semantic ? await withSemanticRecall(b.semantic, input, lexical, trustedOnly, b.redact).catch((e: unknown) => { semanticFailed(b, e); return lexical; }) : lexical;
    if (!out || !out.block) return "";
    // Taint first: if the run cannot be marked, the untrusted text never reaches the pack.
    const tainted = out.items.find((i) => i.taintedBy);
    if (tainted && trustedOnly) return "";
    if (tainted) {
      try { await b.taintRun(input.runId, `memory:${tainted.path.split("#")[0]}`); } catch { return ""; }
    }
    await db.insert(memoryRecalls).values({ runId: input.runId, pathsJson: JSON.stringify(out.items.map((i) => i.path)), chars: out.block.length, ts: b.clock.now() });
    return out.block;
  };
}
