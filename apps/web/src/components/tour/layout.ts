"use client";
// DOM measurements for the tour's ring and card (owner: tour): where a target can actually be seen (the viewport cut
// by every overflow-clipping ancestor, so the main pane under the sticky header, a table that scrolls sideways and
// the agent panel's thread all clip), which layer it lives in (so the ring paints just above that layer and under
// any popover or menu that opens later), whether another layer hides it, the content column the card may use, and
// the open app layers the card keeps clear of. Read once per animation frame while a step is showing.
import { useEffect, useRef, useState } from "react";
import { appMain } from "../app/shell/main-pane";
import { rectOf, type Rect } from "./geometry";

const TOUR_OWN = "[data-tour-ring],[data-tour-mark],[data-tour-card]";
/** Layers that hide what is under them (a popover over the target does not: the ring sits beneath it). */
const SHEET_LAYERS = 'aside[aria-label="Agent"], [role="dialog"], [role="alertdialog"], nav[aria-label="App"]';
/** App layers the card keeps clear of. */
const APP_LAYERS = '[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

export const viewportRect = (): Rect => ({ left: 0, top: 0, right: document.documentElement.clientWidth, bottom: window.innerHeight });

/** The viewport intersected with the padding box of every ancestor that clips overflow (up to a fixed layer). */
export function clipRectOf(el: Element): Rect {
  let r = viewportRect();
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
      const b = p.getBoundingClientRect();
      const inner = { left: b.left + p.clientLeft, top: b.top + p.clientTop, right: b.left + p.clientLeft + p.clientWidth, bottom: b.top + p.clientTop + p.clientHeight };
      r = { left: Math.max(r.left, inner.left), top: Math.max(r.top, inner.top), right: Math.min(r.right, inner.right), bottom: Math.min(r.bottom, inner.bottom) };
    }
    // A fixed layer escapes its ancestors' overflow.
    if (cs.position === "fixed") break;
  }
  return r;
}

/** The z-index of the outermost positioned ancestor that sets one: the layer the element paints in (0 for the page). */
export function layerZOf(el: Element): number {
  let z = 0;
  for (let p: Element | null = el; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.position !== "static" && cs.zIndex !== "auto") { const n = Number(cs.zIndex); if (Number.isFinite(n)) z = n; }
  }
  return z;
}

/**
 * The ring's z-index: just above the target's own layer, never below 45 (over sticky cells and the z-40 scrims) and
 * never at the card's 70. A target in the page gets 45, under every z-50 popover, menu and drawer, so a popover the
 * step opens over the target is never painted over.
 */
export const ringZFor = (layerZ: number): number => Math.min(69, Math.max(45, layerZ + 1));

const fullScreen = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  return r.width >= document.documentElement.clientWidth - 1 && r.height >= window.innerHeight - 1;
};

/** True when every sample point of the visible target is under another sheet-like layer (the phone's agent sheet). */
export function occluded(el: Element, vis: Rect): boolean {
  const w = vis.right - vis.left, h = vis.bottom - vis.top;
  const pts: [number, number][] = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(([fx, fy]) => [vis.left + w * fx!, vis.top + h * fy!]);
  for (const [x, y] of pts) {
    let hidden = false;
    for (const top of document.elementsFromPoint(x, y)) {
      if (top.closest(TOUR_OWN)) continue;
      if (el === top || el.contains(top) || top.contains(el)) break;
      if (top.closest("[data-radix-popper-content-wrapper]")) continue;
      if (fullScreen(top)) continue;
      const layer = top.closest(SHEET_LAYERS);
      hidden = !!layer && !layer.contains(el);
      break;
    }
    if (!hidden) return false;
  }
  return true;
}

/**
 * The column the card may use: the app's main pane (right of the sidebar, left of the agent panel docked or overlaid),
 * from the top of the window when the target sits in the header. Outside the app shell (the portal) the viewport.
 */
export function contentBounds(target: Rect | null): Rect {
  const vp = viewportRect();
  const main = appMain();
  if (!main) return vp;
  const m = main.getBoundingClientRect();
  let right = Math.min(vp.right, m.right);
  const agent = document.querySelector('aside[aria-label="Agent"]');
  if (agent) { const a = agent.getBoundingClientRect(); if (a.width > 0 && a.left > m.left + 1 && a.left < right) right = a.left; }
  return { left: Math.max(0, m.left), top: target && target.top < m.top ? 0 : Math.max(0, m.top), right, bottom: Math.min(vp.bottom, m.bottom) };
}

/** Open app popovers, menus and drawers (not the tour's own), as rects. */
export function appLayerRects(): Rect[] {
  const out: Rect[] = [];
  for (const n of document.querySelectorAll(APP_LAYERS)) {
    if (n.closest(TOUR_OWN) || n.querySelector("[data-tour-card]")) continue;
    const r = n.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || fullScreen(n)) continue;
    out.push(rectOf(r));
  }
  return out;
}

/** Closes the newest open app popover (not the tour's card) through its trigger; false when none is open. */
export function closeAppPopover(): boolean {
  const open = [...document.querySelectorAll<HTMLElement>("[data-radix-popper-content-wrapper]")].filter((w) => !w.querySelector("[data-tour-card]"));
  for (const w of open.reverse()) {
    const id = w.firstElementChild?.id;
    const trigger = id ? document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(id)}"][aria-expanded="true"]`) : null;
    if (trigger) { trigger.click(); return true; }
  }
  return false;
}

/** The visible part of an element (null when it is gone, empty, clipped away or hidden under another layer). */
export function visibleRect(el: Element | null): Rect | null {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  const c = clipRectOf(el);
  const v = { left: Math.max(r.left, c.left), top: Math.max(r.top, c.top), right: Math.min(r.right, c.right), bottom: Math.min(r.bottom, c.bottom) };
  return v.right > v.left && v.bottom > v.top ? v : null;
}

/**
 * Runs `read` once per animation frame while mounted and keeps its result in state, updating only when `same` says
 * it changed: one rect read per frame tracks a target through scroll, resize, layout shifts, text and attribute
 * changes and CSS transitions alike, none of which every observer catches.
 */
export function useFrameValue<T>(read: () => T, same: (a: T, b: T) => boolean, deps: unknown[], onFrame?: (v: T) => void): T {
  const readRef = useRef(read);
  readRef.current = read;
  const frameRef = useRef(onFrame);
  frameRef.current = onFrame;
  const sameRef = useRef(same);
  sameRef.current = same;
  const [value, setValue] = useState<T>(() => (typeof window === "undefined" ? (undefined as T) : read()));
  useEffect(() => {
    let raf = 0;
    let last = readRef.current();
    setValue(last);
    const tick = () => {
      const next = readRef.current();
      // The caller may write the value to the DOM in the same frame it was read (the ring's box), so it never paints
      // a frame behind what it follows; the state update after it re-renders the same values.
      if (!sameRef.current(last, next)) { last = next; frameRef.current?.(next); setValue(next); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

/** The agent panel's rect when it is docked beside the page (a grid column), null when closed or an overlay. */
export function dockedPanelRect(): Rect | null {
  const aside = document.querySelector<HTMLElement>('aside[aria-label="Agent"]');
  if (!aside || aside.closest(".fixed")) return null;
  const r = aside.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? rectOf(r) : null;
}
