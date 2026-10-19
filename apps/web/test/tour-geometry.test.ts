// The tour's ring and card geometry (owner: tour). Pure: no DOM, no React.
import { describe, expect, it } from "vitest";
import { overlapArea, placeCard, ringBox, type Rect } from "../src/components/tour/geometry";
import { sideOrder } from "../src/components/tour/tour-card";

const r = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom });
const cardRect = (p: { left: number; top: number; width?: number }, h: number, w = 360): Rect => r(p.left, p.top, p.left + (p.width ?? w), p.top + h);

describe("ringBox", () => {
  it("pads a fully visible target and marks no side as clipped", () => {
    expect(ringBox(r(100, 100, 300, 200), r(0, 48, 1000, 800), 4)).toEqual({ box: r(96, 96, 304, 204), clipped: [] });
  });
  it("cuts the ring at the pane edge and names the sides the target runs past", () => {
    // Scrolled under the 48 px header and past the bottom of the pane.
    const out = ringBox(r(100, 20, 300, 900), r(0, 48, 1000, 800), 4)!;
    expect(out.box).toEqual(r(96, 48, 304, 800));
    expect(out.clipped).toEqual(["top", "bottom"]);
  });
  it("is null when nothing of the target is visible", () => {
    expect(ringBox(r(100, 900, 300, 1000), r(0, 48, 1000, 800), 4)).toBeNull();
  });
});

describe("placeCard", () => {
  // The 1280x800 shell: sidebar 0-244, main 244-940 from y 48, the agent panel docked from 940.
  const main = r(244, 48, 940, 800);
  const card = { width: 360, height: 216 };

  it("never covers an open popover: the payroll flags step goes above the group when the popover drops below", () => {
    const group = r(282, 288, 903, 561);
    const popover = r(458, 376, 818, 698);
    const p = placeCard({ target: group, card, bounds: main, obstacles: [popover], avoid: [], order: sideOrder("side", false) })!;
    expect(p.side).toBe("top");
    expect(p.cost).toBe(0);
    expect(overlapArea(cardRect(p, 216), popover)).toBe(0);
    expect(overlapArea(cardRect(p, 216), group)).toBe(0);
  });

  it("stays inside the content column: never over the sidebar or the docked panel", () => {
    // A target near the left edge of main: centred below it the card would reach into the sidebar.
    const badge = r(277, 163, 454, 187);
    const p = placeCard({ target: badge, card, bounds: main, obstacles: [], avoid: [], order: sideOrder(undefined, false) })!;
    expect(p.left).toBeGreaterThanOrEqual(main.left);
    expect(p.left + 360).toBeLessThanOrEqual(main.right);
  });

  it("puts the card left of a target in the agent panel, in the main column", () => {
    const composer = r(953, 688, 1268, 788);
    const p = placeCard({ target: composer, card, bounds: main, obstacles: [], avoid: [], order: sideOrder(undefined, true) })!;
    expect(p.side).toBe("left");
    expect(p.left + 360).toBeLessThanOrEqual(940);
  });

  it("narrows beside a tall target rather than covering it", () => {
    const tall = r(277, 84, 586, 765);
    const p = placeCard({ target: tall, card, bounds: main, obstacles: [], avoid: [], order: sideOrder(undefined, false), minWidth: 300 })!;
    expect(p.cost).toBe(0);
    expect(p.width).toBeGreaterThanOrEqual(300);
    expect(overlapArea(cardRect(p, 216), tall)).toBe(0);
  });

  it("keeps clear of secondary marks when a clean spot exists", () => {
    const tabs = r(277, 191, 908, 227);
    const pay = r(277, 258, 908, 520);
    const p = placeCard({ target: tabs, card, bounds: main, obstacles: [], avoid: [pay], order: sideOrder(undefined, false) })!;
    expect(overlapArea(cardRect(p, 216), pay)).toBe(0);
    expect(overlapArea(cardRect(p, 216), tabs)).toBe(0);
  });

  it("moves clear of a menu opened over the spot it was using", () => {
    const pill = r(579, 8, 888, 40);
    const before = placeCard({ target: pill, card, bounds: r(244, 0, 940, 800), obstacles: [], avoid: [], order: sideOrder(undefined, false) })!;
    const menu = r(640, 46, 888, 400);
    const after = placeCard({ target: pill, card, bounds: r(244, 0, 940, 800), obstacles: [menu], avoid: [], order: sideOrder(undefined, false), prev: before.side })!;
    expect(overlapArea(cardRect(after, 216), menu)).toBe(0);
  });

  it("is null when the column is narrower than the card (the caller docks a sheet)", () => {
    expect(placeCard({ target: r(10, 100, 200, 140), card, bounds: r(0, 0, 300, 800), obstacles: [], avoid: [], order: ["bottom"] })).toBeNull();
  });
});
