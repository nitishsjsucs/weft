// The seed memory index (design 5.4): the seeded world's memory notes are embedded once per snapshot into the shared
// Vectorize namespace `seed-<snapshot>`, which every world's recall reads (a world's own notes go to its slot
// namespace through embed.memory jobs). An operator path runs it, once, after a snapshot is provisioned: CompanyDO
// on the showcase world (its memory is the snapshot's) hands its MemoryRepo here. Each note is indexed at the HEAD
// commit it was read at, so the recall hook's re-verification at HEAD holds in every world restored from it.
// Track cf6-extras.
import { indexNotes, isUntrustedNote, noteKindOfPath, seedNamespace, type EmbedDeps, type IndexResult, type NoteToIndex, type VectorizeLike } from "@weft/cf-extras";
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

/** Indexes the snapshot's notes into `seed-<snapshot>` (gen 0: seed vectors hold for every generation). */
export async function indexSeedMemory(deps: EmbedDeps & { vectors: VectorizeLike }, repo: Pick<MemoryRepo, "head" | "list" | "read">, snapshot: string): Promise<IndexResult & { namespace: string }> {
  const notes = await memoryNotesAtHead(repo);
  const namespace = seedNamespace(snapshot);
  return { namespace, ...(await indexNotes(deps, { namespace, gen: 0, notes })) };
}
