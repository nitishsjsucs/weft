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

/**
 * scrollIntoView with a 16 px margin, so a target scrolled to the start or end of its pane is not flush against the
 * pane's edge (the sticky header, the window top), where the ring would have no room.
 */
export function scrollToView(el: HTMLElement, block: ScrollLogicalPosition, behavior: ScrollBehavior): void {
  const prev = el.style.scrollMargin;
  el.style.scrollMargin = "16px";
  el.scrollIntoView({ block, behavior });
  el.style.scrollMargin = prev;
}

/**
 * Scrolls `el`'s scroll container so the element's top sits `room` px below the container's top (room for the card
 * above it), when the element still fits below that line; otherwise centres it. For steps whose popover drops below
 * the target, so the card has a free spot above.
 */
export function scrollWithRoomAbove(el: HTMLElement, room: number, behavior: ScrollBehavior): void {
  let box: HTMLElement | null = el.parentElement;
  while (box && box !== document.body) {
    const oy = getComputedStyle(box).overflowY;
    if ((oy === "auto" || oy === "scroll") && box.scrollHeight > box.clientHeight) break;
    box = box.parentElement;
  }
  if (!box || box === document.body) { scrollToView(el, "center", behavior); return; }
  const c = box.getBoundingClientRect(), r = el.getBoundingClientRect();
  if (r.height + room + 16 > box.clientHeight) { scrollToView(el, "center", behavior); return; }
  box.scrollTo({ top: box.scrollTop + (r.top - (c.top + room)), behavior });
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
