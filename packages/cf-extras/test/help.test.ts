// Help search (design 6.3): AI Search over Weft's own docs, at most 30 queries a UTC day by a Lobby counter, behind
// the extras.help kill flag; hits are one per doc with a title, path and short snippet. The corpus builder takes the
// visitor-facing docs only and refuses a doc with a secret-shaped string.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOSTED_SETTINGS } from "../../contracts/src/ext/cf-hosted";
import { COUNTERS, memoryDailyCounters } from "../src/counters";
import { buildHelpCorpus, createHelpSearch, HELP_CORPUS } from "../src/help";
import { fakeAiSearch } from "./fakes";

const chunks = [
  { id: "c1", score: 0.81, text: "# Guided tour\n\nThe tour walks through the eight scenarios in about three minutes, each step on its own target.", item: { key: "help/tour.md" } },
  { id: "c2", score: 0.62, text: "Press Next to move on.", item: { key: "help/tour.md" } },
  { id: "c3", score: 0.7, text: "Simulators   advance the clock.\n\nDeliver a notice.", item: { key: "help/simulators.md" } },
  { id: "c4", score: 0.99, text: "an object outside the corpus", item: { key: "exports/slot-1/x" } },
  { id: "c5", score: 0.5, text: "x".repeat(500), item: { key: "help/unknown-doc.md" } },
];

describe("HelpSearch", () => {
  it("returns one hit per doc with its title, path and a short snippet, best first", async () => {
    const search = fakeAiSearch(chunks);
    const help = createHelpSearch({ search, counters: memoryDailyCounters(), enabled: () => true });
    const r = await help.search("  how does the   guided tour work? ");
    expect(r).toEqual({
      ok: true, leftToday: HOSTED_SETTINGS.helpQueriesPerDay - 1,
      hits: [
        { title: "Guided tour", path: "help/tour.md", snippet: "Guided tour The tour walks through the eight scenarios in about three minutes, each step on its own target.", score: 0.81 },
        { title: "Simulators", path: "help/simulators.md", snippet: "Simulators advance the clock. Deliver a notice.", score: 0.7 },
        { title: "unknown-doc", path: "help/unknown-doc.md", snippet: `${"x".repeat(237)}...`, score: 0.5 },
      ],
    });
    expect(search.queries).toEqual(["how does the guided tour work?"]);
  });

  it("answers 30 queries a day, then HELP_DAILY_CAP without calling AI Search; a new UTC day starts again", async () => {
    let now = new Date("2026-10-26T23:00:00Z");
    const counters = memoryDailyCounters(() => now);
    const search = fakeAiSearch(chunks);
    const help = createHelpSearch({ search, counters, enabled: () => true });
    const left: number[] = [];
    for (let i = 0; i < 30; i++) { const r = await help.search(`question ${i}`); if (r.ok) left.push(r.leftToday); }
    expect(left).toHaveLength(30);
    expect(left.at(-1)).toBe(0);
    expect(await help.search("one more")).toMatchObject({ ok: false, code: "HELP_DAILY_CAP" });
    expect(search.queries).toHaveLength(30);
    expect(await counters.peek(COUNTERS.help)).toBe(30);
    // An empty query costs nothing and reports what is left.
    expect(await help.search("   ")).toEqual({ ok: true, hits: [], leftToday: 0 });
    now = new Date("2026-10-27T00:00:01Z");
    expect((await help.search("after midnight")).ok).toBe(true);
    expect(search.queries).toHaveLength(31);
  });

  it("is off behind its kill flag or without the binding, and a failing search does not throw", async () => {
    const counters = memoryDailyCounters();
    expect(await createHelpSearch({ search: fakeAiSearch(chunks), counters, enabled: async () => false }).search("tour")).toMatchObject({ ok: false, code: "HELP_DISABLED" });
    expect(await createHelpSearch({ search: null, counters, enabled: () => true }).search("tour")).toMatchObject({ ok: false, code: "HELP_DISABLED" });
    expect(await counters.peek(COUNTERS.help)).toBe(0);
    const broken = { async search() { throw new Error("7011: instance not found"); } };
    expect(await createHelpSearch({ search: broken, counters, enabled: () => true }).search("tour")).toMatchObject({ ok: false, code: "HELP_DISABLED", message: "Help search is unavailable right now" });
  });
});

describe("help corpus", () => {
  const ROOT = join(import.meta.dirname, "..", "..", "..");
  const read = (p: string) => { try { return readFileSync(join(ROOT, p), "utf8"); } catch { return null; } };

  it("builds from the repo's visitor-facing docs, with the tour among them", () => {
    const files = buildHelpCorpus(read);
    expect(files.map((f) => f.key)).toEqual(HELP_CORPUS.map((d) => d.key));
    const tour = files.find((f) => f.source === "docs/tour.md")!;
    expect(tour.body.startsWith("# Guided tour\n\nSource: docs/tour.md in the Weft repository.\n\n")).toBe(true);
    expect(files.every((f) => f.key.startsWith("help/") && f.bytes > 200)).toBe(true);
    expect(HELP_CORPUS.some((d) => /review-log|wave\d|evals|cloudflare/.test(d.source))).toBe(false);
  });

  it("refuses a missing doc or one holding a secret-shaped string", () => {
    expect(() => buildHelpCorpus(() => null)).toThrow(/missing/);
    const docs = [{ source: "docs/x.md", key: "help/x.md", title: "X" }];
    expect(() => buildHelpCorpus(() => "Set OPENAI_API_KEY= sk-abcdefghijklmnopqrstuvwx", docs)).toThrow(/secret-shaped/);
    expect(() => buildHelpCorpus(() => "token 0123456789abcdef0123456789abcdef", docs)).toThrow(/secret-shaped/);
    expect(buildHelpCorpus(() => "<!-- note -->Hello ![shot](a.png) there", docs)[0]!.body).toContain("Hello  there");
  });

  it("pnpm cf:help-corpus writes the files and a manifest, and uploads nothing without --upload", () => {
    const out = mkdtempSync(join(tmpdir(), "weft-help-"));
    try {
      const log = execFileSync(join(ROOT, "node_modules", ".bin", "tsx"), [join(ROOT, "scripts", "cf", "help-corpus.ts"), "--out", out], { cwd: ROOT, encoding: "utf8" });
      expect(log).toContain("not uploaded");
      const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as { bucket: string; prefix: string; files: { key: string; source: string }[] };
      expect(manifest).toMatchObject({ bucket: "weft-files", prefix: "help/" });
      expect(manifest.files.map((f) => f.key)).toEqual(HELP_CORPUS.map((d) => d.key));
      expect(readFileSync(join(out, "help", "tour.md"), "utf8")).toContain("Source: docs/tour.md");
    } finally { rmSync(out, { recursive: true, force: true }); }
  }, 60_000);
});
