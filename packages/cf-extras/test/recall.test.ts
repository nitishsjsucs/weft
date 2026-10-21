// Semantic recall candidates (design 5.4): seed notes in the shared `seed-<snapshot>` namespace, slot notes in the
// slot's namespace with their generation; a query keeps only the current generation, honours trustedOnly, returns
// paths and commits (never text), and indexing is idempotent with deterministic vector ids.
import { describe, expect, it } from "vitest";
import { EMBEDDING_MODEL, seedNamespace } from "../../contracts/src/ext/cf-extras";
import { memoryNeuronBudget } from "../src/neurons";
import { chunkNote, createRecallSource, deleteVectors, embedTexts, indexNotes, isUntrustedNote, noteKindOfPath, vectorIdOf } from "../src/recall";
import { embeddingHandler, fakeAi, fakeVectorize } from "./fakes";

const C1 = "1".repeat(40), C2 = "2".repeat(40), C3 = "3".repeat(40);
const doc = (title: string, body: string, tainted: string | null = null) =>
  `---\nid: "x"\ntype: "fact"\naliases: []\nlinks: []\nsources: []\nstatus: null\nupdated: "2026-10-26"\ntainted_by: ${JSON.stringify(tainted)}\n---\n# ${title}\n\n${body}\n`;

async function world() {
  const ai = fakeAi({ [EMBEDDING_MODEL]: embeddingHandler });
  const vectors = fakeVectorize();
  const deps = { ai, vectors };
  await indexNotes(deps, { namespace: seedNamespace("snap1"), gen: 0, notes: [
    { path: "knowledge/procedures/payday.md", commit: C1, tainted: false, kind: "procedure", text: doc("When we pay salaries", "Salaries are paid semi monthly on the 15th and the last business day of the month.") },
    { path: "entities/states/CA.md", commit: C1, tainted: false, kind: "entities", text: doc("California", "SUI rate notices arrive from the EDD every December.") },
    { path: "knowledge/facts/vendor-note.md", commit: C1, tainted: true, kind: "knowledge", text: doc("Vendor note", "Salaries paid by the vendor portal said the email.", "notice:ntc_0001") },
  ] });
  await indexNotes(deps, { namespace: "slot-1", gen: 2, notes: [{ path: "knowledge/facts/old-gen.md", commit: C2, tainted: false, kind: "knowledge", text: doc("Old payday note", "Salaries were paid on Fridays in the old world.") }] });
  await indexNotes(deps, { namespace: "slot-1", gen: 3, notes: [{ path: "knowledge/facts/payday-change.md", commit: C3, tainted: false, kind: "knowledge", text: doc("Payday change", "Salaries are paid a day early when payday falls on a holiday.") }] });
  return { ai, vectors, deps };
}

describe("RecallSource", () => {
  it("returns path and commit candidates from the seed and the slot's current generation only", async () => {
    const { ai, vectors } = await world();
    const src = createRecallSource({ ai, vectors, minScore: 0.1 });
    const got = await src.candidates({ text: "when do we pay salaries", slot: "slot-1", gen: 3, snapshot: "snap1", k: 5, trustedOnly: false });
    const paths = got.map((c) => c.path);
    expect(paths).toContain("knowledge/procedures/payday.md");
    expect(paths).toContain("knowledge/facts/payday-change.md");
    expect(paths).not.toContain("knowledge/facts/old-gen.md");
    expect(got.find((c) => c.path === "knowledge/facts/payday-change.md")).toMatchObject({ commit: C3, namespace: "slot-1", tainted: false, kind: "knowledge" });
    expect(got[0]!.path).toBe("knowledge/procedures/payday.md");
    for (const c of got) expect(Object.keys(c).sort()).toEqual(["commit", "kind", "namespace", "path", "score", "tainted"]);
    // The slot query filters on the generation in Vectorize itself.
    expect(vectors.queries.find((q) => q.namespace === "slot-1")!.filter).toEqual({ gen: { $eq: 3 } });
  });

  it("trustedOnly leaves out tainted notes, and weak matches and empty queries return nothing", async () => {
    const { ai, vectors } = await world();
    const src = createRecallSource({ ai, vectors, minScore: 0.1 });
    const all = await src.candidates({ text: "salaries paid vendor portal email", slot: "slot-1", gen: 3, snapshot: "snap1", k: 5, trustedOnly: false });
    expect(all.some((c) => c.tainted)).toBe(true);
    const trusted = await src.candidates({ text: "salaries paid vendor portal email", slot: "slot-1", gen: 3, snapshot: "snap1", k: 5, trustedOnly: true });
    expect(trusted.length).toBeGreaterThan(0);
    expect(trusted.some((c) => c.tainted)).toBe(false);
    expect(vectors.queries.at(-2)!.filter).toEqual({ tainted: { $eq: false } });
    expect(await createRecallSource({ ai, vectors, minScore: 0.99 }).candidates({ text: "quarterly reconciliation", slot: "slot-1", gen: 3, snapshot: "snap1", k: 5, trustedOnly: false })).toEqual([]);
    const calls = ai.calls.length;
    expect(await src.candidates({ text: "   ", slot: "slot-1", gen: 3, snapshot: "snap1", k: 5, trustedOnly: false })).toEqual([]);
    expect(ai.calls.length).toBe(calls);
  });

  it("indexing is idempotent: the same notes upsert the same vector ids", async () => {
    const { vectors, deps } = await world();
    const before = vectors.vectors.size;
    const r = await indexNotes(deps, { namespace: "slot-1", gen: 3, notes: [{ path: "knowledge/facts/payday-change.md", commit: C3, tainted: false, kind: "knowledge", text: doc("Payday change", "Salaries are paid a day early when payday falls on a holiday.") }] });
    expect(vectors.vectors.size).toBe(before);
    expect(r.ids).toEqual([await vectorIdOf("slot-1", "knowledge/facts/payday-change.md", C3, 0)]);
    expect(r.ids[0]!.length).toBeLessThanOrEqual(64);
    expect(vectors.vectors.get(r.ids[0]!)!.metadata).toEqual({ path: "knowledge/facts/payday-change.md", commit: C3, gen: 3, tainted: false, kind: "knowledge" });
    expect(await deleteVectors(vectors, r.ids)).toBe(1);
    expect(vectors.vectors.has(r.ids[0]!)).toBe(false);
  });

  it("embeddings reserve from the embeddings share and check the model's shape", async () => {
    const ai = fakeAi({ [EMBEDDING_MODEL]: embeddingHandler });
    const neurons = memoryNeuronBudget({ agent: 0, ocr: 0, embeddings: 2, dictation: 0 });
    await embedTexts({ ai, neurons }, ["a short note"]);
    expect(neurons.used("embeddings")).toBe(1);
    await embedTexts({ ai, neurons }, ["another"]);
    await expect(embedTexts({ ai, neurons }, ["one too many"])).rejects.toMatchObject({ code: "RECALL_UNAVAILABLE" });
    const bad = fakeAi({ [EMBEDDING_MODEL]: () => ({ data: [[1, 2, 3]] }) });
    await expect(embedTexts({ ai: bad }, ["x"])).rejects.toMatchObject({ code: "RECALL_UNAVAILABLE", retryable: true });
    await expect(embedTexts({ ai }, new Array(51).fill("x"))).rejects.toThrow(/at most 50/);
  });
});

describe("chunking and note rules", () => {
  it("chunks the body without frontmatter or backlinks, splitting long paragraphs", () => {
    const text = doc("Big", `${"word ".repeat(400)}\n\nSecond paragraph.\n\n## Backlinks\n\n- [[entities/people/wrk_0001]]`);
    const chunks = chunkNote(text, 1200);
    expect(chunks.join(" ")).not.toContain("tainted_by");
    expect(chunks.join(" ")).not.toContain("Backlinks");
    expect(chunks.every((c) => c.length <= 1200)).toBe(true);
    expect(chunks.length).toBe(2);
    expect(chunks.at(-1)).toContain("Second paragraph.");
  });

  it("marks decision notes and tainted_by notes untrusted, and names the kind", () => {
    expect(isUntrustedNote("knowledge/decisions/x.md", doc("D", "b"))).toBe(true);
    expect(isUntrustedNote("knowledge/facts/x.md", doc("F", "b", "notice:ntc_0001"))).toBe(true);
    expect(isUntrustedNote("knowledge/facts/x.md", doc("F", "b"))).toBe(false);
    expect([noteKindOfPath("knowledge/procedures/a.md"), noteKindOfPath("knowledge/decisions/a.md"), noteKindOfPath("entities/people/wrk_0001.md"), noteKindOfPath("x.md")])
      .toEqual(["procedure", "decision", "entities", "x.md"]);
  });
});
