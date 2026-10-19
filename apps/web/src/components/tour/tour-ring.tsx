"use client";
// The ring around the tour's target (owner: tour): a fixed, pointer-events-none box 4 px outside the target, read
// once per animation frame (layout.ts), cut to where the target can actually be seen, and painted just above the
// target's own layer: z 45 for page content, so popovers, menus and drawers (z 50) the step opens sit on top of it.
// A side where the target runs on past the visible area fades out instead of drawing an edge. A target hidden under
// another layer (the phone's agent sheet) gets no ring. Secondary marks get a dashed outline. No dimming scrim.
import { useRef } from "react";
import { intersect, rectOf, ringBox, sameRect, tightSides, type Rect, type Side } from "./geometry";
import { clipRectOf, layerZOf, occluded, ringZFor, useFrameValue } from "./layout";

export interface RingMeasure { box: Rect; clipped: Side[]; tight: Side[]; z: number }

function measure(el: Element | null, pad: number): RingMeasure | null {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  const clip = clipRectOf(el);
  const rb = ringBox(r, clip, pad);
  const vis = intersect(rectOf(r), clip);
  if (!rb || !vis || occluded(el, vis)) return null;
  return { box: rb.box, clipped: rb.clipped, tight: tightSides(rectOf(r), rb.box, rb.clipped, pad), z: ringZFor(layerZOf(el)) };
}

const same = (a: RingMeasure | null, b: RingMeasure | null): boolean =>
  a === b || (!!a && !!b && a.z === b.z && a.clipped.join() === b.clipped.join() && a.tight.join() === b.tight.join() && sameRect(a.box, b.box));

/**
 * The ring box for an element, re-read every frame; null when it is gone, clipped away or hidden. `node` (the ring's
 * own element) gets its box written in the frame the target was read, so it moves with a scroll or a transition in
 * the same frame instead of one behind it, while React's re-render catches up with the rest.
 */
export function useRing(el: Element | null, pad: number, node?: { current: HTMLElement | null }): RingMeasure | null {
  return useFrameValue(() => measure(el, pad), same, [el, pad], (m) => {
    const n = node?.current;
    if (!n || !m) return;
    n.style.top = `${m.box.top}px`; n.style.left = `${m.box.left}px`;
    n.style.width = `${m.box.right - m.box.left}px`; n.style.height = `${m.box.bottom - m.box.top}px`;
  });
}

const FADE: Record<Side, string> = {
  top: "linear-gradient(to bottom, transparent, #000 20px)",
  bottom: "linear-gradient(to top, transparent, #000 20px)",
  left: "linear-gradient(to right, transparent, #000 20px)",
  right: "linear-gradient(to left, transparent, #000 20px)",
};

function styleOf(m: RingMeasure): React.CSSProperties {
  const s: React.CSSProperties = { top: m.box.top, left: m.box.left, width: m.box.right - m.box.left, height: m.box.bottom - m.box.top, zIndex: m.z };
  // A side whose pad a clipping parent took away keeps only the inset halo, so no border runs along the target's edge.
  for (const t of m.tight) (s as Record<string, unknown>)[`border${t[0]!.toUpperCase()}${t.slice(1)}Color`] = "transparent";
  if (m.clipped.length) {
    const mask = m.clipped.map((c) => FADE[c]).join(", ");
    Object.assign(s, { maskImage: mask, WebkitMaskImage: mask, maskComposite: "intersect", WebkitMaskComposite: "source-in" });
    for (const c of m.clipped) {
      const corners = c === "top" ? ["TopLeft", "TopRight"] : c === "bottom" ? ["BottomLeft", "BottomRight"] : c === "left" ? ["TopLeft", "BottomLeft"] : ["TopRight", "BottomRight"];
      for (const k of corners) (s as Record<string, unknown>)[`border${k}Radius`] = 0;
    }
  }
  return s;
}

export function TourRing({ target, found, secondary }: { target: Element | null; found: boolean; secondary: Element[] }) {
  const node = useRef<HTMLDivElement | null>(null);
  const m = useRing(found ? target : null, 4, node);
  return (
    <>
      {m ? (
        <div
          ref={node}
          aria-hidden
          data-tour-ring=""
          data-target-found={found ? "true" : "false"}
          data-clip={m.clipped.join(" ")}
          data-tight={m.tight.join(" ")}
          className="weft-tour-ring pointer-events-none fixed rounded-[10px]"
          style={styleOf(m)}
        />
      ) : null}
      {secondary.map((el, i) => <SecondaryMark key={i} el={el} />)}
    </>
  );
}

function SecondaryMark({ el }: { el: Element }) {
  const node = useRef<HTMLDivElement | null>(null);
  const m = useRing(el, 2, node);
  if (!m) return null;
  return <div ref={node} aria-hidden data-tour-mark="" data-clip={m.clipped.join(" ")} className="weft-tour-mark pointer-events-none fixed rounded-[8px]" style={styleOf(m)} />;
}
