"use client";
// Applying the presentation tools on the client (research/cursor-assistant.md 4.3): each validated call in the run's
// steps carries its normalized effect (packages/executor/src/assist.ts), and this plays it: point (glide and ring),
// navigate (the route, then wait for the target to render, check it, scroll it into view and ring it), show (a
// global intent's validated link, or a page intent, or a non-mutating control after the live guard) and steps (a
// walkthrough the provider plays). A target that never appears is reported plainly; another element is never guessed.
import { ASSIST_NAV, intentDef, type AssistEffect, type AssistTarget, type WalkStepEffect } from "../../../../../packages/contracts/src/ext/assist";
import { normalizePath } from "@/lib/pathname";
import { setUrlState } from "@/lib/url-state";
import { HOSTED } from "@/lib/hosted/flags";
import { activate, findFirst, scrollToView, sleep, waitForAny } from "../tour/dom";
import { ASSIST_COPY } from "./copy";
import { actionable, entityOfEl, hrefOf, kindOf, labelOf, openLayer, pickAmong, resolveRegistered, type Registered } from "./dom";
import { linkRoute, liveShowRefusal } from "./guard";
import { runPageIntent } from "./intents";
import { viewPatch } from "./surface-core";

export const TARGET_WAIT_MS = 3_000;

export interface EffectEnv {
  /** The path and query now (no trailing slash). */
  here(): string;
  push(href: string): void;
  registry: Map<number, Registered>;
  /** Glide the pointer to the element and ring it with the label. */
  point(el: HTMLElement, label: string): Promise<void>;
  /** A line for the popover (a target that was not there). */
  note(text: string): void;
  walk(steps: WalkStepEffect[]): void;
  signal: AbortSignal;
  /** The height the bottom sheet covers on a phone (0 elsewhere): a target is brought into view above it. */
  sheetRoom?(): number;
}

const motion = (): ScrollBehavior => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"; } catch { return "auto"; } };

/**
 * Brings a target into view: centred, or on a phone, centred in the room above the bottom sheet (the sheet never
 * covers the ring it explains). A target taller than that room shows from its top.
 */
export function bringIntoView(el: HTMLElement, room = 0): Promise<void> {
  if (room <= 0) return scrollToView(el, "center", motion());
  const free = window.innerHeight - room;
  const h = el.getBoundingClientRect().height;
  if (h + 32 > free) return scrollToView(el, "start", motion());
  return scrollToView(el, "end", motion(), "nearest", Math.round(window.innerHeight - (free + h) / 2));
}
const pageName = (route: string) => ASSIST_NAV.find((n) => n.href === route.split("?")[0])?.label ?? "the page";

/**
 * Opens a route: the same page takes the link's view state in place (a drawer, a tab), as a whole, so a drawer the
 * link does not name closes and the page shows what the same link shows pasted (surface-core.ts viewPatch); another
 * page is a router push.
 */
export async function goTo(route: string, env: Pick<EffectEnv, "here" | "push" | "signal">): Promise<boolean> {
  const [path] = route.split("?", 1) as [string];
  const cur = env.here().split("?")[0]!;
  if (normalizePath(path) === cur) {
    setUrlState(viewPatch(route));
    return true;
  }
  env.push(route);
  const until = Date.now() + 8_000;
  while (!env.signal.aborted && env.here().split("?")[0] !== normalizePath(path) && Date.now() < until) await sleep(50, env.signal);
  return env.here().split("?")[0] === normalizePath(path);
}

/**
 * Waits up to TARGET_WAIT_MS for a target to render, then scrolls it into view and checks it is visible and uncovered.
 * With a hint (a person's name) only the element that holds it counts: when no card names them (their request was
 * decided, or the name reads differently there), the target is missing, and another person's control is never rung.
 */
export async function waitTarget(selectors: readonly string[] | undefined, hint: string | null, signal: AbortSignal, ms = TARGET_WAIT_MS, room = 0): Promise<{ el: HTMLElement | null; why: "missing" | "covered" | null }> {
  if (!Array.isArray(selectors) || !selectors.length) return { el: null, why: "missing" };
  const until = Date.now() + ms;
  const hit = await waitForAny([...selectors], ms, signal);
  if (!hit || signal.aborted) return { el: null, why: "missing" };
  let found = hint ? pickAmong(selectors, hint) : hit.el;
  // The list may still be filling in: the named card gets the rest of the wait, never a stand-in.
  while (!found && hint && !signal.aborted && Date.now() < until) { await sleep(100, signal); found = pickAmong(selectors, hint); }
  if (!found || signal.aborted) return { el: null, why: "missing" };
  let el: HTMLElement = found;
  await bringIntoView(el, room);
  for (let tries = 0; !actionable(el) && tries < 3; tries++) {
    await sleep(150, signal);
    // The page re-rendered it (a tab the link switched to): the same selectors find the new node, never another one.
    if (!el.isConnected) {
      const again = hint ? pickAmong(selectors, hint) : findFirst([...selectors])?.el ?? null;
      if (!again) return { el: null, why: "missing" };
      el = again;
      await bringIntoView(el, room);
    }
  }
  if (!actionable(el)) return { el: null, why: el.isConnected ? "covered" : "missing" };
  return { el, why: null };
}

async function resolveTarget(t: AssistTarget, selectors: readonly string[], hint: string | null, env: EffectEnv): Promise<{ el: HTMLElement | null; why: "missing" | "covered" | null }> {
  if (t.kind === "item") {
    const el = resolveRegistered(env.registry.get(t.n));
    if (!el) return { el: null, why: "missing" };
    await bringIntoView(el, env.sheetRoom?.() ?? 0);
    // Checked again after the scroll: a sticky header or an open layer may cover it there.
    if (!actionable(el)) {
      await sleep(150, env.signal);
      if (!actionable(el)) return { el: null, why: el.isConnected ? "covered" : "missing" };
    }
    return { el, why: null };
  }
  return waitTarget(selectors, hint, env.signal, TARGET_WAIT_MS, env.sheetRoom?.() ?? 0);
}

/** Waits up to OPEN_WAIT_MS for an open to show: the route (a drawer's key) changed, or another layer opened. */
export const OPEN_WAIT_MS = 1_000;
async function changedSince(before: { route: string; layer: ReturnType<typeof openLayer> }, env: Pick<EffectEnv, "here" | "signal">): Promise<boolean> {
  const until = Date.now() + OPEN_WAIT_MS;
  const moved = () => { const l = openLayer(); return env.here() !== before.route || (!!l && (!before.layer || l.kind !== before.layer.kind || l.label !== before.layer.label)); };
  while (!env.signal.aborted && !moved() && Date.now() < until) await sleep(50, env.signal);
  return env.signal.aborted || moved();
}

function miss(env: EffectEnv, why: "missing" | "covered", label: string, opened?: string, hint?: string | null): void {
  if (why === "covered") { env.note(ASSIST_COPY.covered(label)); return; }
  // A name nothing on the page holds: said as that, not as the control (which other cards may well have).
  if (hint) { env.note(ASSIST_COPY.nothingFor(hint, opened)); return; }
  env.note(opened ? ASSIST_COPY.openedNotFound(opened, label) : ASSIST_COPY.notFound(label));
}

/**
 * Plays one effect. The signal is the one its run had when the effect was queued: once that run is dismissed or a new
 * question starts, the effect stops at its next step and moves, points, presses and notes nothing more.
 */
export async function applyEffect(e: AssistEffect, env: EffectEnv): Promise<void> {
  if (env.signal.aborted) return;
  const live = () => !env.signal.aborted;
  switch (e.effect) {
    case "point": {
      const r = await resolveTarget(e.target, e.selectors, e.hint, env);
      if (!live()) return;
      if (r.el) await env.point(r.el, e.label); else miss(env, r.why!, e.label, undefined, e.target.kind === "anchor" ? e.hint : null);
      return;
    }
    case "navigate": {
      const ok = await goTo(e.route, env);
      if (!live()) return;
      if (!ok) { env.note(ASSIST_COPY.openedNotFound(pageName(e.route), "the page")); return; }
      if (!e.target) return;
      const r = await resolveTarget(e.target, e.selectors, e.hint, env);
      if (!live()) return;
      if (r.el) await env.point(r.el, e.label ?? "Here"); else miss(env, r.why!, e.label ?? "it", pageName(e.route), e.target.kind === "anchor" ? e.hint : null);
      return;
    }
    case "show": {
      if (e.via === "intent") {
        const def = intentDef(e.intent);
        // approval.card opens the Inbox on the proposal and rings its card; the popover shows the card from the trace.
        if (!def) return;
        if (e.route) {
          const ok = await goTo(e.route, env);
          if (!live()) return;
          if (!ok) { env.note(ASSIST_COPY.openedNotFound(pageName(e.route), def.title.toLowerCase())); return; }
        } else if (!(await runPageIntent(e.intent, e.params))) { if (live()) env.note(ASSIST_COPY.notOnPage); return; }
        if (!live()) return;
        if (e.selectors.length) {
          const r = await waitTarget(e.selectors, null, env.signal, TARGET_WAIT_MS, env.sheetRoom?.() ?? 0);
          if (!live()) return;
          if (r.el) await env.point(r.el, e.label ?? def.title); else miss(env, r.why!, e.label ?? def.title, e.route ? pageName(e.route) : undefined);
        }
        return;
      }
      const reg = e.target.kind === "item" ? env.registry.get(e.target.n) : undefined;
      const el = e.target.kind === "item" ? resolveRegistered(reg) : pickAmong(e.selectors, null);
      if (!el) { miss(env, "missing", e.label ?? "That"); return; }
      // The server allowed it; the live element is checked again before anything is pressed: its own kind (the node
      // found now, not the one the map recorded), its words, its form, its mark, and where a link it is in goes.
      const ent = entityOfEl(el, env.here());
      const facts = { tag: el.tagName, kind: kindOf(el), label: labelOf(el).label, testid: el.dataset.testid ?? null, anchor: reg?.item.anchor ?? null, type: el.getAttribute("type"), inForm: !!el.closest("form"), marked: !!el.closest("[data-assist-mutating]"), entity: ent?.entity ?? null, href: hrefOf(el) };
      const why = liveShowRefusal(facts, e.action, { hosted: HOSTED });
      if (why) { env.note(ASSIST_COPY.refused); await env.point(el, e.label ?? "Here"); return; }
      await bringIntoView(el, env.sheetRoom?.() ?? 0);
      if (!live()) return;
      // Opening a link (or a row inside one) is a navigation: the router opens its checked route; nothing is clicked,
      // so the browser never follows the link itself.
      const to = e.action === "open" ? linkRoute(facts, { hosted: HOSTED }) : null;
      if (to) { await goTo(to, env); return; }
      if (e.action === "open") {
        // A record with no link opens through its own handler (a paycheck row, an expense row): the URL or an open
        // layer says it did. When nothing changes, the popover says so instead of the answer claiming it opened.
        const before = { route: env.here(), layer: openLayer() };
        activate(el);
        if (!(await changedSince(before, env))) { if (live()) env.note(ASSIST_COPY.notOpened(e.label ?? (labelOf(el).label.slice(0, 40) || "That"))); }
        return;
      }
      if (e.action === "tab") activate(el);
      else if (e.action === "expand" || e.action === "collapse") {
        const open = e.action === "expand";
        if (el instanceof HTMLDetailsElement) el.open = open;
        else if ((el.getAttribute("aria-expanded") === "true") !== open) activate(el);
      }
      await env.point(el, e.label ?? labelOf(el).label.slice(0, 40));
      return;
    }
    case "steps":
      env.walk(e.steps);
      return;
    case "say":
    case "handoff":
      return;
  }
}
