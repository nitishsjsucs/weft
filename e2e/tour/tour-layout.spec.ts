// The tour's ring and card geometry at laptop sizes with the agent panel docked (owner: tour): the ring encloses the
// visible part of its target and tracks it when only its position changes, an open popover or menu paints over the
// ring, and the card never covers the target, an open app layer, the sidebar or the docked agent panel. The flag
// popover stays inside the main column. Deep links, so no reading dwell.
import type { Page } from "@playwright/test";
import { expect, readyCard, test } from "./tour-fixtures";

interface R { l: number; t: number; r: number; b: number }
interface Scene {
  target: R | null; ring: R | null; ringZ: number | null; card: R | null; cardZ: number; place: string | null;
  layers: { rect: R; z: number }[]; sidebar: R | null; agent: R | null; main: R | null; targetInAgent: boolean;
}

/** One read of everything the assertions compare, in the page. The target's visible rect is cut by every overflow-clipping ancestor. */
async function scene(page: Page): Promise<Scene> {
  return page.evaluate(() => {
    const R = (r: DOMRect | undefined | null) => (r ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null);
    const card = document.querySelector<HTMLElement>("[data-tour-card]");
    const body = card?.querySelector("p[id]");
    const target = body ? document.querySelector(`[aria-describedby~="${body.id}"]`) : null;
    let vis = R(target?.getBoundingClientRect());
    for (let p = target?.parentElement; vis && p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        const b = p.getBoundingClientRect();
        vis = { l: Math.max(vis.l, b.left + p.clientLeft), t: Math.max(vis.t, b.top + p.clientTop), r: Math.min(vis.r, b.left + p.clientLeft + p.clientWidth), b: Math.min(vis.b, b.top + p.clientTop + p.clientHeight) };
      }
      if (cs.position === "fixed") break;
    }
    if (vis) vis = { l: Math.max(0, vis.l), t: Math.max(0, vis.t), r: Math.min(innerWidth, vis.r), b: Math.min(innerHeight, vis.b) };
    const ring = document.querySelector<HTMLElement>("[data-tour-ring]");
    const layers = [...document.querySelectorAll<HTMLElement>('[data-radix-popper-content-wrapper], [role="dialog"], [role="menu"]')]
      .filter((n) => !n.closest("[data-tour-card]") && !n.querySelector("[data-tour-card]"))
      .map((n) => ({ rect: R(n.getBoundingClientRect())!, z: Number(getComputedStyle(n.closest("[data-radix-popper-content-wrapper]") ?? n).zIndex) || 0 }))
      .filter((x) => x.rect.r - x.rect.l > 1 && x.rect.b - x.rect.t > 1);
    const agent = document.querySelector('aside[aria-label="Agent"]');
    return {
      target: vis, ring: R(ring?.getBoundingClientRect()), ringZ: ring ? Number(getComputedStyle(ring).zIndex) : null,
      card: R(card?.getBoundingClientRect()), cardZ: Number(getComputedStyle(card?.closest("[data-radix-popper-content-wrapper]") ?? card ?? document.body).zIndex) || 0, place: card?.getAttribute("data-place") ?? null, layers,
      sidebar: R(document.querySelector('nav[aria-label="App"]')?.closest("aside")?.getBoundingClientRect()),
      agent: R(agent?.getBoundingClientRect()), main: R(document.querySelector("[data-app-main]")?.getBoundingClientRect()),
      targetInAgent: !!target && !!agent?.contains(target),
    };
  });
}

const overlap = (a: R | null, b: R | null): number =>
  a && b ? Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t)) : 0;

function expectRingEncloses(s: Scene, label: string): void {
  expect(s.ring, `${label}: ring shows`).not.toBeNull();
  const t = s.target!, r = s.ring!;
  // Encloses the visible target within 1 px, and stays within 6 px of it (no halo over the neighbours).
  expect(r.l, `${label}: ring left`).toBeLessThanOrEqual(t.l + 1);
  expect(r.t, `${label}: ring top`).toBeLessThanOrEqual(t.t + 1);
  expect(r.r, `${label}: ring right`).toBeGreaterThanOrEqual(t.r - 1);
  expect(r.b, `${label}: ring bottom`).toBeGreaterThanOrEqual(t.b - 1);
  expect(Math.max(t.l - r.l, t.t - r.t, r.r - t.r, r.b - t.b), `${label}: ring hugs the target`).toBeLessThanOrEqual(6);
}

function expectCardClear(s: Scene, label: string): void {
  expect(s.card, `${label}: card shows`).not.toBeNull();
  expect(overlap(s.card, s.target), `${label}: card over target`).toBeLessThanOrEqual(1);
  // Clear of every open layer, or (no clean spot left on a short screen) painted under it.
  for (const l of s.layers) if (overlap(s.card, l.rect) > 1) expect(s.cardZ, `${label}: card over an open layer`).toBeLessThan(l.z);
  expect(overlap(s.card, s.sidebar), `${label}: card over the sidebar`).toBeLessThanOrEqual(1);
  expect(overlap(s.card, s.agent), `${label}: card over the docked agent panel`).toBeLessThanOrEqual(1);
}

/** The ring paints under any app layer: with the ring made hit-testable for a moment, a point on its edge inside the layer hits the layer. */
async function ringUnderLayers(page: Page): Promise<{ checked: number; overRing: number }> {
  return page.evaluate(() => {
    const ring = document.querySelector<HTMLElement>("[data-tour-ring]");
    if (!ring) return { checked: 0, overRing: 0 };
    const rr = ring.getBoundingClientRect();
    const wrappers = [...document.querySelectorAll<HTMLElement>("[data-radix-popper-content-wrapper]")].filter((w) => !w.querySelector("[data-tour-card]"));
    ring.style.pointerEvents = "auto";
    let checked = 0, overRing = 0;
    try {
      for (const w of wrappers) {
        const wr = w.getBoundingClientRect();
        const pts: [number, number][] = [];
        for (let x = Math.max(rr.left, wr.left) + 2; x < Math.min(rr.right, wr.right) - 2; x += 24) pts.push([x, rr.top + 1], [x, rr.bottom - 1]);
        for (let y = Math.max(rr.top, wr.top) + 2; y < Math.min(rr.bottom, wr.bottom) - 2; y += 24) pts.push([rr.left + 1, y], [rr.right - 1, y]);
        for (const [x, y] of pts) {
          if (x < wr.left || x > wr.right || y < wr.top || y > wr.bottom) continue;
          checked++;
          if (document.elementFromPoint(x, y) === ring) overRing++;
        }
      }
    } finally { ring.style.pointerEvents = ""; }
    return { checked, overRing };
  });
}

async function openStep(page: Page, id: string): Promise<void> {
  await page.goto(`/app?tour=${id}`);
  await expect(readyCard(page, id)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(400);
}

for (const [width, height] of [[1280, 800], [1440, 900]] as const) {
  test.describe(`${width}x${height}, agent panel docked`, () => {
    test.use({ viewport: { width, height } });

    test("ring and card geometry on every anchored step", async ({ page, world }) => {
      test.skip(!world.rich, "geometry is checked on the rich world the tour runs on");
      test.setTimeout(240_000);
      await page.addInitScript(() => { try { localStorage.setItem("weft.agentOpen", "1"); } catch { /* blocked */ } });
      for (const id of ["env-pill", "agent-panel", "deliver-notice", "inbox-proposal", "rate-live", "audit", "payroll-flags", "ask-chart", "person", "expenses", "time-off", "hiring", "memory", "routines", "integrations", "permissions"]) {
        await openStep(page, id);
        const s = await scene(page);
        expect(s.agent, `${id}: agent panel docked`).not.toBeNull();
        expectRingEncloses(s, id);
        expectCardClear(s, id);
        // The ring sits under every app layer (z 45 in the page, one above its own layer otherwise, never the card's 70).
        for (const l of s.layers) if (s.ringZ! < 50) expect(s.ringZ!, `${id}: ring under the open layer`).toBeLessThan(l.z || 50);
        expect(s.ringZ!, `${id}: ring under the card`).toBeLessThan(70);
      }
    });

    test("payroll flags: the popover paints over the ring, stays in the main column, and the ring tracks a move", async ({ page, world }) => {
      test.skip(!world.rich, "the flags are on the rich world's draft");
      await page.addInitScript(() => { try { localStorage.setItem("weft.agentOpen", "1"); } catch { /* blocked */ } });
      await openStep(page, "payroll-flags");
      const s = await scene(page);
      const pop = s.layers.find((l) => l.z === 50);
      expect(pop, "the blocking flag's popover is open").toBeTruthy();
      expect(overlap(pop!.rect, s.ring), "the popover overlaps the ring here, so the order matters").toBeGreaterThan(0);
      const order = await ringUnderLayers(page);
      expect(order.checked, "ring edge points inside the popover").toBeGreaterThan(0);
      expect(order.overRing, "ring edge points painted over the popover").toBe(0);
      // Inside the main column: never over the sidebar or the docked panel.
      expect(pop!.rect.l, "popover left inside main").toBeGreaterThanOrEqual(s.main!.l - 1);
      expect(pop!.rect.r, "popover right inside main").toBeLessThanOrEqual(s.main!.r + 1);
      expect(pop!.rect.b, "popover bottom inside main").toBeLessThanOrEqual(s.main!.b + 1);
      expect(overlap(pop!.rect, s.sidebar), "popover over the sidebar").toBe(0);
      expectCardClear(s, "payroll-flags");
      expectRingEncloses(s, "payroll-flags");

      // A move without a resize or a DOM insertion (a style change above the table) is followed within a few frames.
      const before = s.target!;
      await page.evaluate(() => { const m = document.querySelector<HTMLElement>("[data-app-main] > *"); if (m) m.style.paddingTop = `${(parseFloat(getComputedStyle(m).paddingTop) || 0) + 40}px`; });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
      const after = await scene(page);
      expect(Math.abs(after.target!.t - before.t), "the group moved").toBeGreaterThan(20);
      expectRingEncloses(after, "payroll-flags after a move");
    });

    test("env pill: a menu or popover the person opens paints over the ring and the card moves clear of it", async ({ page, world }) => {
      void world;
      await page.addInitScript(() => { try { localStorage.setItem("weft.agentOpen", "1"); } catch { /* blocked */ } });
      await openStep(page, "env-pill");
      const triggers = page.locator('[data-tour~="env-pill"] button');
      const n = await triggers.count();
      expect(n, "env pill controls").toBeGreaterThan(1);
      for (let i = 0; i < n; i++) {
        await triggers.nth(i).click();
        await page.waitForTimeout(400);
        const s = await scene(page);
        expect(s.layers.length, `control ${i} opens a layer`).toBeGreaterThan(0);
        expectCardClear(s, `env pill control ${i}`);
        expect((await ringUnderLayers(page)).overRing, `env pill control ${i}: ring over the layer`).toBe(0);
        await page.keyboard.press("Escape");
        // Escape closes the app layer first; the tour stays on its step.
        await expect(readyCard(page, "env-pill")).toBeVisible();
        await page.waitForTimeout(200);
      }
    });
  });
}
