// Wiki-links and backlinks (harness 18 item 2). Owner: w2-memory.
import { describe, expect, it } from "vitest";
import { backlinkIndex, extractLinks, linkify, stripLinks, withBacklinks } from "../../src/memory/links";

const ctx = { people: new Map([["wrk_0002", "Theo Marsh (demo)"]]), states: new Set(["CA", "CO"]) };

describe("wiki-links", () => {
  it("links people, notices and states in event text but never inside the source suffix or an existing link", () => {
    const line = linkify("Updated wrk_0002 work state CA for ntc_0002 in CO, not OR (src: action:wrk_0002)", ctx);
    expect(line).toBe("Updated [[entities/people/wrk_0002|Theo Marsh (demo)]] work state [[entities/states/CA]] for [[entities/notices/ntc_0002]] in [[entities/states/CO]], not OR (src: action:wrk_0002)");
    expect(linkify(line, ctx)).toBe(line);
    expect(linkify("Updated wrk_9999 (2026-10-26, src: seed)", ctx)).toBe("Updated wrk_9999 (2026-10-26, src: seed)");
  });

  it("extracts targets and strips links to their labels", () => {
    const t = "See [[entities/people/wrk_0002|Theo Marsh (demo)]] and [[entities/states/CA]] and [[entities/states/CA]].";
    expect(extractLinks(t)).toEqual(["entities/people/wrk_0002", "entities/states/CA"]);
    expect(stripLinks(t)).toBe("See Theo Marsh (demo) and CA and CA.");
  });

  it("maintains ## Backlinks deterministically, ignoring links inside backlinks sections", () => {
    const files = [
      { path: "timeline/daily/2026-10-12.md", body: "- Updated [[entities/people/wrk_0002|Theo]]\n" },
      { path: "entities/states/CA.md", body: "# CA\n\n- Manager [[entities/people/wrk_0002]] (2026-10-26, src: seed)\n" },
      { path: "entities/people/wrk_0002.md", body: "# Theo\n\n## Backlinks\n\n- [[entities/states/CO]]\n" },
    ];
    const idx = backlinkIndex(files);
    expect(idx.get("entities/people/wrk_0002.md")).toEqual(["entities/states/CA.md", "timeline/daily/2026-10-12.md"]);
    expect(idx.has("entities/states/CO.md")).toBe(false);
    const once = withBacklinks("# Theo\n\n- Title Lead (2026-10-26, src: seed)\n", idx.get("entities/people/wrk_0002.md")!);
    expect(once).toBe("# Theo\n\n- Title Lead (2026-10-26, src: seed)\n\n## Backlinks\n\n- [[entities/states/CA]]\n- [[timeline/daily/2026-10-12]]\n");
    expect(withBacklinks(once, idx.get("entities/people/wrk_0002.md")!)).toBe(once);
    expect(withBacklinks(once, [])).toBe("# Theo\n\n- Title Lead (2026-10-26, src: seed)\n");
  });
});
