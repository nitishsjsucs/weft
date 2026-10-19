// Pure geometry for the tour's ring and card (owner: tour). No DOM, so vitest covers it directly. Rects are in CSS
// pixels relative to the viewport, edges rather than width and height, so intersections stay simple.

export interface Rect { left: number; top: number; right: number; bottom: number }
export type Side = "top" | "right" | "bottom" | "left";

export const rectOf = (r: { left: number; top: number; right: number; bottom: number }): Rect => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
export const widthOf = (r: Rect): number => r.right - r.left;
export const heightOf = (r: Rect): number => r.bottom - r.top;
export const inflate = (r: Rect, d: number): Rect => ({ left: r.left - d, top: r.top - d, right: r.right + d, bottom: r.bottom + d });

export function intersect(a: Rect, b: Rect): Rect | null {
  const r = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return r.right > r.left && r.bottom > r.top ? r : null;
}

export function overlapArea(a: Rect, b: Rect): number {
  const r = intersect(a, b);
  return r ? widthOf(r) * heightOf(r) : 0;
}

export const sameRect = (a: Rect | null, b: Rect | null, eps = 0.5): boolean =>
  a === b || (!!a && !!b && Math.abs(a.left - b.left) < eps && Math.abs(a.top - b.top) < eps && Math.abs(a.right - b.right) < eps && Math.abs(a.bottom - b.bottom) < eps);

/**
 * The ring's box: the target padded by `pad`, cut to the area where the target can be seen (`clip`, the viewport
 * intersected with every overflow-clipping ancestor). `clipped` names the sides where the target runs on past what
 * is visible, so the ring can fade that edge instead of drawing a border that reads as the target's end.
 */
export function ringBox(target: Rect, clip: Rect, pad: number): { box: Rect; clipped: Side[] } | null {
  const visible = intersect(target, clip);
  if (!visible) return null;
  const box = intersect(inflate(target, pad), clip);
  if (!box) return null;
  const clipped: Side[] = [];
  if (target.top < clip.top - 0.5) clipped.push("top");
  if (target.right > clip.right + 0.5) clipped.push("right");
  if (target.bottom > clip.bottom + 0.5) clipped.push("bottom");
  if (target.left < clip.left - 0.5) clipped.push("left");
  return { box, clipped };
}

/**
 * Sides where an overflow-clipping parent took the ring's pad away although the target itself is fully visible there
 * (a matrix row at the scroll box's edge): a border drawn there would run along the target's own edge, so the ring
 * draws only its inset halo on those sides.
 */
export function tightSides(target: Rect, box: Rect, clipped: Side[], pad: number): Side[] {
  const room: Record<Side, number> = { top: target.top - box.top, right: box.right - target.right, bottom: box.bottom - target.bottom, left: target.left - box.left };
  return (["top", "right", "bottom", "left"] as const).filter((sd) => !clipped.includes(sd) && room[sd] < pad - 1);
}

export interface PlaceInput {
  /** The visible part of the target, or null for an unanchored card. */
  target: Rect | null;
  card: { width: number; height: number };
  /** Where the card may go: the content column (right of the sidebar, left of the agent panel). */
  bounds: Rect;
  /** Open app layers (popovers, menus, drawers): the card never covers them when anything else fits. */
  obstacles: Rect[];
  /** Secondary marks and context the copy names: covered only when nothing cleaner fits. */
  avoid: Rect[];
  /** Sides to try, best first. */
  order: Side[];
  /** The side used last frame, kept while it still fits cleanly (no jumping while the page scrolls). */
  prev?: Side | "free" | null;
  gap?: number;
  pad?: number;
  /** Beside a target, the card may narrow down to this width to fit (default: no narrowing). */
  minWidth?: number;
}

/** `width` is set when the card narrows to fit beside the target. */
export interface Placement { left: number; top: number; side: Side | "free"; cost: number; width?: number }

const uniq = (xs: number[]): number[] => [...new Set(xs.map((x) => Math.round(x)))];
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Where the tour card goes: next to the target on the first side in `order` that fits inside `bounds` without
 * covering the target, an open layer or a secondary mark; failing that, the free spot in `bounds` that covers the
 * least (target and layers weigh most). Null when the card does not fit in `bounds` at all (the caller docks a sheet).
 */
export function placeCard(i: PlaceInput): Placement | null {
  const gap = i.gap ?? 12, pad = i.pad ?? 12;
  const W = i.card.width, h = i.card.height;
  const minX = i.bounds.left + pad, minY = i.bounds.top + pad, maxY = i.bounds.bottom - pad - h;
  const maxXFor = (w: number) => i.bounds.right - pad - w;
  if (maxXFor(Math.min(W, i.minWidth ?? W)) < minX || maxY < minY) return null;
  const t = i.target;
  const blockers = [...i.obstacles, ...i.avoid];
  const cost = (left: number, top: number, w: number): number => {
    const c: Rect = { left, top, right: left + w, bottom: top + h };
    let n = t ? overlapArea(c, inflate(t, 6)) * 10 : 0;
    for (const o of i.obstacles) n += overlapArea(c, o) * 10;
    for (const a of i.avoid) n += overlapArea(c, a) * 3;
    return n;
  };
  type Cand = { left: number; top: number; w: number; side: Side | "free"; rank: number; dist: number };
  const cands: Cand[] = [];
  const dist = (left: number, top: number, w: number) => (t ? Math.hypot(left + w / 2 - (t.left + t.right) / 2, top + h / 2 - (t.top + t.bottom) / 2) : 0);
  const push = (left: number, top: number, w: number, side: Side | "free", rank: number) => cands.push({ left, top, w, side, rank, dist: dist(left, top, w) });
  if (t) {
    i.order.forEach((side, r) => {
      const rank = side === i.prev ? -1 : r;
      if (side === "top" || side === "bottom") {
        if (maxXFor(W) < minX) return;
        const y = clamp(side === "bottom" ? t.bottom + gap : t.top - gap - h, minY, maxY);
        const xs = [t.left, (t.left + t.right) / 2 - W / 2, t.right - W, ...blockers.flatMap((o) => [o.right + gap, o.left - gap - W])].map((x) => clamp(x, minX, maxXFor(W)));
        for (const x of uniq(xs)) push(x, y, W, side, rank);
      } else {
        // Beside the target: full width when it fits, else as narrow as minWidth allows.
        const room = side === "right" ? i.bounds.right - pad - (t.right + gap) : t.left - gap - minX;
        const w = room >= W ? W : room >= (i.minWidth ?? W) ? Math.floor(room) : W;
        if (maxXFor(w) < minX) return;
        const x = clamp(side === "right" ? t.right + gap : t.left - gap - w, minX, maxXFor(w));
        const ys = [t.top, (t.top + t.bottom) / 2 - h / 2, t.bottom - h, ...blockers.flatMap((o) => [o.bottom + gap, o.top - gap - h])].map((y) => clamp(y, minY, maxY));
        for (const y of uniq(ys)) push(x, y, w, side, rank);
      }
    });
  }
  // Free spots: the corners, edge midpoints and centre of the bounds, plus spots just clear of each blocker (narrowed
  // down to minWidth when a full-width card does not fit beside it).
  const fy = [minY, (minY + maxY) / 2, maxY, ...(t ? [t.bottom + gap, t.top - gap - h] : []), ...blockers.flatMap((o) => [o.bottom + gap, o.top - gap - h])].map((y) => clamp(y, minY, maxY));
  const fxw: [number, number][] = [];
  if (maxXFor(W) >= minX) {
    const maxX = maxXFor(W);
    for (const x of [minX, (minX + maxX) / 2, maxX, ...blockers.flatMap((o) => [o.right + gap, o.left - gap - W])]) fxw.push([clamp(x, minX, maxX), W]);
  }
  for (const o of blockers) {
    const leftRoom = Math.floor(o.left - gap - minX), rightRoom = Math.floor(i.bounds.right - pad - (o.right + gap));
    if (leftRoom < W && leftRoom >= (i.minWidth ?? W)) fxw.push([minX, leftRoom]);
    if (rightRoom < W && rightRoom >= (i.minWidth ?? W)) fxw.push([o.right + gap, rightRoom]);
  }
  const seen = new Set<string>();
  for (const [x, w] of fxw) for (const y of uniq(fy)) {
    const k = `${Math.round(x)}:${Math.round(y)}:${w}`;
    if (seen.has(k)) continue;
    seen.add(k);
    push(x, y, w, "free", i.order.length + (i.prev === "free" ? -0.5 : 0));
  }

  let best: (Cand & { cost: number }) | null = null;
  for (const c of cands) {
    const k = { ...c, cost: Math.round(cost(c.left, c.top, c.w)) };
    if (!best || k.cost < best.cost || (k.cost === best.cost && (k.rank < best.rank || (k.rank === best.rank && k.dist < best.dist)))) best = k;
  }
  if (!best) return null;
  return { left: best.left, top: best.top, side: best.side, cost: best.cost, ...(best.w !== W ? { width: best.w } : {}) };
}

/**
 * Which edge a phone sheet docks to: the step's own edge, unless the sheet there would cover the target or an open
 * app layer (a menu, a popover) and the other edge is clear of both. With no clear edge it keeps its edge and, when it
 * would cover an open layer, drops under the app's layers (z 49), as the anchored card does. The sheet spans the
 * window inside 16 px gutters, below the header at the top or 16 px above the bottom.
 */
export function sheetEdge(pref: "top" | "bottom", target: Rect | null, layers: Rect[], height: number, vp: { width: number; height: number; headerH: number }): { top: boolean; under: boolean } {
  const at = (top: boolean): Rect => (top
    ? { left: 16, top: vp.headerH + 8, right: vp.width - 16, bottom: vp.headerH + 8 + height }
    : { left: 16, top: vp.height - 16 - height, right: vp.width - 16, bottom: vp.height - 16 });
  const layerCost = (r: Rect) => layers.reduce((n, o) => n + overlapArea(r, o), 0);
  const cost = (r: Rect) => (target ? overlapArea(r, target) : 0) + layerCost(r);
  const mine = at(pref === "top"), other = at(pref !== "top");
  const flip = cost(mine) > 1 && cost(other) <= 1;
  return { top: flip ? pref !== "top" : pref === "top", under: layerCost(flip ? other : mine) > 1 };
}

/**
 * The card's spot in the docked agent panel's column (steps with `dockPanel`): bottom-aligned inside the panel with
 * a 12 px pad, as wide as the card or the panel allows. Null when the panel is not docked to the right of the main
 * column or is too narrow for a 260 px card. Popovers in main never reach it, so its buttons are never covered.
 */
export function panelSpot(panel: Rect | null, main: Rect | null, card: { width: number; height: number }, pad = 12): { left: number; top: number; width: number } | null {
  if (!panel || !main) return null;
  if (panel.left < main.right - 1) return null;
  const width = Math.min(card.width, widthOf(panel) - 2 * pad);
  if (width < 260) return null;
  const top = Math.max(panel.top + pad, panel.bottom - pad - card.height);
  return { left: Math.round(panel.left + (widthOf(panel) - width) / 2), top: Math.round(top), width: Math.floor(width) };
}
