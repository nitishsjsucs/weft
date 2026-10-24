"use client";
// The intent registry (ext/assist.ts ASSIST_INTENTS): named, non-mutating moves of the view with typed params. A
// global intent is a route with query params, which the page reads (url-state.ts); a page intent is page state, which
// the page that has it registers (useAssistIntent) or the assistant runs itself on the page's own markup (a tab, a
// section, a scroll). The screen map lists the page intents that are available right now; the executor checks every
// call against the manifest, so an intent the manifest does not have (approve, submit) cannot be called at all.
import { useEffect, useRef } from "react";
import { ASSIST_ANCHORS, ASSIST_QUERY_KEYS, intentDef, routePattern } from "../../../../../packages/contracts/src/ext/assist";
import { currentPathname } from "@/lib/pathname";
import { setUrlState } from "@/lib/url-state";
import { activate, reducedMotion, scrollToView } from "../tour/dom";
import { liveShowRefusal } from "./guard";
import { kindOf, labelOf, pickAmong } from "./dom";

export type IntentHandler = (params: Record<string, string>) => boolean | Promise<boolean>;
const handlers = new Map<string, Set<IntentHandler>>();

/** A page registers a page intent's handler for as long as it is mounted. */
export function registerIntent(id: string, h: IntentHandler): () => void {
  if (!intentDef(id) || intentDef(id)!.scope !== "page") throw new Error(`${id} is not a page intent in the manifest`);
  const set = handlers.get(id) ?? new Set();
  set.add(h);
  handlers.set(id, set);
  return () => { set.delete(h); };
}

export function useAssistIntent(id: string, h: IntentHandler, enabled = true): void {
  const ref = useRef(h);
  ref.current = h;
  useEffect(() => (enabled ? registerIntent(id, (p) => ref.current(p)) : undefined), [id, enabled]);
}

const reduce = (): ScrollBehavior => (reducedMotion() ? "auto" : "smooth");
/**
 * The page's own markup in main, as the person can reach it now: rendered, and not behind an open modal layer (a
 * drawer or dialog hides the rest of the page as it opens, aria-hidden). A tab or a section trigger behind one is never
 * pressed: a press outside a modal layer closes it, and the form in it (the Off-cycle pay drawer's dates) is lost.
 */
const inMain = (sel: string) => [...document.querySelectorAll<HTMLElement>(`main ${sel}`)].filter((e) => e.getBoundingClientRect().height > 0 && !e.closest("[aria-hidden='true'],[inert]"));
const slug = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
/** A tab's slug: its data-tab, the value Radix puts at the end of its id, or its label. */
const tabSlug = (t: HTMLElement) => t.dataset.tab ?? /-trigger-(.+)$/.exec(t.id)?.[1] ?? slug(labelOf(t).label);

/** The page intents available right now (registered ones, and the built-ins whose markup is on the page). */
export function offeredIntents(path: string): string[] {
  const out = new Set<string>();
  for (const [id, set] of handlers) if (set.size) out.add(id);
  if (inMain("[role=tab]").length) out.add("tab.select");
  if (inMain("[data-assist-section], details").length) { out.add("section.expand"); out.add("section.collapse"); }
  const pattern = routePattern(path, { hosted: true });
  if (Object.values(ASSIST_ANCHORS).some((a) => !a.mutating && (a.routes.includes("*") || (pattern && a.routes.includes(pattern))))) out.add("scroll.to");
  return [...out].sort();
}

const BUILT_IN: Record<string, (p: Record<string, string>) => Promise<boolean>> = {
  async "tab.select"(p) {
    const tab = inMain("[role=tab]").find((t) => tabSlug(t) === p.tab || slug(labelOf(t).label) === slug(p.tab ?? ""));
    if (!tab) return false;
    if (liveShowRefusal({ tag: tab.tagName, kind: kindOf(tab), label: labelOf(tab).label, testid: tab.dataset.testid ?? null, anchor: null, type: null, inForm: false, marked: tab.hasAttribute("data-assist-mutating") }, "tab")) return false;
    if (tab.getAttribute("aria-selected") !== "true") activate(tab);
    return true;
  },
  async "section.expand"(p) { return toggleSection(p.id ?? "", true); },
  async "section.collapse"(p) { return toggleSection(p.id ?? "", false); },
  async "scroll.to"(p) {
    const a = ASSIST_ANCHORS[p.anchor ?? ""];
    if (!a || a.mutating) return false;
    const el = pickAmong(a.selectors, null);
    if (!el) return false;
    await scrollToView(el, "center", reduce());
    return true;
  },
};

async function toggleSection(id: string, open: boolean): Promise<boolean> {
  const sec = inMain(`[data-assist-section="${CSS.escape(id)}"]`)[0] ?? inMain("details").find((d) => slug(labelOf(d.querySelector("summary") ?? d).label) === slug(id));
  if (!sec) return false;
  // A section the page keeps in its link (the pay run's ?section=needs-review) is opened through the link as well, so
  // the view the assistant shows is the one a pasted link shows.
  const keys = ASSIST_QUERY_KEYS[routePattern(currentPathname(), { hosted: true }) ?? ""];
  if (open && keys?.section?.kind === "enum" && keys.section.values.includes(id)) setUrlState({ section: id });
  if (sec instanceof HTMLDetailsElement) { sec.open = open; return true; }
  // The section's own trigger only: the section itself, or the control that names it (aria-controls). A control that
  // merely sits inside it (a row's flag chip, a menu button) is never pressed for it.
  const trigger = sec.matches("[aria-expanded]") ? sec : sec.id ? document.querySelector<HTMLElement>(`[aria-expanded][aria-controls~="${CSS.escape(sec.id)}"]`) : null;
  if (!trigger) {
    // A band that is always open (a table group): expanding it brings it into view; it cannot be collapsed.
    if (!open) return false;
    await scrollToView(sec, "start", reduce());
    return true;
  }
  // Checked like any show before it is pressed: a disclosure or a section, nothing that changes data.
  const why = liveShowRefusal({ tag: trigger.tagName, kind: kindOf(trigger), label: labelOf(trigger).label, testid: trigger.dataset.testid ?? null, anchor: null, type: trigger.getAttribute("type"), inForm: !!trigger.closest("form"), marked: !!trigger.closest("[data-assist-mutating]") }, open ? "expand" : "collapse");
  if (why || trigger.closest("[aria-hidden='true'],[inert]")) return false;
  if ((trigger.getAttribute("aria-expanded") === "true") !== open) activate(trigger);
  return true;
}

/** Runs a page intent: a registered handler first, else the built-in. False when nothing on the page could run it. */
export async function runPageIntent(id: string, params: Record<string, string>): Promise<boolean> {
  for (const h of handlers.get(id) ?? []) { if (await h(params)) return true; }
  const b = BUILT_IN[id];
  return b ? b(params) : false;
}
