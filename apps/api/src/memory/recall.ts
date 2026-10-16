// Memory recall at run start (harness memory, Muse and Instinct style). Owner: w2-memory (docs/wave2.md).
// Returns a <recall> block within RECALL_BUDGET, or "" to leave the context pack unchanged. The runtime appends a
// non-empty block inside <context>; recalled text is memory content, so it is escaped and never carries instructions.
import type { Db } from "@weft/db";

export interface RecallInput { companyId: string; runId: string; kind: "chat" | "routine"; query: string; subjectRefs: string[] }

export function createMemoryRecall(_db: Db): (input: RecallInput) => Promise<string> {
  return async () => "";
}
