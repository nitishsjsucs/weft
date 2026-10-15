// Unit tests for the landing page's pure parts. Owner: t6-site.
import { describe, expect, it } from "vitest";
import { loomGlyphs, loomGlyphsSvg, weaveMarkStrokes, wovenBands, wovenBandsSvg } from "./art";
import { FALLBACK_STATS, toLandingStats } from "./live";

describe("woven bands", () => {
  it("weaves: each band goes over at least once and under at least once", () => {
    const w = wovenBands();
    expect(w.bands).toHaveLength(3);
    // Three pairwise crossings; every other one puts the earlier band on top.
    expect(w.overs.length).toBeGreaterThanOrEqual(1);
    const overIds = new Set(w.overs.map((o) => o.band.id));
    const lastId = w.bands[w.bands.length - 1]!.band.id;
    expect(overIds.has(lastId)).toBe(false);   // the last band is drawn on top already
    for (const o of w.overs) {
      expect(o.cx).toBeGreaterThan(0);
      expect(o.cx).toBeLessThan(w.width);
      expect(o.cy).toBeGreaterThan(0);
      expect(o.cy).toBeLessThan(w.height);
    }
  });

  it("is deterministic and self-contained (no external references)", () => {
    const a = wovenBandsSvg(), b = wovenBandsSvg();
    expect(a).toBe(b);
    expect(a).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(a).not.toContain("<image");
  });
});

describe("weave mark", () => {
  it("draws two vertical threads, two weft threads and two over-crossings", () => {
    const s = weaveMarkStrokes();
    expect(s.filter((x) => /V[\d.]+$/.test(x.d))).toHaveLength(6);
    expect(s.filter((x) => /H[\d.]+$/.test(x.d))).toHaveLength(4);
  });
});

describe("loom glyph field", () => {
  it("is seeded, denser on the right, and only rarely accented", () => {
    const g = loomGlyphs({ cols: 60, rows: 20, seed: 7 });
    expect(loomGlyphs({ cols: 60, rows: 20, seed: 7 })).toEqual(g);
    const left = g.glyphs.filter((x) => x.x < 20).length, right = g.glyphs.filter((x) => x.x >= 40).length;
    expect(right).toBeGreaterThan(left * 2);
    expect(g.glyphs.filter((x) => x.accent).length).toBeLessThan(g.glyphs.length / 10);
    expect(loomGlyphsSvg()).toContain("<svg");
  });
});

describe("landing stats", () => {
  it("uses live numbers when GET /v1/stats answers", () => {
    const s = toLandingStats({ employees: 49, contractors: 3, simulatedAgencies: 7, runsLogged: 12, actionsLogged: 40, realAgenciesContacted: 0, payrollsProcessed: 3 });
    expect(s).toEqual({ source: "live", employees: 49, simulatedAgencies: 7, runsLogged: 12, realAgenciesContacted: 0 });
  });

  it("falls back to the seed's numbers, labeled, when the route is down or a stub", () => {
    expect(toLandingStats(null)).toEqual(FALLBACK_STATS);
    expect(toLandingStats({ _tag: "NotImplemented" } as never)).toEqual(FALLBACK_STATS);
    expect(FALLBACK_STATS).toMatchObject({ source: "fallback", employees: 48, simulatedAgencies: 7, realAgenciesContacted: 0 });
  });
});
