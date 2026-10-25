"use client";
// The cursor context from the live page (context-core.ts holds the pure parts): one passive pointermove listener, read
// once a frame, keeps where the pointer is and the hover trail of the records it rested on; `captureStart` takes what
// the pointer is on, what is selected and what has focus when a question starts (before the composer takes focus),
// and `buildCursor` assembles ext/assist.ts AssistCursor from it when the question is sent. A label that came from
// text people typed is left out (an empty label), never sent as if the app wrote it.
import { SCREEN_LIMITS, type AssistCursor, type EntityRef } from "../../../../../packages/contracts/src/ext/assist";
import { mountedQueries } from "@/lib/api/hooks";
import { createHoverTrail, keyboardOrigin, viewFromLocation } from "./context-core";
import { recordName } from "./records-core";
import { entityAround, entityAt, entityOfEl, kindOf, labelOf, openLayer, OWN, selectedText, type Registered } from "./dom";

const hover = createHoverTrail();
let last: { x: number; y: number } | null = null;
/** When the pointer last moved, and when keyboard navigation (Tab, the arrow keys) last moved focus on the page. */
let movedAt: number | null = null;
let focusedAt: number | null = null;

/** Where the pointer was last seen in this window, or null before it moved. */
export function lastPointer(): { x: number; y: number } | null { return last; }

/** Tracks the pointer and the hover trail while the assistant is mounted; returns the stop function. */
export function startCursorTracking(route: () => string): () => void {
  let raf = 0;
  const read = () => {
    raf = 0;
    if (last) hover.update(entityAt(last.x, last.y, route()), performance.now());
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    last = { x: e.clientX, y: e.clientY };
    movedAt = performance.now();
    if (!raf) raf = requestAnimationFrame(read);
  };
  // Focus that the keyboard moved (not focus the app put back after a dialog closed): a key that moves focus, then the
  // focus it brought, within a moment.
  let navKeyAt = -Infinity;
  const onKey = (e: KeyboardEvent) => { if (e.key === "Tab" || e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") navKeyAt = performance.now(); };
  const onFocus = (e: FocusEvent) => {
    const t = e.target;
    if (t instanceof Element && !t.closest(OWN) && performance.now() - navKeyAt < 500) focusedAt = performance.now();
  };
  window.addEventListener("pointermove", onMove, { passive: true });
  window.addEventListener("keydown", onKey, { capture: true, passive: true });
  document.addEventListener("focusin", onFocus);
  return () => {
    window.removeEventListener("pointermove", onMove); window.removeEventListener("keydown", onKey, { capture: true }); document.removeEventListener("focusin", onFocus);
    cancelAnimationFrame(raf); hover.clear();
  };
}

/** What the page held when a question started: the record under the point, the selection and the focused control. */
export interface CursorStart { under: EntityRef | null; selection: { text: string; node: Node | null } | null; focus: Element | null }

/** `selection`: what the page held selected before the browser changed it (a right-click on macOS); else read now. */
export function captureStart(at: { x: number; y: number } | null, route: string, around?: Element | null, selection?: CursorStart["selection"]): CursorStart {
  const a = typeof document !== "undefined" ? document.activeElement : null;
  const under = around ? entityAround(around, route) : at ? entityAt(at.x, at.y, route) : null;
  // The record's own name from the page's data, when it has one, rather than every word of its row.
  const name = under ? recordName(mountedQueries(), under.entity) : null;
  return {
    under: under && name ? { ...under, label: name } : under,
    selection: selection === undefined ? selectedText() : selection,
    focus: a && a !== document.body && !a.closest(OWN) ? a : null,
  };
}

/**
 * A composer opened from the keyboard: placed at the focused control and about its record when keyboard navigation
 * moved focus there after the pointer last moved (or the pointer never did), else at the pointer as a click would be.
 */
export function keyboardStart(route: string): { at: { x: number; y: number } | null; start: CursorStart } {
  const a = document.activeElement;
  const focusEl = a instanceof HTMLElement && a !== document.body && !a.closest(OWN) ? a : null;
  const origin = keyboardOrigin({ pointerAt: last ? movedAt : null, focusAt: focusedAt, focused: !!focusEl });
  if (origin === "focus" && focusEl) {
    const r = focusEl.getBoundingClientRect();
    return { at: { x: Math.round(r.left + Math.min(24, r.width / 2)), y: Math.round(r.bottom) }, start: captureStart(null, route, focusEl) };
  }
  return { at: last, start: captureStart(last, route) };
}

/** The nearest tagged record that holds a node (a selection's start). */
function entityOfNode(node: Node | null, route: string): string | null {
  for (let el: Element | null = node instanceof Element ? node : node?.parentElement ?? null; el && el !== document.body; el = el.parentElement) {
    const e = entityOfEl(el, route);
    if (e) return e.entity;
  }
  return null;
}

/** AssistCursor for a question: `start` from when it began, the screen map's registry for the [n] of each record. */
export function buildCursor(start: CursorStart, registry: Map<number, Registered>, pathname: string, search: string): AssistCursor {
  const route = `${pathname}${search}`;
  const nOf = (entity: string): number | null => [...registry.entries()].find(([, r]) => r.item.entity === entity)?.[0] ?? null;
  const held = mountedQueries();
  const ref = (r: EntityRef): EntityRef => ({ entity: r.entity, kind: r.kind.slice(0, 24), label: (recordName(held, r.entity) ?? r.label).slice(0, SCREEN_LIMITS.label * 2), n: nOf(r.entity) });
  const under = start.under ? ref(start.under) : null;
  const trail = hover.list(performance.now()).filter((r) => r.entity !== under?.entity).slice(0, SCREEN_LIMITS.hoverTrail).map(ref);
  let focused: AssistCursor["focused"] = null;
  const f = start.focus;
  if (f && f.isConnected) {
    const l = labelOf(f);
    focused = { kind: kindOf(f).slice(0, 24), label: l.untrusted ? "" : l.label.slice(0, SCREEN_LIMITS.label * 2), n: [...registry.entries()].find(([, r]) => r.el === f)?.[0] ?? null };
  }
  return {
    under, trail,
    selection: start.selection ? { text: start.selection.text.slice(0, SCREEN_LIMITS.selection), entity: entityOfNode(start.selection.node, route) } : null,
    focused,
    layer: openLayer(),
    view: viewFromLocation(pathname, search),
  };
}
