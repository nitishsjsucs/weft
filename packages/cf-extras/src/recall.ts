// Semantic recall candidates (design 5.4), off by default. Memory notes are embedded with bge-base-en-v1.5 (768 dims)
// through AI Gateway and stored in Vectorize `weft-memory`: the seeded notes once per snapshot in the shared
// namespace `seed-<snapshot>`, notes written after a reset in the slot's own namespace with their generation. A query
// reads both namespaces, keeps only the slot's current generation, and returns path and commit candidates. It never
// returns text: the recall hook in apps/api re-reads every candidate from the slot's memory repo at HEAD and keeps it
// only when the note there is the note that was indexed, so a citation always points at a real commit. Vectors
// become visible 1 to 3 minutes after an upsert (measured), so fresh notes are found lexically first. Track cf6-extras.
import { EMBEDDING_DIMS, EMBEDDING_MODEL, seedNamespace, type MemoryVectorMetadata, type RecallCandidate, type RecallQuery, type RecallSource } from "../../contracts/src/ext/cf-extras";
import type { TxGuard } from "../../contracts/src/ext/cf-db";
import type { AiGatewayOption, VectorizeLike, VectorizeMatchLike, VectorizeVectorLike, WorkersAiBindingLike } from "./bindings";
import { sha256Hex } from "./bytes";
import { ExtrasError } from "./errors";
import { EMBEDDING_NEURONS_PER_M_TOKENS, embeddingNeurons, type NeuronBudget } from "./neurons";

export interface EmbedDeps {
  ai: WorkersAiBindingLike;
  gateway?: AiGatewayOption | null;
  /** The embeddings share (200 neurons a day); absent means unmetered (unit tests only). */
  neurons?: NeuronBudget | null;
  charge?: { world?: string | null; visitor?: string | null; ipHash?: string | null };
  /** The facade's IO_IN_TX guard (design 4.2): the neuron reservation, the embedding call and the Vectorize reads and
   * writes are real I/O, so a call inside a database transaction throws IO_IN_TX before any of them. */
  guard?: Pick<TxGuard, "assertNotInTx"> | null;
}

/**
 * Embeds texts in one call (at most EMBED_BATCH). The call reserves the most it can cost (embeddingNeurons, an
 * upper bound) and settles that, or the reply's own token count when it reports one. Refused by the share, it throws
 * EMBED_BUDGET before any call.
 */
export async function embedTexts(deps: EmbedDeps, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length > EMBED_BATCH) throw new Error(`embed at most ${EMBED_BATCH} texts per call`);
  deps.guard?.assertNotInTx("the Workers AI embedding call");
  const neurons = embeddingNeurons(texts);
  const rsv = deps.neurons ? await deps.neurons.reserve({ product: "embeddings", neurons, model: EMBEDDING_MODEL, ...deps.charge }) : null;
  if (rsv && !rsv.ok) throw new ExtrasError("EMBED_BUDGET", "today's embedding budget is used up");
  let out: unknown;
  try {
    out = await deps.ai.run(EMBEDDING_MODEL, { text: texts }, deps.gateway ? { gateway: deps.gateway } : undefined);
  } catch (e) {
    if (rsv?.ok) await deps.neurons!.settle(rsv.reservationId, neurons);
    throw e;
  }
  const reported = Number((out as { usage?: { prompt_tokens?: unknown } } | null)?.usage?.prompt_tokens);
  if (rsv?.ok) await deps.neurons!.settle(rsv.reservationId, Number.isFinite(reported) && reported > 0 ? Math.max(1, Math.ceil((reported * EMBEDDING_NEURONS_PER_M_TOKENS) / 1_000_000)) : neurons);
  const data = (out as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length !== texts.length || !data.every((v) => Array.isArray(v) && v.length === EMBEDDING_DIMS)) {
    throw new ExtrasError("RECALL_UNAVAILABLE", "the embedding model returned an unexpected shape", true);
  }
  return data as number[][];
}
export const EMBED_BATCH = 50;

export interface RecallSourceDeps extends EmbedDeps {
  vectors: VectorizeLike;
  /** Matches under this cosine score are dropped (the probe ranked the right note first at 0.708). */
  minScore?: number;
}

const metaOf = (m: VectorizeMatchLike): MemoryVectorMetadata | null => {
  const md = m.metadata ?? {};
  const { path, commit, gen, tainted, kind } = md as Record<string, unknown>;
  if (typeof path !== "string" || typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) return null;
  return { path, commit, gen: typeof gen === "number" ? gen : Number(gen), tainted: tainted === true || tainted === "true", kind: typeof kind === "string" ? kind : "note" };
};

export function createRecallSource(deps: RecallSourceDeps): RecallSource {
  const minScore = deps.minScore ?? 0.55;
  return {
    async candidates(q: RecallQuery): Promise<RecallCandidate[]> {
      const text = q.text.replace(/\s+/g, " ").trim().slice(0, 1000);
      const k = Math.max(1, Math.min(10, q.k));
      if (!text) return [];
      const [vector] = await embedTexts(deps, [text]);
      const trusted: Record<string, { $eq: boolean }> = q.trustedOnly ? { tainted: { $eq: false } } : {};
      const seedNs = seedNamespace(q.snapshot);
      const [seed, slot] = await Promise.all([
        deps.vectors.query(vector!, { topK: k * 2, namespace: seedNs, returnMetadata: "all", ...(q.trustedOnly ? { filter: trusted } : {}) }),
        deps.vectors.query(vector!, { topK: k * 2, namespace: q.slot, returnMetadata: "all", filter: { gen: { $eq: q.gen }, ...trusted } }),
      ]);
      const best = new Map<string, RecallCandidate>();
      const take = (ms: VectorizeMatchLike[], namespace: string, checkGen: boolean) => {
        for (const m of ms) {
          const md = metaOf(m);
          if (!md || m.score < minScore) continue;
          // Defensive: a slot vector from an older generation never counts, even if the filter index lags.
          if (checkGen && md.gen !== q.gen) continue;
          if (q.trustedOnly && md.tainted) continue;
          const prev = best.get(md.path);
          if (!prev || m.score > prev.score) best.set(md.path, { path: md.path, commit: md.commit, score: m.score, tainted: md.tainted, kind: md.kind, namespace });
        }
      };
      take(seed.matches, seedNs, false);
      take(slot.matches, q.slot, true);
      return [...best.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, k);
    },
  };
}

// Indexing --------------------------------------------------------------------------------------------------------

export interface NoteToIndex { path: string; commit: string; tainted: boolean; kind: string; text: string }

/** The body without frontmatter, cut into chunks of at most maxChars at blank lines (a long paragraph is split). */
export function chunkNote(text: string, maxChars = 1200): string[] {
  let body = text;
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---\n", 4);
    if (end >= 0) body = body.slice(end + 5);
  }
  const cut = body.indexOf("\n## Backlinks\n");
  if (cut >= 0) body = body.slice(0, cut);
  const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  const join = (piece: string) => (cur ? `${cur}\n\n${piece}` : piece);
  for (const p0 of paras) {
    let p = p0;
    while (p.length > 0) {
      const room = cur ? maxChars - cur.length - 2 : maxChars;
      if (p.length <= room) { cur = join(p); break; }
      if (room < 200) { out.push(cur); cur = ""; continue; }
      // Fill the chunk, cutting at the last space in reach so words stay whole.
      const space = p.lastIndexOf(" ", room);
      const piece = p.slice(0, space > room / 2 ? space : room);
      out.push(join(piece));
      cur = "";
      p = p.slice(piece.length).trimStart();
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Deterministic vector ids (at most 64 bytes), so a redelivered job upserts the same vectors again. */
export async function vectorIdOf(namespace: string, path: string, commit: string, chunk: number): Promise<string> {
  return `m_${(await sha256Hex(`${namespace}\n${path}\n${commit}\n${chunk}`)).slice(0, 40)}`;
}

export interface IndexResult {
  /** Every vector id of the notes, indexed in this call or before it. */
  ids: string[];
  chunks: number;
  notes: number;
  /** The first chunk not indexed yet when the embeddings share stopped the call (`stopOnBudget`), else null. */
  nextChunk: number | null;
}

/**
 * Embeds and upserts notes into one namespace with their generation; returns the vector ids for the Lobby. With
 * `fromChunk` it starts part way (an earlier call indexed the chunks before it), and with `stopOnBudget` a refusal
 * by the embeddings share ends the call with `nextChunk` instead of throwing, so a large index can finish over
 * several UTC days inside the share.
 */
export async function indexNotes(deps: EmbedDeps & { vectors: VectorizeLike }, input: { namespace: string; gen: number; notes: NoteToIndex[]; fromChunk?: number; stopOnBudget?: boolean }): Promise<IndexResult> {
  const items: { id: string; text: string; md: MemoryVectorMetadata }[] = [];
  for (const n of input.notes) {
    const title = /^# (.+)$/m.exec(n.text)?.[1]?.trim() ?? n.path;
    const chunks = chunkNote(n.text);
    for (const [i, c] of chunks.entries()) {
      items.push({ id: await vectorIdOf(input.namespace, n.path, n.commit, i), text: `${title}\n${c}`, md: { path: n.path, commit: n.commit, gen: input.gen, tainted: n.tainted, kind: n.kind } });
    }
  }
  for (let i = Math.max(0, input.fromChunk ?? 0); i < items.length; i += EMBED_BATCH) {
    const batch = items.slice(i, i + EMBED_BATCH);
    let vecs: number[][];
    try {
      vecs = await embedTexts(deps, batch.map((b) => b.text));
    } catch (e) {
      if (input.stopOnBudget && e instanceof ExtrasError && e.code === "EMBED_BUDGET") return { ids: items.map((x) => x.id), chunks: items.length, notes: input.notes.length, nextChunk: i };
      throw e;
    }
    const vectors: VectorizeVectorLike[] = batch.map((b, j) => ({ id: b.id, values: vecs[j]!, namespace: input.namespace, metadata: { ...b.md } }));
    await deps.vectors.upsert(vectors);
  }
  return { ids: items.map((x) => x.id), chunks: items.length, notes: input.notes.length, nextChunk: null };
}

/** Deletes a previous generation's slot vectors by id (ids recorded in the Lobby at upsert; design 4.6). */
export async function deleteVectors(vectors: VectorizeLike, ids: readonly string[]): Promise<number> {
  for (let i = 0; i < ids.length; i += 100) await vectors.deleteByIds(ids.slice(i, i + 100));
  return ids.length;
}

/** The memory folder a note's vector is filtered by (`kind` metadata index). */
export function noteKindOfPath(path: string): string {
  if (path.startsWith("knowledge/procedures/")) return "procedure";
  if (path.startsWith("knowledge/decisions/")) return "decision";
  return path.split("/")[0] || "note";
}

/** Untrusted by rule: a tainted_by frontmatter value, or a human decision note (as the lexical recall decides). */
export function isUntrustedNote(path: string, text: string): boolean {
  if (path.startsWith("knowledge/decisions/")) return true;
  const fm = text.startsWith("---\n") ? text.slice(4, Math.max(4, text.indexOf("\n---\n", 4))) : "";
  const m = /^tainted_by:\s*(.*)$/m.exec(fm);
  return !!m && m[1]!.trim() !== "null" && m[1]!.trim() !== "";
}
