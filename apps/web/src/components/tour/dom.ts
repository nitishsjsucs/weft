// DOM helpers for the tour (owner: tour): find a target with a MutationObserver plus rAF, click a control the way
// a pointer would (Radix tabs activate on mousedown, popovers on click), close app layers, and fill a React input.

export const reducedMotion = (): boolean => {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
};

/** The first element matching any selector, skipping ones with no box (hidden tiers of the same control). */
export function findFirst(selectors: string[]): { el: HTMLElement; selector: string } | null {
  for (const sel of selectors) {
    let nodes: NodeListOf<HTMLElement>;
    try { nodes = document.querySelectorAll<HTMLElement>(sel); } catch { continue; }
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) return { el, selector: sel };
    }
  }
  return null;
}

/** How long a fallback selector waits for the step's own one to appear (a page that is still switching files). */
export const PRIMARY_GRACE_MS = 1_200;

/**
 * Whether a match is good enough to stop waiting: the first selector (the step's own) always is; a fallback only once
 * the grace period has passed, so a page that shows its default content first does not win over the real target.
 */
export function acceptHit(selector: string | null, selectors: string[], elapsedMs: number, graceMs = PRIMARY_GRACE_MS): boolean {
  if (selector === null) return false;
  return selector === selectors[0] || elapsedMs >= graceMs;
}

/** Waits up to `ms` for any of the selectors, preferring the first; resolves null on timeout or abort. */
export function waitForAny(selectors: string[], ms: number, signal: AbortSignal): Promise<{ el: HTMLElement; selector: string } | null> {
  return new Promise((resolve) => {
    if (!selectors.length) return resolve(null);
    const t0 = Date.now();
    const grace = Math.min(PRIMARY_GRACE_MS, ms);
    const good = (h: { el: HTMLElement; selector: string } | null) => !!h && acceptHit(h.selector, selectors, Date.now() - t0, grace);
    const hit = findFirst(selectors);
    if (good(hit)) return resolve(hit);
    let done = false;
    let raf = 0;
    const finish = (v: { el: HTMLElement; selector: string } | null) => {
      if (done) return;
      done = true;
      obs.disconnect();
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(v);
    };
    const check = () => { raf = 0; const h = findFirst(selectors); if (good(h)) finish(h); };
    const obs = new MutationObserver(() => { if (!raf) raf = requestAnimationFrame(check); });
    obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-tour", "data-status", "data-state", "data-count", "data-source", "data-current", "data-path", "style", "class"] });
    const timer = setTimeout(() => finish(findFirst(selectors)), ms);
    const onAbort = () => finish(null);
    signal.addEventListener("abort", onAbort);
    // Layout changes without mutations (a scroll container settling) still resolve within a frame or two.
    const poll = () => { if (!done) { check(); if (!done) setTimeout(poll, 150); } };
    setTimeout(poll, 150);
  });
}

const SCROLLS = new Set(["auto", "scroll"]);

/**
 * The element's scroll containers, innermost first: every ancestor that scrolls (overflow auto or scroll, with
 * content past its box) up to a fixed layer. The document is one only outside the app shell (the portal scrolls the
 * page; /app scrolls inside its panes, and a scroll of the document there slides the whole shell up).
 */
export function scrollBoxes(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if ((SCROLLS.has(cs.overflowY) && p.scrollHeight > p.clientHeight + 1) || (SCROLLS.has(cs.overflowX) && p.scrollWidth > p.clientWidth + 1)) out.push(p);
    if (cs.position === "fixed") return out;
  }
  const doc = document.scrollingElement as HTMLElement | null;
  if (doc && !document.querySelector("[data-app-main]") && (doc.scrollHeight > doc.clientHeight + 1 || doc.scrollWidth > doc.clientWidth + 1)) out.push(doc);
  return out;
}

/** How far a box must scroll on one axis to put [lo, hi] at `pos` inside [start, end] with a margin. */
function axisDelta(lo: number, hi: number, start: number, end: number, pos: ScrollLogicalPosition, margin: number): number {
  if (pos === "start") return lo - (start + margin);
  if (pos === "end") return hi - (end - margin);
  if (pos === "center") return (lo + hi) / 2 - (start + end) / 2;
  if (lo < start + margin) return lo - (start + margin);
  if (hi > end - margin) return Math.min(hi - (end - margin), lo - (start + margin));
  return 0;
}

/**
 * Scrolls the element into view like scrollIntoView, but only inside its own scroll containers (never the app
 * shell's document), with a 16 px margin so a `block: "start"` target is not flush against the pane's edge (the
 * sticky header), where the ring would have no room. Resolves once every container it moved has reached its end
 * position (or after 900 ms), so the ring and the card are placed on the settled page, not one frame behind a
 * smooth scroll.
 */
export function scrollToView(el: HTMLElement, block: ScrollLogicalPosition, behavior: ScrollBehavior, inline: ScrollLogicalPosition = "nearest", margin = 16): Promise<void> {
  // `margin` is the room left on the block axis (more above a target the card sits over); inline keeps 16 px.
  const r = el.getBoundingClientRect();
  let { top, bottom, left, right } = r;
  const moves: { box: HTMLElement; x: number; y: number }[] = [];
  for (const box of scrollBoxes(el)) {
    const doc = box === document.scrollingElement;
    const b = doc ? { top: 0, left: 0 } : box.getBoundingClientRect();
    const t = b.top + (doc ? 0 : box.clientTop), l = b.left + (doc ? 0 : box.clientLeft);
    const h = doc ? window.innerHeight : box.clientHeight, w = doc ? document.documentElement.clientWidth : box.clientWidth;
    const y = Math.max(0, Math.min(box.scrollHeight - h, box.scrollTop + (box.scrollHeight > h + 1 ? axisDelta(top, bottom, t, t + h, block, margin) : 0)));
    const x = Math.max(0, Math.min(box.scrollWidth - w, box.scrollLeft + (box.scrollWidth > w + 1 ? axisDelta(left, right, l, l + w, inline, 16) : 0)));
    const dy = y - box.scrollTop, dx = x - box.scrollLeft;
    if (Math.abs(dy) < 1 && Math.abs(dx) < 1) continue;
    box.scrollTo({ top: y, left: x, behavior });
    moves.push({ box, x, y });
    top -= dy; bottom -= dy; left -= dx; right -= dx;
  }
  return settled(moves);
}

/** Resolves once every box is at its end position (within a pixel), checked each frame, or after `maxMs`. */
function settled(moves: { box: HTMLElement; x: number; y: number }[], maxMs = 900): Promise<void> {
  if (!moves.length) return Promise.resolve();
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const done = moves.every(({ box, x, y }) => Math.abs(box.scrollTop - y) < 1 && Math.abs(box.scrollLeft - x) < 1);
      if (done || Date.now() - t0 >= maxMs) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Scrolls `el`'s scroll container so the element's top sits `room` px below the container's top (room for the card
 * above it), when the element still fits below that line; otherwise centres it. For steps whose popover drops below
 * the target, so the card has a free spot above.
 */
export function scrollWithRoomAbove(el: HTMLElement, room: number, behavior: ScrollBehavior): Promise<void> {
  const r = el.getBoundingClientRect();
  const box = scrollBoxes(el).find((b) => b !== document.scrollingElement && b.scrollHeight > b.clientHeight + 1);
  if (!box || r.height + room + 16 > box.clientHeight) return scrollToView(el, "center", behavior);
  return scrollToView(el, "start", behavior, "nearest", room);
}

/** Clicks like a pointer: mousedown (Radix tabs) then click (buttons, popover triggers, rows). */
export function activate(el: HTMLElement): void {
  const opts = { bubbles: true, cancelable: true, button: 0, view: window } as MouseEventInit;
  try { el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse" })); } catch { /* old engine */ }
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.click();
}

/** Closes app popovers and drawers through Radix's outside interaction (the tour card ignores outside clicks). */
export function closeAppLayers(): void {
  try { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" })); } catch { /* old engine */ }
}

/** Sets a controlled React textarea or input value and fires the input event React listens for. */
export function setReactValue(el: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Types `text` into a React field one character at a time, or at once under reduced motion. */
export async function typeInto(el: HTMLTextAreaElement | HTMLInputElement, text: string, signal: AbortSignal): Promise<void> {
  if (reducedMotion()) { setReactValue(el, text); return; }
  for (let i = 1; i <= text.length; i++) {
    if (signal.aborted) return;
    // The person sent or edited the field mid-way (sending clears it): stop, rather than type into the cleared composer.
    if (i > 1 && el.value !== text.slice(0, i - 1)) return;
    setReactValue(el, text.slice(0, i));
    await sleep(18, signal);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, Math.max(0, ms));
    function done() { signal?.removeEventListener("abort", done); clearTimeout(t); resolve(); }
    signal?.addEventListener("abort", done);
  });
}

/** True when keys belong to a field the person is typing in. */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
}
