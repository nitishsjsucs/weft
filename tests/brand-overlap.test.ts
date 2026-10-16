// The helpers behind `pnpm brand:overlap` (scripts/overlap.ts), on synthetic strings only.
import { describe, expect, it } from "vitest";
import { parseAllowlist, sharedRuns, shingles, visibleText, words } from "../scripts/overlap";

const ref = (html: string) => shingles(words(visibleText(html)).map((x) => x.w));

describe("visibleText", () => {
  it("keeps text nodes, titles, descriptive meta and labels, and drops scripts, styles and comments", () => {
    const html = `<!doctype html><html><head><title>Loom Page</title><meta name="description" content="Meta copy here"><style>.a{color:red}</style><script>var hidden = "script words";</script></head>
      <body><!-- a comment --><h1>Big <span>head</span>line</h1><img alt="Alt words"><input placeholder="Type here"><p>Tom &amp; Jerry&#39;s &#x41;</p><noscript>no js</noscript></body></html>`;
    const t = visibleText(html);
    for (const s of ["Loom Page", "Meta copy here", "Big headline", "Alt words", "Type here", "Tom & Jerry's A"]) expect(t).toContain(s);
    for (const s of ["color:red", "script words", "a comment", "no js"]) expect(t).not.toContain(s);
  });
});

describe("words", () => {
  it("folds case, punctuation, curly apostrophes and markdown so a shared run cannot hide", () => {
    expect(words("**Don’t** pay  the\n`Fee`, twice!").map((x) => x.w)).toEqual(["dont", "pay", "the", "fee", "twice"]);
    expect(words("a\nb\n\nc").map((x) => x.line)).toEqual([1, 2, 4]);
  });
});

describe("sharedRuns", () => {
  const page = "<p>the quick brown fox jumps over the lazy sleeping dog again today</p><p>unrelated block</p>";

  it("reports a maximal run of 8 or more shared words with its line", () => {
    const text = "intro line\nWe saw The Quick Brown Fox jumps over the lazy sleeping dog, said Ana.";
    const runs = sharedRuns(text, ref(page));
    expect(runs).toEqual([{ line: 2, words: 10, phrase: "the quick brown fox jumps over the lazy sleeping dog" }]);
  });

  it("ignores runs shorter than 8 words and crosses line wraps", () => {
    expect(sharedRuns("the quick brown fox jumps over the cat", ref(page))).toEqual([]);
    expect(sharedRuns("the quick brown fox\njumps over the lazy", ref(page))).toHaveLength(1);
  });

  it("skips windows covered by the allowlist", () => {
    const allowed = shingles(words("the quick brown fox jumps over the lazy sleeping dog").map((x) => x.w));
    expect(sharedRuns("the quick brown fox jumps over the lazy sleeping dog", ref(page), allowed)).toEqual([]);
  });
});

describe("parseAllowlist", () => {
  it("needs a reason and at least 8 words per entry", () => {
    const { phrases, problems } = parseAllowlist("# header\n\none two three four five six seven eight  # generic form name\none two three  # too short\nfour five six seven eight nine ten eleven\n");
    expect(phrases).toEqual(["one two three four five six seven eight"]);
    expect(problems).toHaveLength(2);
  });
});
