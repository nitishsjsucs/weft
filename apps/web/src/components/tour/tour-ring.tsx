"use client";
// The ring around the tour's target (owner: tour): a fixed, pointer-events-none box 4 px outside the target's rect,
// tracked through ResizeObserver and capture-phase scroll listeners and clamped to the viewport. Secondary marks
// get a dashed outline. No dimming scrim, so the page stays usable and nothing fights the app's own layers.
import { useEffect, useState } from "react";

interface Box { top: number; left: number; width: number; height: number }

function boxOf(el: Element, pad: number): Box | null {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const left = Math.max(2, r.left - pad);
  const top = Math.max(2, r.top - pad);
  const right = Math.min(vw - 2, r.right + pad);
  const bottom = Math.min(vh - 2, r.bottom + pad);
  if (right <= left || bottom <= top) return null;
  return { top, left, width: right - left, height: bottom - top };
}

/** Re-measures an element on resize, scroll (any container) and DOM changes; returns null when it is gone. */
export function useTrackedBox(el: Element | null, pad: number): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useEffect(() => {
    if (!el) { setBox(null); return; }
    let raf = 0;
    const measure = () => { raf = 0; setBox(el.isConnected ? boxOf(el, pad) : null); };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    ro.observe(document.documentElement);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => { ro.disconnect(); mo.disconnect(); window.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); if (raf) cancelAnimationFrame(raf); };
  }, [el, pad]);
  return box;
}

export function TourRing({ target, found, secondary }: { target: Element | null; found: boolean; secondary: Element[] }) {
  const box = useTrackedBox(found ? target : null, 4);
  return (
    <>
      {box ? (
        <div
          aria-hidden
          data-tour-ring=""
          data-target-found={found ? "true" : "false"}
          className="weft-tour-ring pointer-events-none fixed z-[70] rounded-[10px]"
          style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
        />
      ) : null}
      {secondary.map((el, i) => <SecondaryMark key={i} el={el} />)}
    </>
  );
}

function SecondaryMark({ el }: { el: Element }) {
  const box = useTrackedBox(el, 2);
  if (!box) return null;
  return <div aria-hidden data-tour-mark="" className="weft-tour-mark pointer-events-none fixed z-[70] rounded-[8px]" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} />;
}
