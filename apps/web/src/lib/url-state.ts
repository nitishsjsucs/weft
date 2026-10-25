"use client";
// Page view state in the URL (the cursor assistant's deep links; packages/contracts/src/ext/assist.ts
// ASSIST_QUERY_KEYS): which paycheck's drawer is open, which tab, which list filter, which section. A page reads its
// keys after mount (the static export prerenders without a query) and on Back, and writes them with replaceState, so
// opening a drawer or switching a tab adds no history entry and Back leaves the page as before. The write keeps the
// entry's own router state, so Next's router does not treat it as a navigation of its own: one that did (a "restore")
// would cancel a navigation already in flight, for example closing a drawer while the guided tour or a link moves on
// to the next page. Nothing reads these keys through useSearchParams; the custom event tells every hook on the page
// that the query changed.
import { useCallback, useSyncExternalStore } from "react";

export const URL_STATE_EVENT = "weft:url-state";

function subscribe(cb: () => void): () => void {
  window.addEventListener("popstate", cb);
  window.addEventListener(URL_STATE_EVENT, cb);
  return () => { window.removeEventListener("popstate", cb); window.removeEventListener(URL_STATE_EVENT, cb); };
}
const search = () => window.location.search;

/** The query with `patch` applied (null removes a key), as "?a=1&b=2" or "". */
export function patchedSearch(current: string, patch: Readonly<Record<string, string | null>>): string {
  const q = new URLSearchParams(current);
  for (const [k, v] of Object.entries(patch)) { if (v === null || v === "") q.delete(k); else q.set(k, v); }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Writes keys into the current URL without a history entry, keeping the path, the other keys and the hash. */
export function setUrlState(patch: Readonly<Record<string, string | null>>): void {
  const next = patchedSearch(window.location.search, patch);
  if (next === window.location.search) return;
  // The entry's state as it is (Next's router marks its own entries), so only the URL changes.
  try { window.history.replaceState(window.history.state, "", `${window.location.pathname}${next}${window.location.hash}`); } catch { /* history blocked */ }
  window.dispatchEvent(new Event(URL_STATE_EVENT));
}

/**
 * One query key as page state: its value when it passes `valid`, else null (an unknown or stale value reads as
 * absent, so the page keeps its default). The setter writes it with setUrlState.
 */
export function useUrlState(key: string, valid: (v: string) => boolean = () => true): [string | null, (v: string | null) => void] {
  const raw = useSyncExternalStore(subscribe, search, () => "");
  const v = new URLSearchParams(raw).get(key);
  const value = v !== null && valid(v) ? v : null;
  const set = useCallback((next: string | null) => setUrlState({ [key]: next }), [key]);
  return [value, set];
}

/** A validator for one of a page's own options. */
export const oneOf = (values: readonly string[]) => (v: string): boolean => values.includes(v);

/** "/app/agent?thread=thr_x" opens the page at `currentPath` ("/app/agent" or the export's "/app/agent/"). */
export function sameAsPage(href: string, currentPath: string): boolean {
  const path = href.split(/[?#]/, 1)[0]!;
  const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);
  return trim(path) === trim(currentPath);
}

/**
 * A Next <Link> to the page already open with other view state (Continue in Agent on the Agent page, a proposal's
 * Open on the Inbox): Next's soft navigation keeps the page mounted and fires neither popstate nor URL_STATE_EVENT,
 * so the page would go on showing the old view under the new URL. A plain click on one writes `patch` (the link's view
 * keys, ext/assist viewPatch) in place instead and tells the page; returns true when it did. A click with a modifier
 * (a new tab) is the browser's.
 */
export function followInPlace(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault(): void }, href: string, patch: Readonly<Record<string, string | null>>): boolean {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !sameAsPage(href, window.location.pathname)) return false;
  e.preventDefault();
  setUrlState(patch);
  return true;
}
