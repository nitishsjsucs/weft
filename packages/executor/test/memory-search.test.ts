// memory.search over a multi-word query and recall without a one-pager (wave 4 FG4, FM4). A keyword question used
// to be one fixed string and found nothing; now the phrase leads, then lines with every word, then lines with some.
import { afterEach, describe, expect, it } from "vitest";
import type { RunHandle } from "@weft/contracts";
import { makeWorld, type World } from "./fixtures";
import { matchLine, queryWords, stem, tierSummary } from "../src/memory/terms";
import { renderRecall, type RecallCandidate } from "../src/memory/recall";

const worlds: World[] = [];
afterEach(async () => { for (const w of worlds.splice(0)) await w.close(); });
async function world(): Promise<{ w: World; h: RunHandle; m: any }> {
  const w = await makeWorld();
  worlds.push(w);
  return { w, h: await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" }), m: w.executor.memory };
}
type Hit = { cite: string; path: string; match: string; snippet: string };
const done = (o: { ok: boolean; status?: string; data?: unknown; summary?: string }) => {
  if (!o.ok || o.status !== "done") throw new Error(`not done: ${JSON.stringify(o)}`);
  return { hits: (o.data as { hits: Hit[] }).hits, summary: o.summary ?? "" };
};

const NOTE = {
  path: "knowledge/facts/expense-review.md", title: "Expense review",
  body: [
    "- The finance lead approves expense reports each week (2026-10-26, src: action:1)",
    "- Expense reports are filed from the portal (2026-10-26, src: action:1)",
    "- Mileage approval needs a receipt (2026-10-26, src: action:1)",
    "- Desk setup is ordered by IT (2026-10-26, src: action:1)",
  ].join("\n"),
  sources: ["action:1"],
};

describe("memory.search query words (FM4)", () => {
  it("splits a question into topic words with short stems, and keeps ids, codes and paths whole", () => {
    expect(queryWords("Who usually approves expense reports?").map((w) => w.stem)).toEqual(["approv", "expense", "report"]);
    expect(queryWords("why is wrk_0002 in entities/states/CA").map((w) => w.raw)).toEqual(["wrk_0002", "entities/states/ca"]);
    expect(queryWords("who is it?")).toEqual([]);
    expect(stem("approval")).toBe("approv");
    expect(stem("payroll")).toBe("payroll");
    expect(stem("tax.update_rate")).toBe("tax.update_rate");
  });

  it("labels a line by phrase, every word or some words, scoring distinct concepts", () => {
    const words = [["approv"], ["expense"], ["report"]];
    expect(matchLine("approves expense reports", ["approves expense reports"], words)).toEqual({ tier: "phrase", score: 4 });
    expect(matchLine("The lead approves expense reports", ["who approves expense reports"], words)).toEqual({ tier: "all_terms", score: 3 });
    expect(matchLine("Expense reports are filed", ["who approves expense reports"], words)).toEqual({ tier: "any_term", score: 2 });
    expect(matchLine("Desk setup", ["who approves expense reports"], words)).toBeNull();
    expect(tierSummary(["phrase", "any_term", "any_term"])).toBe("1 phrase, 2 some words");
  });

  it("finds a keyword question that one fixed string misses: every word first, then some words, and says so", async () => {
    const { w, h } = await world();
    expect((await w.executor.agent.exec(h, { callId: "n", command: "memory.write_note", args: NOTE })).ok).toBe(true);
    const search = async (query: string) => done(await w.executor.agent.exec(h, { callId: query, command: "memory.search", args: { query, folders: ["knowledge"] } }));
    const q = await search("Who usually approves expense reports?");
    expect(q.hits.slice(0, 2).map((x) => [x.cite, x.match])).toEqual([
      ["knowledge/facts/expense-review.md#L13", "all_terms"],
      ["knowledge/facts/expense-review.md#L14", "any_term"],
    ]);
    // "approves" also finds "approval" (a stem); frontmatter never matches on a loose word.
    expect(q.hits.map((x) => x.cite)).toContain("knowledge/facts/expense-review.md#L15");
    expect(q.hits.slice(1).every((x) => x.match === "any_term" && !/^[a-z_]+: /.test(x.snippet))).toBe(true);
    expect(q.hits.map((x) => x.cite)).not.toContain("knowledge/facts/expense-review.md#L16");
    expect(q.summary).toBe(`${q.hits.length} memory hits for the query (1 all words, ${q.hits.length - 1} some words)`);
    // The exact phrase still leads when it is there.
    const p = await search("expense reports");
    expect(p.hits.slice(0, 2).map((x) => x.match)).toEqual(["phrase", "phrase"]);
    // Nothing matches: the summary says the words were tried, and never echoes them.
    const none = await search("zzqx yyqv");
    expect(none.hits).toEqual([]);
    expect(none.summary).toBe("0 memory hits for the query (no line has the phrase or any of its words)");
    expect(none.summary).not.toContain("zzqx");
  });

  it("a multi-word query ranks notes before the raw timeline when the match is equal", async () => {
    const { w, h, m } = await world();
    await m.appendTimeline({ at: "2026-10-26T15:30:00.000Z", command: "expenses.decide", text: "The finance lead approves expense reports", importance: 1, source: "action:5", chainHead: { seq: 5, hash: "0".repeat(64) } });
    expect((await w.executor.agent.exec(h, { callId: "n", command: "memory.write_note", args: NOTE })).ok).toBe(true);
    const r = done(await w.executor.agent.exec(h, { callId: "q", command: "memory.search", args: { query: "approves expense reports finance" } }));
    expect(r.hits[0]!.path).toBe("knowledge/facts/expense-review.md");
    expect(r.hits.map((x) => x.path)).toContain("timeline/raw/2026-10-26.md");
  });
});

describe("recall without a one-pager (FM4)", () => {
  it("builds a block from the subject dossier and term hits before any digest", async () => {
    const { m } = await world();
    expect(await m.read("knowledge/company/one-pager.md")).toBeNull();
    const out = await m.recall({ request: "What changed for Theo Marsh?", subjectRefs: [] });
    expect(out.block.startsWith("<recall")).toBe(true);
    expect(out.items[0]).toMatchObject({ path: "entities/people/wrk_0002.md", kind: "dossier" });
    expect((await m.recall({ request: "zzqx", subjectRefs: [] })).block).toBe("");
  });

  it("an untrusted note keeps its path and shows its id when the path does not carry it", () => {
    const c = (path: string, noteId: string | null, excerpt = "Contractors invoice monthly."): RecallCandidate =>
      ({ kind: "hit", path, title: path, excerpt, score: 1, asOf: "2026-10-26", taintedBy: `memory:${path}`, noteId });
    const { block } = renderRecall([c("knowledge/decisions/invoice-cadence.md#L9", "DEC-0042"), c("knowledge/decisions/DEC-0043-x.md#L9", "DEC-0043")]);
    expect(block).toContain("- knowledge/decisions/invoice-cadence.md#L9 (hit, as of 2026-10-26, untrusted): id DEC-0042. Contractors invoice monthly.");
    expect(block).toContain("- knowledge/decisions/DEC-0043-x.md#L9 (hit, as of 2026-10-26, untrusted): Contractors invoice monthly.");
  });
});
