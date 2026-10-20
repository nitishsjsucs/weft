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
  // A step that docks its card in the panel's column (the payroll flags) is the one exception, and then the card stays inside it.
  if (s.place === "panel") expect(overlap(s.card, s.agent), `${label}: card inside the docked agent panel`).toBeGreaterThanOrEqual((s.card!.r - s.card!.l) * (s.card!.b - s.card!.t) - 1);
  else expect(overlap(s.card, s.agent), `${label}: card over the docked agent panel`).toBeLessThanOrEqual(1);
}

/** What a click at the centre of the card's Back and primary buttons lands on: the button itself, or the layer over it. */
async function buttonsCovered(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const sel of ["[data-tour-card] [data-tour-back]", "[data-tour-card] [data-tour-primary]"]) {
      const b = document.querySelector<HTMLElement>(sel);
      if (!b) continue;
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !b.contains(hit)) out.push(`${sel} covered by ${(hit?.textContent ?? "").trim().slice(0, 60)}`);
    }
    return out;
  });
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
      for (const id of ["env-pill", "agent-panel", "deliver-notice", "inbox-proposal", "rate-live", "audit", "payroll-flags", "ask-chart", "person", "expenses", "time-off", "hiring", "memory", "routines", "permissions"]) {
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

// The app shell scrolls inside its panes, never the document. A screen reader table in the agent's chart answer once
// escaped every overflow clip (position absolute with no positioned ancestor), so from step 12 on the document was
// 285 px taller than the window and each step's scroll slid the whole shell up until a reset snapped it back.
for (const [width, height] of [[1280, 800], [1440, 900]] as const) {
  test.describe(`${width}x${height}, after the chart answer`, () => {
    test.use({ viewport: { width, height } });

    test("the document never scrolls on steps 12 to 19, and the ring is placed on the settled page", async ({ page, world }) => {
      test.skip(!world.rich, "the tour runs on the rich world");
      test.setTimeout(240_000);
      await page.addInitScript(() => { try { localStorage.setItem("weft.agentOpen", "1"); } catch { /* blocked */ } });
      // The real path from the notice on, so the agent thread holds the notice run and the chart answer and runs
      // taller than the panel, as it does on a full tour.
      await openStep(page, "deliver-notice");
      for (const id of ["deliver-notice", "agent-run", "inbox-proposal", "approve", "rate-live", "audit", "payroll-flags"]) {
        const c = readyCard(page, id);
        await expect(c).toBeVisible({ timeout: 30_000 });
        await expect(c.locator("[data-tour-primary]")).toBeEnabled({ timeout: 25_000 });
        await c.locator("[data-tour-primary]").click();
      }
      await expect(readyCard(page, "ask-chart")).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[data-tour~="agent-composer"] textarea')).toHaveValue(/Show payroll cost by month/, { timeout: 10_000 });
      await readyCard(page, "ask-chart").locator("[data-tour-primary]").click();
      await expect(page.locator('[data-tour~="agent-chart"]')).toBeVisible({ timeout: 20_000 });
      await expect(readyCard(page, "ask-chart").locator('[data-tour-status="done"]')).toBeVisible({ timeout: 20_000 });
      // A per-frame probe: the document's scroll offset and its overflow past the window, and the ring's distance
      // from its target on every frame where both show (installed again after a full page load).
      const probe = () => page.evaluate(() => {
        const w = window as unknown as { __tp?: { y: number; over: number; drift: number } };
        if (!w.__tp) {
          const tp = { y: 0, over: 0, drift: 0 };
          w.__tp = tp;
          const tick = () => {
            const se = document.scrollingElement!;
            // The portal is a page that scrolls the document; only the app shell must not.
            if (location.pathname.startsWith("/app")) {
              tp.y = Math.max(tp.y, window.scrollY, se.scrollTop);
              tp.over = Math.max(tp.over, se.scrollHeight - window.innerHeight);
            }
            const ring = document.querySelector("[data-tour-ring]");
            const body = document.querySelector("[data-tour-card][data-ready=true] p[id]");
            const target = body ? document.querySelector(`[aria-describedby~="${body.id}"]`) : null;
            // A drawer or a popover may still slide in after ready; the steps checked here have none.
            if (ring && target && !ring.getAttribute("data-clip") && !ring.getAttribute("data-tight") && !document.querySelector('[role="dialog"]')) {
              const a = ring.getBoundingClientRect(), b = target.getBoundingClientRect();
              tp.drift = Math.max(tp.drift, Math.abs(a.top + 4 - b.top), Math.abs(a.left + 4 - b.left));
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
        const out = { ...w.__tp };
        w.__tp.y = 0; w.__tp.over = 0; w.__tp.drift = 0;
        return out;
      });
      await probe();
      await readyCard(page, "ask-chart").locator("[data-tour-primary]").click();
      for (const id of ["person", "expenses", "time-off", "hiring", "portal", "memory", "routines", "permissions"]) {
        await expect(readyCard(page, id)).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(900);
        const p = await probe();
        expect(p.y, `${id}: the document scrolled`).toBe(0);
        expect(p.over, `${id}: the document is taller than the window`).toBeLessThanOrEqual(0);
        // A ring drawn while its target still moves (one frame behind a smooth scroll) shows as drift here.
        if (id !== "portal") expect(p.drift, `${id}: the ring trailed its target`).toBeLessThanOrEqual(2);
        await readyCard(page, id).locator("[data-tour-primary]").click();
      }
    });
  });
}

// With no clean spot left (a flag lower in the group opens a tall popover on a short laptop screen) the card drops
// under the app's layers. Radix copies the content's z-index to its wrapper only once, so the drop has to reach the
// wrapper: every popover the person opens paints over the card, never the reverse.
for (const [width, height] of [[1280, 800], [1366, 768]] as const) {
  test.describe(`${width}x${height}, every flag in the group`, () => {
    test.use({ viewport: { width, height } });

    test("payroll flags: the card never paints over a flag popover the person opens", async ({ page, world }) => {
      test.skip(!world.rich, "the flags are on the rich world's draft");
      await page.addInitScript(() => { try { localStorage.setItem("weft.agentOpen", "1"); } catch { /* blocked */ } });
      await openStep(page, "payroll-flags");
      const chips = page.locator('[data-tour~="payroll-needs-review"] [data-tour~="payroll-flag"]');
      const n = await chips.count();
      expect(n, "flags in the Needs Review group").toBeGreaterThan(3);
      let overlapped = 0;
      for (let i = 0; i < n; i++) {
        // Close the open popover first (Escape closes the app layer, never the tour), then open this flag.
        if (await page.locator("[data-radix-popper-content-wrapper]:not(:has([data-tour-card]))").count()) await page.keyboard.press("Escape");
        await chips.nth(i).scrollIntoViewIfNeeded();
        await chips.nth(i).evaluate((el) => (el as HTMLElement).click());
        await page.waitForTimeout(350);
        const s = await scene(page);
        const pop = s.layers.find((l) => l.z === 50);
        expect(pop, `flag ${i}: its popover is open`).toBeTruthy();
        await expect(readyCard(page, "payroll-flags")).toBeVisible();
        // Back and Next stay reachable while any flag's popover is open (the card docks in the panel's column).
        expect(await buttonsCovered(page), `flag ${i}: the card's buttons are covered`).toEqual([]);
        if (overlap(s.card, pop!.rect) > 1) {
          overlapped++;
          expect(s.cardZ, `flag ${i}: the card over the popover`).toBeLessThan(pop!.z);
          await expect(page.locator("[data-tour-card]")).toHaveAttribute("data-under-layer", "true");
        }
      }
      console.log(`${width}x${height}: ${n} flags, the card under ${overlapped} popovers`);
    });
  });
}

// On a phone the agent panel is a full-screen sheet. Step 4's target (Deliver) is on the page, so the sheet stays
// closed there: the real button is visible and tappable, and the Deliver click opens the sheet with its run (step 5).
test.describe("390x844, deliver notice", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("step 4: the agent sheet is closed and the real Deliver button can be tapped", async ({ page }) => {
    await openStep(page, "deliver-notice");
    const target = page.locator('[data-tour~="sim-deliver"][data-scenario="ca_de2088_rate_change"]');
    await expect(target).toBeVisible();
    await expect(page.locator('aside[aria-label="Agent"]')).toHaveCount(0);
    const hit = await target.evaluate((el) => { const r = el.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!h && el.contains(h); });
    expect(hit, "a tap on Deliver reaches the button").toBe(true);
    await expect(page.locator("[data-tour-card]")).toHaveAttribute("data-target-found", "true");
  });
});

/** Every x-axis tick label of every chart on the page: no two intersect and none passes the svg's edges. */
async function tickProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const svg of document.querySelectorAll(".recharts-wrapper svg")) {
      const sr = svg.getBoundingClientRect();
      const all = [...svg.querySelectorAll(".recharts-cartesian-axis-tick-label text")].map((t) => ({ t: t.textContent ?? "", r: t.getBoundingClientRect() })).filter((x) => x.t);
      const bottom = Math.max(...all.map((x) => x.r.top));
      const ticks = all.filter((x) => Math.abs(x.r.top - bottom) < 2);
      if (!ticks.length) out.push("no x ticks");
      for (let i = 0; i < ticks.length; i++) {
        const a = ticks[i]!;
        if (a.r.right > sr.right + 0.5 || a.r.left < sr.left - 0.5) out.push(`"${a.t}" passes the chart edge`);
        for (let j = i + 1; j < ticks.length; j++) {
          const b = ticks[j]!;
          if (a.r.right > b.r.left && b.r.right > a.r.left) out.push(`"${a.t}" overlaps "${b.t}"`);
        }
      }
    }
    return out;
  });
}

/** Table scrollers (the Table's own edge-fading wrapper) whose content runs past their box, with their first header. */
async function hiddenColumns(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-edge-fade]")]
    .filter((el) => el.querySelector("table") && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1)
    .map((el) => `${(el.querySelector("th")?.textContent ?? "").trim()}: ${el.scrollWidth} in ${el.clientWidth}`));
}

// The chart answer (step 11, scenario 7): short tick labels ("Oct*" for the month to date), thinned when the panel's
// band is narrower than a label, so none runs into its neighbour or past the chart.
for (const [width, height] of [[1280, 800], [1366, 768], [1440, 900], [1512, 982], [390, 844]] as const) {
  test.describe(`${width}x${height}, the chart answer's axis`, () => {
    test.use({ viewport: { width, height } });
    test("tick labels never overlap or clip, in the panel and on Reports", async ({ page, world }) => {
      test.skip(!world.rich, "the chart reads the rich world's history");
      await page.addInitScript(() => { try { localStorage.setItem("weft.agentOpen", "1"); } catch { /* blocked */ } });
      await openStep(page, "ask-chart");
      // The step types the question into the composer first; Next sends it once it is there.
      await expect(page.locator('[data-tour~="agent-composer"] textarea')).toHaveValue(/Show payroll cost by month/, { timeout: 15_000 });
      await expect(readyCard(page, "ask-chart").locator("[data-tour-primary]")).toBeEnabled({ timeout: 15_000 });
      await readyCard(page, "ask-chart").locator("[data-tour-primary]").click();
      await expect(page.locator('[data-tour~="agent-chart"]')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[data-tour~="agent-chart"] .recharts-wrapper')).toBeVisible();
      await page.waitForTimeout(300);
      expect(await tickProblems(page), "panel chart ticks").toEqual([]);
      await expect(page.getByTestId("chart-partial-note")).toContainText("Oct*");
      await page.goto("/app/reports");
      await expect(page.locator('[data-testid="reports-chart"] .recharts-wrapper')).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(300);
      expect(await tickProblems(page), "Reports chart ticks").toEqual([]);
    });
  });
}

// Wide tables at the sizes the demo runs: the docked panel at 1280 and the phone. Every column shows without a
// sideways scroll (a narrow column stacks the rows), except the permissions matrix on a phone, whose person column
// stays pinned while it scrolls.
for (const [width, height] of [[1280, 800], [390, 844]] as const) {
  test.describe(`${width}x${height}, wide tables`, () => {
    test.use({ viewport: { width, height } });
    test("tables fit their column", async ({ page, world }) => {
      test.skip(!world.rich, "the tables are filled on the rich world");
      test.setTimeout(240_000);
      await page.addInitScript(() => { try { localStorage.setItem("weft.agentOpen", "1"); localStorage.setItem("weft.tour.seen", "1"); } catch { /* blocked */ } });
      const pages = ["/app/reports", "/app/simulators", "/app/routines", "/app/compliance", "/app/benefits", "/app/it", "/app/contractors", "/app/offboarding", ...(width > 600 ? ["/app/settings/permissions"] : [])];
      for (const path of pages) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(700);
        expect(await hiddenColumns(page), `${path}: columns behind a sideways scroll`).toEqual([]);
      }
    });
  });
}

test.describe("390x844, the new rate and the flags on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("step 8: the ringed CA SUI row shows its tax, rate and source", async ({ page, world }) => {
    test.skip(!world.rich, "the tour runs on the rich world");
    await openStep(page, "rate-live");
    const row = page.locator('[data-tour~="rate-row"][data-jurisdiction="CA"][data-code="sui"][data-current="true"]');
    await expect(row).toBeVisible();
    const seen = await row.evaluate((el) => {
      const cells = [...el.querySelectorAll("td")];
      const vw = document.documentElement.clientWidth;
      return cells.map((c) => { const r = c.getBoundingClientRect(); return r.left >= -0.5 && r.right <= vw + 0.5; });
    });
    expect(seen, "every cell of the ringed row is inside the window").toEqual(seen.map(() => true));
  });
  test("step 10: Back and Next stay reachable with any flag's popover open", async ({ page, world }) => {
    test.skip(!world.rich, "the flags are on the rich world's draft");
    await openStep(page, "payroll-flags");
    const chips = page.locator('[data-tour~="payroll-needs-review"] [data-tour~="payroll-flag"]');
    const n = await chips.count();
    expect(n, "flags in the Needs Review group").toBeGreaterThan(3);
    for (let i = 0; i < n; i++) {
      if (await page.locator("[data-radix-popper-content-wrapper]:not(:has([data-tour-card]))").count()) await page.keyboard.press("Escape");
      await chips.nth(i).scrollIntoViewIfNeeded();
      await chips.nth(i).evaluate((el) => (el as HTMLElement).click());
      await page.waitForTimeout(350);
      await expect(readyCard(page, "payroll-flags")).toBeVisible();
      expect(await buttonsCovered(page), `flag ${i}: the card's buttons are covered`).toEqual([]);
    }
  });
});
