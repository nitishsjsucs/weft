// The seed memory index (design 5.4): the seeded world's memory notes are embedded once per snapshot into the shared
// Vectorize namespace `seed-<snapshot>`, which every world's recall reads (a world's own notes go to its slot
// namespace through embed.memory jobs). An operator path runs it after a snapshot is provisioned, metered by the
// embeddings share and resumed on later days until it is complete: CompanyDO on the showcase world (its memory is
// the snapshot's) hands its MemoryRepo here. Each note is indexed at the HEAD commit it was read at, so the recall
// hook's re-verification at HEAD holds in every world restored from it.
// Track cf6-extras.
import { indexNotes, isUntrustedNote, noteKindOfPath, seedNamespace, type EmbedDeps, type IndexResult, type NeuronBudget, type NoteToIndex, type VectorizeLike } from "@weft/cf-extras";
import type { MemoryRepo } from "../../../../../packages/contracts/src/ext/cf-memory";

/** Folders recall reads; README and the folder keep files are never indexed. */
const INDEXED = /^(entities|comms|timeline|workstreams|knowledge)\/.+\.md$/;

/** The notes at HEAD worth indexing, with their commit, trust and kind. */
export async function memoryNotesAtHead(repo: Pick<MemoryRepo, "head" | "list" | "read">): Promise<NoteToIndex[]> {
  const commit = await repo.head();
  const notes: NoteToIndex[] = [];
  for (const path of await repo.list({ at: commit })) {
    if (!INDEXED.test(path) || path.endsWith(".keep.md")) continue;
    const text = await repo.read(path, commit);
    if (text === null || !text.trim()) continue;
    notes.push({ path, commit, tainted: isUntrustedNote(path, text), kind: noteKindOfPath(path), text });
  }
  return notes;
}

export interface SeedIndexResult extends IndexResult { namespace: string }

/**
 * Indexes the snapshot's notes into `seed-<snapshot>` (gen 0: seed vectors hold for every generation). Every batch
 * reserves and settles through SpendDO's embeddings share like any embedding, so the ledger holds what the index
 * cost. The rich seed (about 250 chunks) needs more than one day's 200-neuron share: when the share refuses a batch
 * the call returns with `nextChunk`, and the operator calls it again on a later UTC day with `fromChunk` set to it,
 * until `nextChunk` is null. The snapshot's HEAD is fixed, so the chunk order is the same on every call.
 */
export async function indexSeedMemory(deps: EmbedDeps & { vectors: VectorizeLike; neurons: NeuronBudget }, repo: Pick<MemoryRepo, "head" | "list" | "read">, snapshot: string, opts: { fromChunk?: number } = {}): Promise<SeedIndexResult> {
  const notes = await memoryNotesAtHead(repo);
  const namespace = seedNamespace(snapshot);
  return { namespace, ...(await indexNotes(deps, { namespace, gen: 0, notes, fromChunk: opts.fromChunk ?? 0, stopOnBudget: true })) };
}
