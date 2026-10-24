"use client";
// The cursor assistant's visuals (research/cursor-assistant.md 4.5): the small icon that floats a few pixels from the
// pointer, the pointer that glides to a target along a short curve and rings it with the guided tour's ring and a
// two-to-four-word label, and the small Weft menu a single right-click opens. They reuse the tour's ring, geometry
// and reduced-motion rules, so the assistant and the tour look like one system.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Copy, MessageCircleQuestion, Sparkles } from "lucide-react";
import { cn } from "@weft/ui";
import { ASSIST_TID } from "../../../../../packages/contracts/src/ext/assist";
import { placeCard, rectOf, type Rect } from "../tour/geometry";
import { TourRing } from "../tour/tour-ring";
import { reducedMotion } from "../tour/dom";
import { ASSIST_COPY } from "./copy";

/**
 * The open modal layer (a drawer or dialog) the assistant's interactive surfaces must live inside, or null. A modal
 * Radix dialog turns pointer events off on the body, hides its siblings from assistive tech and keeps focus inside
 * itself, so a card left outside it could not be clicked, read or typed into; portaled into the layer it can. The
 * cards are fixed in viewport pixels, so a layer is centred without a transform (a transform or translate would make
 * it their containing block and offset them, and its overflow would clip them).
 */
export function useLayerHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let raf = 0;
    const find = () => {
      raf = 0;
      const modal = document.body.style.pointerEvents === "none";
      const layers = modal ? [...document.querySelectorAll<HTMLElement>("[role=dialog][data-state=open],[role=alertdialog][data-state=open]")].filter((d) => !d.closest("[data-assist-ui]")) : [];
      setHost(layers.at(-1) ?? null);
    };
    find();
    const obs = new MutationObserver(() => { if (!raf) raf = requestAnimationFrame(find); });
    obs.observe(document.body, { childList: true, attributes: true, attributeFilter: ["style"] });
    return () => { obs.disconnect(); cancelAnimationFrame(raf); };
  }, []);
  return host;
}

/**
 * Renders inside the open modal layer when there is one (useLayerHost), else at the end of the body. Always through
 * one container element that moves between them, so a drawer opening or closing never remounts what is inside (a
 * walkthrough keeps its step, an answer the person decided keeps its state, the pointer does not glide again).
 */
export function InLayer({ host, children }: { host: HTMLElement | null; children: ReactNode }) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const d = document.createElement("div");
    d.setAttribute("data-assist-layer", "");
    // No box of its own: a drawer that lays its children out in a grid or a flex row is not changed by it.
    d.style.display = "contents";
    setBox(d);
    return () => d.remove();
  }, []);
  useLayoutEffect(() => {
    const to = host ?? document.body;
    if (!box || box.parentElement === to) return;
    to.appendChild(box);
    // A modal layer hides the body's other children from assistive tech as it opens (aria-hidden), the container
    // among them while it still sat there; inside the layer it is the layer's own, so the mark comes off with it
    // (the layer's undo only removes the attribute, so it finds nothing amiss).
    if (host) { box.removeAttribute("aria-hidden"); box.removeAttribute("data-aria-hidden"); }
  }, [box, host]);
  // A layer that closes takes the container out with it; it goes back to the body before the next paint.
  useEffect(() => {
    if (!box) return;
    const obs = new MutationObserver(() => { if (!box.isConnected) document.body.appendChild(box); });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [box]);
  return box ? createPortal(children, box) : null;
}

/** Two rects within half a pixel of each other (or both absent). */
export function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.right - b.right) < 0.5 && Math.abs(a.bottom - b.bottom) < 0.5;
}

/**
 * An element's rect, read once a frame while it is given (as the tour's ring follows its target): through a scroll,
 * a resize or a layout shift, the label bubble, the pointer and the card that avoids it move with what is ringed.
 * Null when there is none or it left the page; no frame loop runs without one.
 */
export function useTrackedRect(el: Element | null): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    if (!el) { setRect(null); return; }
    let raf = 0;
    let last: Rect | null = null;
    const read = () => {
      const next = el.isConnected ? rectOf(el.getBoundingClientRect()) : null;
      if (!sameRect(last, next)) { last = next; setRect(next); }
    };
    const tick = () => { read(); raf = requestAnimationFrame(tick); };
    read();
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [el]);
  return el ? rect : null;
}

/** Where a small floating card goes near a point: beside it, inside the window, clear of `avoid` (the ringed target). */
export function placeNear(at: { x: number; y: number }, size: { width: number; height: number }, avoid: Rect | null): { left: number; top: number } {
  const vp: Rect = { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: window.innerHeight };
  const target: Rect = { left: at.x - 8, top: at.y - 8, right: at.x + 16, bottom: at.y + 24 };
  const p = placeCard({ target, card: size, bounds: vp, obstacles: avoid ? [avoid] : [], avoid: [], order: ["bottom", "right", "top", "left"], gap: 10, pad: 12 });
  return p ? { left: p.left, top: p.top } : { left: Math.max(12, Math.min(vp.right - size.width - 12, at.x + 16)), top: Math.max(12, Math.min(vp.bottom - size.height - 12, at.y + 20)) };
}

/** A fixed card positioned near a point (or as a bottom sheet on a phone), measured after each render. */
/**
 * `focusKey`: the card takes keyboard focus once it is placed, and again when the key changes (a new question in the
 * same card), so its controls are the next Tab stops instead of the end of the page.
 */
export function FloatingCard({ at, avoid, sheet, children, testId, label, live, focusKey }: { at: { x: number; y: number }; avoid: Rect | null; sheet: boolean; children: ReactNode; testId: string; label: string; live?: boolean; focusKey?: number | string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const placed = sheet || pos !== null;
  useEffect(() => {
    if (focusKey === undefined || !placed) return;
    const el = ref.current;
    // Unless focus is already inside it (the person is on one of its buttons).
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [focusKey, placed]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || sheet) return;
    const measure = () => { const r = el.getBoundingClientRect(); setPos(placeNear(at, { width: r.width || 340, height: r.height || 120 }, avoid)); };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [at.x, at.y, avoid?.left, avoid?.top, avoid?.right, avoid?.bottom, sheet]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div
      ref={ref}
      data-assist-ui=""
      data-testid={testId}
      role="dialog"
      aria-modal="false"
      aria-label={label}
      aria-live={live ? "polite" : undefined}
      tabIndex={focusKey === undefined ? undefined : -1}
      // pointer-events-auto: a layer that turned the body's pointer events off (a modal menu closing) never disables it.
      className={cn("weft-assist-card pointer-events-auto fixed z-[72] flex max-h-[min(70vh,560px)] flex-col overflow-hidden rounded-xl bg-card text-[13px] shadow-[var(--shadow-modal)] outline-none animate-[weft-pop_.2s_ease-out] motion-reduce:animate-none",
        sheet ? "inset-x-4 bottom-4 max-h-[60vh]" : "w-[min(360px,calc(100vw-24px))]")}
      style={sheet ? undefined : pos ? { left: pos.left, top: pos.top } : { left: at.x + 16, top: at.y + 20, visibility: "hidden" }}
    >
      {children}
    </div>
  );
}

/**
 * The floating icon. It follows the pointer a few pixels down and to the right (eased; at once under reduced motion),
 * never under the pointer itself, and holds still once the pointer comes near it so it can be clicked. It takes clicks
 * only once the pointer has rested on it for ARM_MS with nothing a person could click beneath it; over a control
 * (a button, a link, a field) it moves to the other side of the pointer instead, so it never covers what the person
 * was reaching for. It hides while the person types in a field or scrolls, and when the pointer leaves the window; a
 * phone (no hovering pointer) docks it in the corner instead, where it also steps aside while they type.
 */
const ARM_MS = 150;
const ICON = 22;
/** What a click beneath the icon would reach (the assistant's own surfaces aside). */
const CLICKABLE = "a[href],button,input,select,textarea,summary,label,[role=button],[role=tab],[role=link],[role=menuitem],[role=checkbox],[role=switch],[tabindex]:not([tabindex='-1']),[contenteditable]:not([contenteditable='false'])";
function controlBeneath(x: number, y: number): boolean {
  const top = document.elementsFromPoint(x, y).find((t) => !t.closest("[data-assist-ui]"));
  return !!top?.closest(CLICKABLE);
}
export function CursorIcon({ onOpen, hidden, docked }: { onOpen: (at: { x: number; y: number }, el: HTMLButtonElement) => void; hidden: boolean; docked: boolean }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [away, setAway] = useState(true);
  const [quiet, setQuiet] = useState(false);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let typing = false, quietUntil = 0;
    const show = () => setQuiet(Date.now() < quietUntil || typing);
    const onFocus = () => { const a = document.activeElement as HTMLElement | null; typing = !!a && !a.closest("[data-assist-ui]") && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable); show(); };
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onFocus);
    const offFocus = () => { document.removeEventListener("focusin", onFocus); document.removeEventListener("focusout", onFocus); };
    // Docked, the icon only steps aside while the person types (the keyboard and the field's own buttons are below it).
    if (docked) return offFocus;
    let x = -100, y = -100, tx = -100, ty = -100, raf = 0;
    let armTimer: ReturnType<typeof setTimeout> | null = null;
    const OFFSET = { x: 18, y: 22 };
    const place = () => { el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`; };
    const tick = () => {
      raf = 0;
      const reduce = reducedMotion();
      x = reduce ? tx : x + (tx - x) * 0.22;
      y = reduce ? ty : y + (ty - y) * 0.22;
      place();
      if (Math.abs(tx - x) > 0.5 || Math.abs(ty - y) > 0.5) raf = requestAnimationFrame(tick);
    };
    const disarm = () => { if (armTimer) { clearTimeout(armTimer); armTimer = null; } setArmed(false); };
    // The side of the pointer it rests on: down and to the right, or up and to the left once it moved out of the way.
    let side: 1 | -1 = 1;
    const follow = (cx: number, cy: number) => {
      const vw = document.documentElement.clientWidth, vh = window.innerHeight;
      tx = side > 0 ? Math.min(vw - 30, cx + OFFSET.x) : Math.max(8, cx - OFFSET.x - ICON);
      ty = side > 0 ? Math.min(vh - 30, cy + OFFSET.y) : Math.max(8, cy - OFFSET.y - ICON);
      if (x < 0) { x = tx; y = ty; place(); }
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      setAway(false);
      const over = x > 0 && e.clientX >= x && e.clientX <= x + ICON && e.clientY >= y && e.clientY <= y + ICON;
      if (over) {
        // On the icon: it takes the click only when nothing a person could click sits beneath it; over a control it
        // moves to the other side of the pointer, so the click reaches the control.
        if (controlBeneath(e.clientX, e.clientY)) { disarm(); side = side > 0 ? -1 : 1; follow(e.clientX, e.clientY); return; }
        if (!armTimer) armTimer = setTimeout(() => setArmed(true), ARM_MS);
        return;
      }
      disarm();
      // Near it (moving to click it): it holds still, so it can be reached.
      if (Math.hypot(e.clientX - (x + ICON / 2), e.clientY - (y + ICON / 2)) < 36 && x > 0) return;
      side = 1;
      follow(e.clientX, e.clientY);
    };
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => { quietUntil = Date.now() + 500; show(); if (quietTimer) clearTimeout(quietTimer); quietTimer = setTimeout(show, 520); };
    const onLeave = () => { disarm(); setAway(true); };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(raf);
      if (armTimer) clearTimeout(armTimer);
      if (quietTimer) clearTimeout(quietTimer);
      offFocus();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("scroll", onScroll, { capture: true });
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, [docked]);
  const gone = hidden || quiet || (!docked && away);
  return (
    <button
      ref={ref}
      type="button"
      data-assist-ui=""
      data-testid={ASSIST_TID.icon}
      data-armed={docked || armed ? "true" : "false"}
      data-quiet={quiet ? "true" : "false"}
      aria-label={ASSIST_COPY.iconLabel}
      title={ASSIST_COPY.iconLabel}
      // The keyboard way in is Ctrl or Cmd J; the floating icon stays out of the tab order (a docked one is in it,
      // except while it is hidden: an invisible button is no Tab stop and is not read out).
      tabIndex={docked && !gone ? 0 : -1}
      aria-hidden={gone ? true : undefined}
      // Keeps the page's text selection, so "Ask about this" can read it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { if (gone) return; const r = e.currentTarget.getBoundingClientRect(); onOpen({ x: r.left, y: r.top }, e.currentTarget); }}
      className={cn(
        "weft-assist-icon fixed z-[71] grid size-[22px] place-items-center rounded-full bg-gray-12 text-white shadow-[var(--shadow-modal)] outline-none transition-opacity duration-150 focus-visible:ring-2 focus-visible:ring-[var(--blue-9)] motion-reduce:transition-none",
        docked ? "right-4 bottom-4 size-10" : "top-0 left-0",
        gone ? "pointer-events-none opacity-0" : docked || armed ? "pointer-events-auto" : "pointer-events-none",
      )}
    >
      <Sparkles className={docked ? "size-5" : "size-3"} strokeWidth={2} aria-hidden />
    </button>
  );
}

/** The pointer that glides from `from` to the target along a short curve, then the ring and the label bubble. */
export function AssistPointer({ target, label, from, onArrived }: { target: HTMLElement; label: string; from: { x: number; y: number }; onArrived?: () => void }) {
  const dot = useRef<HTMLDivElement | null>(null);
  const [arrived, setArrived] = useState(false);
  const [bubble, setBubble] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    setArrived(false);
    const el = dot.current;
    const r = target.getBoundingClientRect();
    const to = { x: r.left + Math.min(r.width / 2, 40), y: r.top + Math.min(r.height / 2, 24) };
    if (!el || reducedMotion()) { if (el) el.style.transform = `translate3d(${to.x}px, ${to.y}px, 0)`; setArrived(true); return; }
    // A quadratic curve that bows away from the straight line, 420 ms, ease out.
    const c = { x: (from.x + to.x) / 2 - (to.y - from.y) * 0.25, y: (from.y + to.y) / 2 + (to.x - from.x) * 0.25 };
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 420), k = 1 - (1 - t) ** 3;
      const x = (1 - k) ** 2 * from.x + 2 * (1 - k) * k * c.x + k ** 2 * to.x, y = (1 - k) ** 2 * from.y + 2 * (1 - k) * k * c.y + k ** 2 * to.y;
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      if (t < 1) raf = requestAnimationFrame(step); else setArrived(true);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, from.x, from.y]);
  const arrivedCb = useRef(onArrived);
  arrivedCb.current = onArrived;
  useEffect(() => { if (arrived) arrivedCb.current?.(); }, [arrived]);
  // Once there, the pointer and the bubble follow the target each frame, as the ring does: a scroll or a resize never
  // leaves them beside someone else's card.
  const live = useTrackedRect(arrived ? target : null);
  useLayoutEffect(() => {
    if (!arrived || !live) { if (arrived) setBubble(null); return; }
    const el = dot.current;
    if (el) el.style.transform = `translate3d(${live.left + Math.min((live.right - live.left) / 2, 40)}px, ${live.top + Math.min((live.bottom - live.top) / 2, 24)}px, 0)`;
    const vp: Rect = { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: window.innerHeight };
    const p = placeCard({ target: live, card: { width: Math.min(220, 24 + label.length * 7.5), height: 30 }, bounds: vp, obstacles: [], avoid: [], order: ["bottom", "top", "right", "left"], gap: 8, pad: 8 });
    setBubble(p ? { left: p.left, top: p.top } : null);
  }, [arrived, live?.left, live?.top, live?.right, live?.bottom, label]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div ref={dot} aria-hidden data-assist-ui="" data-testid={ASSIST_TID.pointer} data-arrived={arrived ? "true" : "false"} className="weft-assist-pointer pointer-events-none fixed top-0 left-0 z-[73]">
        <svg width="18" height="18" viewBox="0 0 18 18" className="drop-shadow"><path d="M2 2 L16 8 L9 10 L7 16 Z" fill="var(--accent-9)" stroke="white" strokeWidth="1.5" strokeLinejoin="round" /></svg>
      </div>
      {arrived ? <TourRing target={target} found secondary={[]} /> : null}
      {arrived && bubble ? (
        <div data-assist-ui="" data-testid={ASSIST_TID.bubble} role="status" className="weft-assist-bubble pointer-events-none fixed z-[73] max-w-[220px] truncate rounded-full bg-gray-12 px-2.5 py-1 text-1 font-medium text-white shadow-[var(--shadow-modal)]" style={{ left: bubble.left, top: bubble.top }}>
          {label}
        </div>
      ) : null}
    </>
  );
}

/** The small Weft menu a single right-click opens in the app: Copy selected text and Ask about this. */
export function WeftMenu({ at, canCopy, onCopy, onAsk, onClose }: { at: { x: number; y: number }; canCopy: boolean; onCopy: () => void; onAsk: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLButtonElement>("button:not([disabled])");
    first?.focus();
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener("pointerdown", onDown, { capture: true });
    return () => window.removeEventListener("pointerdown", onDown, { capture: true });
  }, [onClose]);
  const vw = typeof document === "undefined" ? 1024 : document.documentElement.clientWidth, vh = typeof window === "undefined" ? 768 : window.innerHeight;
  const onKey = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };
  return (
    <div ref={ref} data-assist-ui="" data-testid={ASSIST_TID.menu} role="menu" aria-label={ASSIST_COPY.menuLabel} onKeyDown={onKey}
      className="weft-assist-card pointer-events-auto fixed z-[74] w-[200px] rounded-lg bg-card p-1 text-[13px] shadow-[var(--shadow-modal)]"
      style={{ left: Math.min(at.x, vw - 212), top: Math.min(at.y, vh - 96) }}>
      <button type="button" role="menuitem" data-testid={ASSIST_TID.menuCopy} disabled={!canCopy} onClick={onCopy} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-gray-3 focus-visible:bg-gray-3 disabled:opacity-50">
        <Copy className="size-3.5 text-gray-10" aria-hidden /> {ASSIST_COPY.menuCopy}
      </button>
      <button type="button" role="menuitem" data-testid={ASSIST_TID.menuAsk} onClick={onAsk} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-gray-3 focus-visible:bg-gray-3">
        <MessageCircleQuestion className="size-3.5 text-gray-10" aria-hidden /> {ASSIST_COPY.menuAsk}
      </button>
    </div>
  );
}
