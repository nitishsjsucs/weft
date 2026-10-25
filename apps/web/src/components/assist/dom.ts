"use client";
// The cursor assistant's reading of the page (research/cursor-assistant.md 4.2): the DOM walker behind the screen
// map, the registry from [n] back to the live element, the check before acting (still attached, visible and not
// covered, else found again by its test id, record or anchor), and the cursor context (the record under the pointer,
// what is focused, what is open, what is selected). It reads Weft's own markup first: data-tour anchors, test ids,
// data-entity and the ids the app already puts in its attributes, ARIA roles and landmarks. Text inside a
// [data-assist-untrusted] region (what people typed: notes, purposes, notice bodies, message bodies) never becomes a
// plain label; a field's value is never read at all.
import {
  ANCHOR_RE, ASSIST_ANCHORS, routePattern, SCREEN_LIMITS, type AssistCursor, type EntityRef, type ScreenItem, type ScreenItemKind, type ScreenMap,
} from "../../../../../packages/contracts/src/ext/assist";
import { visibleRect } from "../tour/layout";
import { entityFromAttrs } from "./context-core";
import { buildScreenMap, type Candidate } from "./screen-map-core";

/** The assistant's own surfaces and the tour's: never part of the map, never "covering" a target. */
export const OWN = "[data-assist-ui],[data-tour-card],[data-tour-ring],[data-tour-mark]";
export const UNTRUSTED = "[data-assist-untrusted]";
/** What the page marks as a control that changes data (a link that signs in as someone): never shown, never a step. */
export const MUTATING_MARK = "[data-assist-mutating]";
const CANDIDATES = [
  "[data-tour]", "[data-testid]", "[data-entity]", "[role=tab]", "[role=dialog]", "[role=alertdialog]", "[role=menuitem]", "[role=menuitemradio]",
  "main h1", "main h2", "main h3", "nav a[href]", "a[href^='/app']", "button", "summary", "[aria-expanded]", "main", "nav[aria-label]", "aside[aria-label]",
  "input:not([type=hidden])", "textarea", "select", "[data-assist-section]",
].join(",");

export function kindOf(el: Element): ScreenItemKind {
  const role = el.getAttribute("role");
  const tag = el.tagName;
  if (role === "tab") return "tab";
  if (role === "dialog" || role === "alertdialog") return "dialog";
  if (role?.startsWith("menuitem")) return "menuitem";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return "field";
  if (tag === "TR" || role === "row") return "row";
  if (tag === "SUMMARY") return "disclosure";
  if (tag === "DETAILS" || el.hasAttribute("data-assist-section")) return "section";
  if (tag === "BUTTON" || role === "button") return el.hasAttribute("aria-expanded") || el.getAttribute("aria-haspopup") ? "disclosure" : "button";
  if (tag === "A") return "link";
  if (/^H[1-3]$/.test(tag)) return "heading";
  if (tag === "MAIN" || tag === "ASIDE" || tag === "HEADER") return "landmark";
  if (tag === "NAV") return "nav";
  if (tag === "TBODY" || tag === "SECTION" || tag === "UL" || tag === "OL") return "section";
  if (tag === "LI") return "item";
  return el.hasAttribute("data-entity") || el.hasAttribute("data-proposal-id") ? "card" : "section";
}

/** An element's visible words, split into what the app wrote and what sits in an untrusted region. */
function textOf(el: Element): { trusted: string; untrusted: string } {
  let trusted = "", untrusted = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement;
    if (!p || p.closest("[aria-hidden='true'],script,style,template") || p.closest(OWN)) continue;
    const t = n.textContent ?? "";
    if (!t.trim()) continue;
    if (p.closest(UNTRUSTED)) untrusted += ` ${t}`; else trusted += ` ${t}`;
    if (trusted.length > 400 && untrusted.length > 400) break;
  }
  return { trusted: trusted.replace(/\s+/g, " ").trim(), untrusted: untrusted.replace(/\s+/g, " ").trim() };
}

/** textOf over several elements (the nodes an aria-labelledby names), joined. */
function textOfAll(els: readonly Element[]): { trusted: string; untrusted: string } {
  const parts = els.map(textOf);
  const join = (k: "trusted" | "untrusted") => parts.map((p) => p[k]).filter(Boolean).join(" ");
  return { trusted: join("trusted"), untrusted: join("untrusted") };
}

/** The label a person would read, and whether it is text people typed (untrusted). A field's value is never read. */
export function labelOf(el: Element): { label: string; untrusted: boolean } {
  // An element inside an untrusted region names itself with words from it (a title attribute, an aria-label).
  const inUntrusted = !!el.closest(UNTRUSTED);
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return { label: aria, untrusted: inUntrusted };
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    // A dialog or drawer named by its title: the title's words split like any text, so a title people typed (an
    // agency notice's) is never the app's own label.
    const refs = by.split(/\s+/).map((id) => (id ? document.getElementById(id) : null)).filter((n): n is HTMLElement => !!n);
    const t = textOfAll(refs);
    if (t.trusted) return { label: t.trusted, untrusted: false };
    if (t.untrusted) return { label: t.untrusted, untrusted: true };
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const forLabel = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : null;
    const wrap = el.closest("label") ? textOf(el.closest("label")!).trusted : "";
    return { label: forLabel || wrap || ("placeholder" in el ? el.placeholder : "") || el.name || "Field", untrusted: false };
  }
  const t = textOf(el);
  if (t.trusted) return { label: t.trusted, untrusted: false };
  if (t.untrusted) return { label: t.untrusted, untrusted: true };
  return { label: el.getAttribute("title")?.trim() ?? "", untrusted: inUntrusted };
}

/** The record an element shows (context-core.ts entityFromAttrs over its attributes). */
export function entityOfEl(el: Element, route: string): { entity: string; kind: string } | null {
  const h = el as HTMLElement;
  return entityFromAttrs({ entity: h.dataset?.entity, entityKind: h.dataset?.entityKind, proposalId: h.dataset?.proposalId, runId: h.dataset?.runId, testid: h.dataset?.testid }, route);
}

/**
 * A record (a row, a card, a list item) in no link of its own that holds exactly one link into the app (a People row
 * and its name, a Home list item and its link): opening the record is following that link, not clicking the record.
 */
function recordLink(el: Element): Element | null {
  const k = kindOf(el);
  if (k !== "row" && k !== "card" && k !== "item") return null;
  const links = [...el.querySelectorAll("a[href]")].filter((a) => !a.closest(OWN));
  if (!links.length || new Set(links.map((a) => a.getAttribute("href"))).size !== 1) return null;
  try {
    const u = new URL(links[0]!.getAttribute("href")!, window.location.href);
    return u.origin === window.location.origin && u.pathname.startsWith("/app") ? links[0]! : null;
  } catch { return null; }
}

/**
 * Where the link an element is or sits in goes (or, for a record, the one app link it holds: recordLink): the path,
 * query and fragment when it stays on this origin, else the URL as written (another site, mail, the portal's own
 * origin), so the guards can refuse it. Null when it is in no link.
 */
export function hrefOf(el: Element): string | null {
  const a = el.closest("a[href]") ?? recordLink(el);
  const raw = a?.getAttribute("href");
  if (!a || raw === null || raw === undefined) return null;
  try {
    const u = new URL(raw, window.location.href);
    return u.origin === window.location.origin ? `${u.pathname}${u.search}${u.hash}` : u.href;
  } catch { return raw; }
}

/** The element's anchor token: its data-tour token, else a manifest anchor whose selector matches it. */
export function anchorOf(el: Element, pattern: string | null): string | null {
  const tour = (el.getAttribute("data-tour") ?? "").split(/\s+/).find((t) => ANCHOR_RE.test(t));
  for (const [token, a] of Object.entries(ASSIST_ANCHORS)) {
    if (!a.routes.includes("*") && (!pattern || !a.routes.includes(pattern))) continue;
    if (a.selectors.some((s) => { try { return el.matches(s); } catch { return false; } })) return token;
  }
  return tour ?? null;
}

function stateOf(el: Element): string | null {
  if (el.getAttribute("aria-selected") === "true" || el.getAttribute("data-state") === "active" && el.getAttribute("role") === "tab") return "selected";
  const ex = el.getAttribute("aria-expanded");
  if (ex) return ex === "true" ? "expanded" : "collapsed";
  if (el instanceof HTMLDetailsElement) return el.open ? "expanded" : "collapsed";
  if (el.getAttribute("aria-current")) return "current";
  if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return "disabled";
  return null;
}

/** True when another layer (not the assistant's, not the element's own content) sits over the element's middle. */
export function covered(el: Element): boolean {
  const v = visibleRect(el);
  if (!v) return true;
  const pts: [number, number][] = [[(v.left + v.right) / 2, (v.top + v.bottom) / 2], [v.left + 3, v.top + 3], [v.right - 3, v.bottom - 3]];
  let hidden = 0;
  for (const [x, y] of pts) {
    const top = document.elementsFromPoint(x, y).find((t) => !t.closest(OWN));
    if (!top || top === el || el.contains(top) || top.contains(el)) continue;
    // A popover or menu that belongs to the element (a flag's popover) does not hide it.
    if (top.closest("[data-radix-popper-content-wrapper]") && !el.closest("[data-radix-popper-content-wrapper]")) continue;
    hidden++;
  }
  return hidden === pts.length;
}

/** An element is fit to point at or act on: still attached, visible inside its scroll boxes and not covered. */
export function actionable(el: Element | null): boolean {
  return !!el && el.isConnected && !!visibleRect(el) && !covered(el);
}

export interface Registered { el: HTMLElement; item: ScreenItem }
export interface PageRead { screen: ScreenMap; registry: Map<number, Registered> }

/** The screen map of what is on screen now, and the registry from [n] to the live element. */
export function readScreen(route: string, opts: { intents: string[]; viewport?: [number, number] }): PageRead {
  const pattern = routePattern(route.split("?")[0]!, { hosted: true });
  const vp = { w: document.documentElement.clientWidth, h: window.innerHeight };
  const els: HTMLElement[] = [];
  const cands: Candidate[] = [];
  const seen = new Set<Element>();
  for (const el of document.querySelectorAll<HTMLElement>(CANDIDATES)) {
    if (seen.has(el) || el.closest(OWN) || el.closest("[hidden],[aria-hidden='true'],[inert]")) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > vp.h || r.left > vp.w) continue;
    const v = visibleRect(el);
    if (!v) continue;
    const kind = kindOf(el);
    // Big containers count only when they carry an anchor or a record; their text is everything inside them.
    const big = (r.width * r.height) > vp.w * vp.h * 0.5;
    const ent = entityOfEl(el, route);
    const anchor = anchorOf(el, pattern);
    if (big && !ent && !anchor && kind !== "landmark" && kind !== "dialog") continue;
    const { label, untrusted } = labelOf(el);
    if (kind === "landmark" || kind === "nav") { if (!el.getAttribute("aria-label") && el.tagName !== "MAIN") continue; }
    if (covered(el)) continue;
    els.push(el);
    cands.push({
      key: els.length - 1, kind, label: kind === "landmark" ? (el.getAttribute("aria-label") ?? "Main content") : label, untrusted: untrusted && kind !== "landmark",
      entity: ent?.entity ?? null, entityKind: ent?.kind ?? null, anchor, testid: el.dataset.testid ?? null,
      box: [Math.round(v.left), Math.round(v.top), Math.round(v.right - v.left), Math.round(v.bottom - v.top)], state: stateOf(el), href: hrefOf(el),
      mutating: !!el.closest(MUTATING_MARK),
    });
  }
  const title = document.querySelector("main h1")?.textContent?.trim() || document.title || "Weft";
  const tab = document.querySelector("main [role=tab][aria-selected='true']")?.textContent?.trim() ?? null;
  const built = buildScreenMap(cands, { route, title, tab, viewport: opts.viewport ?? [vp.w, vp.h], intents: opts.intents });
  const registry = new Map<number, Registered>();
  for (const it of built.screen.items) {
    const k = built.keys.get(it.n);
    if (k !== undefined && els[k]) registry.set(it.n, { el: els[k]!, item: it });
  }
  return { screen: built.screen, registry };
}

/**
 * Check before acting (the registry's element, re-found when the page re-rendered it): the element still attached,
 * visible and not covered; else the same test id, the same record or the anchor's selectors; else null (the caller
 * says plainly it is gone and never guesses another element).
 */
export function resolveRegistered(r: Registered | undefined): HTMLElement | null {
  if (!r) return null;
  if (actionable(r.el)) return r.el;
  const tries: string[] = [];
  if (r.item.testid) tries.push(`[data-testid="${CSS.escape(r.item.testid)}"]`);
  if (r.item.entity) tries.push(`[data-entity="${CSS.escape(r.item.entity)}"]`);
  if (r.item.anchor && ASSIST_ANCHORS[r.item.anchor]) tries.push(...ASSIST_ANCHORS[r.item.anchor]!.selectors);
  for (const s of tries) {
    let nodes: NodeListOf<HTMLElement>;
    try { nodes = document.querySelectorAll<HTMLElement>(s); } catch { continue; }
    for (const n of nodes) if (actionable(n) && labelOf(n).label.slice(0, 40) === r.item.label.slice(0, 40)) return n;
  }
  return null;
}

/**
 * Among elements a selector list matches, the first actionable one; with a hint ("Ruth"), the one whose card, row or
 * section holds it, or null when none does (never the first card instead: that would be someone else's).
 */
export function pickAmong(selectors: readonly string[], hint: string | null): HTMLElement | null {
  const all: HTMLElement[] = [];
  for (const s of selectors) {
    try { for (const n of document.querySelectorAll<HTMLElement>(s)) if (!all.includes(n)) all.push(n); } catch { /* bad selector */ }
    if (all.length && !hint) break;
  }
  const ok = all.filter((n) => actionable(n) || (n.isConnected && n.getBoundingClientRect().height > 0));
  if (hint) {
    const h = hint.toLowerCase();
    return ok.find((n) => (n.closest("[data-entity],[data-proposal-id],[data-tour~='inbox-card'],tr,li,section") ?? n).textContent?.toLowerCase().includes(h)) ?? null;
  }
  return ok[0] ?? null;
}

// ---- cursor context ---------------------------------------------------------------------------------------------

/** The nearest tagged record under a point. */
export function entityAt(x: number, y: number, route: string): EntityRef | null {
  return entityAround(document.elementsFromPoint(x, y).find((t) => !t.closest(OWN)) ?? null, route);
}

/** The nearest tagged record that holds an element (itself or an ancestor): what a focused row or link shows. */
export function entityAround(start: Element | null, route: string): EntityRef | null {
  for (let el: Element | null = start; el && el !== document.body; el = el.parentElement) {
    const e = entityOfEl(el, route);
    if (e) {
      const l = labelOf(el);
      return { entity: e.entity, kind: e.kind, label: l.untrusted ? "" : l.label.slice(0, SCREEN_LIMITS.label) };
    }
  }
  return null;
}

/** What the page has open: a dialog, a drawer, a menu or a popover (the newest). */
export function openLayer(): AssistCursor["layer"] {
  const layers = [...document.querySelectorAll<HTMLElement>("[role=dialog],[role=alertdialog],[role=menu],[data-radix-popper-content-wrapper]")].filter((l) => !l.closest(OWN) && l.getBoundingClientRect().height > 0);
  const l = layers.at(-1);
  if (!l) return null;
  const kind = l.getAttribute("role") === "menu" || l.querySelector("[role=menu]") ? "menu" : l.matches("[data-radix-popper-content-wrapper]") ? "popover" : l.closest("[data-drawer]") || /drawer/i.test(l.className) ? "drawer" : "dialog";
  // Its name (its own label, else its title), or its visible words when it has none. Words people typed (a notice
  // title) are split off like any text and left out, never sent as the app's own; the screen map's dialog item carries
  // them as untrusted, which taints the run.
  const title = l.getAttribute("aria-label") || l.hasAttribute("aria-labelledby") ? null : l.querySelector("h2,[id$='-title']");
  const label = title ? labelOf(title) : labelOf(l);
  return { kind, label: label.untrusted ? "" : (label.label || kind).slice(0, SCREEN_LIMITS.label * 2) };
}

/** The focused control, unless it is the assistant's own. */
export function focusedRef(registry: Map<number, Registered>): AssistCursor["focused"] {
  const a = document.activeElement;
  if (!a || a === document.body || a.closest(OWN)) return null;
  const n = [...registry.entries()].find(([, r]) => r.el === a)?.[0] ?? null;
  const l = labelOf(a);
  return { kind: kindOf(a), label: l.untrusted ? "" : l.label.slice(0, SCREEN_LIMITS.label * 2), n };
}

/** Selected text on the page (not in the assistant): untrusted, because it may be text someone else typed. */
export function selectedText(): { text: string; node: Node | null } | null {
  const s = window.getSelection?.();
  const t = s?.toString().replace(/\s+/g, " ").trim();
  if (!s || !t) return null;
  const node = s.anchorNode;
  const el = node instanceof Element ? node : node?.parentElement;
  if (el?.closest(OWN)) return null;
  return { text: t.slice(0, SCREEN_LIMITS.selection), node };
}
