"use client";
// The interaction trail from the live app (trail-core.ts holds the ring buffer): page changes, records opened and
// closed through the URL's view state, tabs and filters switched, errors and status lines the page showed, and the
// assistant's own questions and effects. A module singleton, so a question asked after a page change still sees what
// came before it. Text inside the assistant's own surfaces or inside an untrusted region (what people typed) is
// never recorded.
import type { TrailEvent } from "../../../../../packages/contracts/src/ext/assist";
import { normalizePath } from "@/lib/pathname";
import { URL_STATE_EVENT } from "@/lib/url-state";
import { createTrail, pageName, viewChanges } from "./trail-core";
import { OWN, UNTRUSTED } from "./dom";

export { pageName };

const trail = createTrail();
const here = () => (typeof window === "undefined" ? null : normalizePath(window.location.pathname));

export function pushTrail(kind: TrailEvent["kind"], label: string, route: string | null = here()): void {
  trail.push({ kind, label, route }, Date.now());
}

/** The trail for a question, newest first. */
export function trailEvents(): TrailEvent[] { return trail.list(Date.now()); }

let started = 0;
let stopAll: (() => void) | null = null;
let sync: () => void = () => undefined;

/** Records what the URL says changed since the last look (the assistant calls it on every route change). */
export function syncTrail(): void { sync(); }

/** Starts the feeders once (refcounted); returns the stop function. */
export function startTrail(): () => void {
  started++;
  if (started === 1) {
    let path = here() ?? "";
    let query = new URLSearchParams(window.location.search);
    sync = () => {
      const p = here() ?? "";
      const q = new URLSearchParams(window.location.search);
      if (p !== path) pushTrail("navigate", `Opened ${pageName(p)}`, p);
      else for (const c of viewChanges(query, q, p)) pushTrail(c.kind, c.label, p);
      path = p;
      query = q;
    };
    window.addEventListener("popstate", sync);
    window.addEventListener(URL_STATE_EVENT, sync);
    // Errors (role=alert) and status lines (role=status) the page shows: each one when it appears, not on every render.
    const showing = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scan = () => {
      timer = null;
      const now = new Set<string>();
      for (const el of document.querySelectorAll<HTMLElement>("[role=alert],[role=status]")) {
        if (el.closest(OWN) || el.closest(UNTRUSTED) || el.querySelector(UNTRUSTED)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 200) continue;
        const key = `${el.getAttribute("role")}:${text}`;
        now.add(key);
        if (!showing.has(key)) pushTrail(el.getAttribute("role") === "alert" ? "error" : "toast", text);
      }
      showing.clear();
      for (const k of now) showing.add(k);
    };
    const obs = new MutationObserver(() => { if (!timer) timer = setTimeout(scan, 250); });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    stopAll = () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(URL_STATE_EVENT, sync);
      obs.disconnect();
      if (timer) clearTimeout(timer);
      sync = () => undefined;
    };
  }
  return () => {
    started--;
    if (started === 0) { stopAll?.(); stopAll = null; }
  };
}
