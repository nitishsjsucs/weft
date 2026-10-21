// Semantic recall end to end on a seeded world (design 5.4): the seed's memory notes are indexed into
// `seed-<snapshot>`, the Vectorize RecallSource finds them by meaning, and the apps/api hook re-reads each one at HEAD
// before it joins the recall block. A note changed after indexing is never cited from its stale vector, and recall
// is unchanged while the flag is off. Vectorize and Workers AI are the fakes (bag-of-words embeddings).
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestWeft, type TestWeft } from "@weft/api";
import { attachSemanticRecall } from "../../../api/src/memory/binding";
import { createMemoryRecall } from "../../../api/src/memory/recall";
import { chunkNote, createRecallSource, EMBEDDING_MODEL, embeddingNeurons, memoryNeuronBudget, seedNamespace } from "@weft/cf-extras";
import { NEURON_SHARES } from "../../../../packages/contracts/src/ext/cf-agent";
import { indexSeedMemory, memoryNotesAtHead, type SeedIndexResult } from "../../src/extras/slot/seed-index";
import { embeddingHandler, fakeAi, fakeVectorize } from "./helpers";

let w: TestWeft;
beforeAll(async () => { w = await createTestWeft(); });
afterAll(async () => { await w?.close(); });

const root = () => (w.executor.memory as unknown as { root(): string | null }).root()!;
const git = (args: string[]) => { try { return execFileSync("git", args, { cwd: root(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
/** The MemoryRepo port's read side over the world's git repository. */
const repo = {
  head: async () => git(["rev-parse", "HEAD"])!.trim(),
  list: async (o?: { at?: string }) => git(["ls-tree", "-r", "--name-only", o?.at ?? "HEAD"])!.split("\n").filter(Boolean).sort(),
  read: async (path: string, at?: string) => git(["show", `${at ?? "HEAD"}:${path}`]),
};
const open = async () => (await w.executor.runs.openChatRun({ principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui", keyScope: null }, { threadId: null, surface: "human_ui" })).runId;
const recall = async (query: string) => createMemoryRecall(w.db)({ companyId: "cmp_larkspur", runId: await open(), kind: "chat", query, subjectRefs: [] });

describe("seed index and semantic recall", () => {
  const ai = fakeAi({ [EMBEDDING_MODEL]: embeddingHandler });
  const vectors = fakeVectorize();
  let enabled = false;

  it("indexes the snapshot's notes once into the shared seed namespace", async () => {
    const notes = await memoryNotesAtHead(repo);
    expect(notes.length).toBeGreaterThan(20);
    expect(notes.every((n) => /^(entities|comms|timeline|workstreams|knowledge)\//.test(n.path) && !n.path.endsWith(".keep.md"))).toBe(true);
    const head = await repo.head();
    expect(notes.every((n) => n.commit === head)).toBe(true);
    // Every batch is metered by the embeddings share (200 neurons a day) and recorded; a seed larger than a day's
    // share resumes on the next day from the chunk it reached, until it is complete.
    const days: { used: number; nextChunk: number | null }[] = [];
    let r: SeedIndexResult | null = null;
    for (let from = 0; days.length < 20; ) {
      const day = memoryNeuronBudget();
      r = await indexSeedMemory({ ai, vectors, neurons: day }, repo, "snap1", { fromChunk: from });
      days.push({ used: day.used("embeddings"), nextChunk: r.nextChunk });
      expect(day.used("embeddings")).toBeLessThanOrEqual(NEURON_SHARES.embeddings);
      expect(day.open()).toBe(0);
      if (r.nextChunk === null) break;
      expect(r.nextChunk).toBeGreaterThan(from);
      from = r.nextChunk;
    }
    r = r!;
    expect(r).toMatchObject({ namespace: seedNamespace("snap1"), notes: notes.length, nextChunk: null });
    expect(vectors.vectors.size).toBe(r.chunks);
    expect([...vectors.vectors.values()].every((v) => v.namespace === "seed-snap1" && v.metadata!.gen === 0)).toBe(true);
    // What the days recorded is the upper bound of the whole seed's embeddings, each chunk paid for once.
    const texts = notes.flatMap((n) => { const title = /^# (.+)$/m.exec(n.text)?.[1]?.trim() ?? n.path; return chunkNote(n.text).map((c) => `${title}\n${c}`); });
    expect(texts).toHaveLength(r.chunks);
    expect(days.reduce((a, d) => a + d.used, 0)).toBeGreaterThanOrEqual(embeddingNeurons(texts));
    // A second full run upserts the same ids.
    await indexSeedMemory({ ai, vectors, neurons: memoryNeuronBudget({ ...NEURON_SHARES, embeddings: 1_000_000 }) }, repo, "snap1");
    expect(vectors.vectors.size).toBe(r.chunks);
  }, 60_000);

  it("finds seed notes by meaning, verified at HEAD, only while the flag is on", async () => {
    const query = "Which state agency notices arrive about unemployment rates?";
    const lexical = await recall(query);
    attachSemanticRecall(w.db, {
      // The fake bag-of-words embedding scores low; the real model's threshold is the default 0.55.
      source: createRecallSource({ ai, vectors, minScore: 0.05 }), enabled: () => enabled,
      world: () => ({ slot: "slot-1", gen: 1, snapshot: "snap1" }), readText: (p, at) => repo.read(p, at),
    });
    expect(await recall(query)).toBe(lexical);
    enabled = true;
    const block = await recall(query);
    const cites = [...block.matchAll(/- (\S+)#L(\d+) \(semantic/g)];
    expect(cites.length).toBeGreaterThan(0);
    for (const [, path, line] of cites) expect((await repo.read(path!))!.split("\n")[Number(line) - 1]!.trim().length).toBeGreaterThan(0);
    // Change one of the cited notes: its seed vector now points at an older version, so it is no longer cited.
    const [, changed] = cites[0]!;
    const text = (await repo.read(changed!))!;
    await (w.executor.memory as unknown as { seedFiles(f: { path: string; text: string }[], m: string): Promise<unknown> }).seedFiles([{ path: changed!, text: `${text}\n- An added line (2026-10-26, src: meeting)\n` }], "test: change a seeded note");
    const after = await recall(query);
    expect(after).not.toMatch(new RegExp(`${changed!.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}#L\\d+ \\(semantic`));
    attachSemanticRecall(w.db, null);
  }, 60_000);
});
