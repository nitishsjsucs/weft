// Fixtures for the guided tour specs (owner: tour). Every test rebuilds the rich world through the web proxy
// (POST /v1/sim/reset { profile: "rich" }), checks the clock is at the seed time, and records console errors.
import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { WeftApi } from "../fixtures";
import { TOUR_STEPS, type TourStep } from "../../apps/web/src/components/tour/steps";

export { expect, TOUR_STEPS, WeftApi };
export type { TourStep };
export const SEED_NOW = "2026-10-26T15:30:00.000Z";

export interface TourWorld { rich: boolean; profile: string }

export const test = base.extend<{ weft: WeftApi; world: TourWorld; consoleErrors: string[] }>({
  weft: async ({ request }, use) => { await use(new WeftApi(request)); },
  world: async ({ weft }, use, info) => {
    const r = await weft.post<{ ok: boolean; profile?: string }>("/v1/sim/reset", { profile: "rich" }, 60_000);
    expect(r.ok).toBe(true);
    const health = await weft.get<{ seedProfile?: string }>("/v1/health");
    const clock = await weft.clock();
    expect(clock.now, "clock at the seed time after reset").toBe(SEED_NOW);
    expect(clock.rate).toBe(0);
    const profile = health.seedProfile ?? "base";
    // Until the rich layer lands (packages/seed/src/rich.ts), the world stays base and the tour runs on its fallbacks.
    info.annotations.push({ type: "seed-profile", description: profile });
    await use({ rich: profile === "rich", profile });
  },
  consoleErrors: async ({ page }, use) => {
    const errs: string[] = [];
    // The browser's own favicon probe on /app (no icon there) is not the page's error.
    page.on("console", (m) => { if (m.type() === "error" && !/\/favicon\.ico$/.test(m.location().url)) errs.push(m.text()); });
    page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
    page.on("response", (r) => { const u = new URL(r.url()); if (r.status() >= 400 && u.pathname !== "/favicon.ico") errs.push(`response ${r.status()} ${r.request().method()} ${u.pathname}${u.search}`); });
    await use(errs);
  },
});

export const card = (page: Page): Locator => page.locator("[data-tour-card]");
export const readyCard = (page: Page, stepId?: string): Locator => page.locator(`[data-tour-card][data-ready="true"]${stepId ? `[data-step="${stepId}"]` : ""}`);

/** The step id of the ready card, waiting until one shows. */
export async function readyStep(page: Page, timeout = 30_000): Promise<string> {
  const c = readyCard(page);
  await expect(c).toBeVisible({ timeout });
  return (await c.getAttribute("data-step")) ?? "";
}

/** The element the step rings: the one whose aria-describedby points at the card body. */
export async function targetInfo(page: Page): Promise<{ found: boolean; text: number; count: string | null }> {
  return page.evaluate(() => {
    const body = document.querySelector("[data-tour-card] p[id]");
    const el = body ? document.querySelector(`[aria-describedby~="${body.id}"]`) : null;
    return { found: !!el, text: (el?.textContent ?? "").trim().length, count: el?.getAttribute("data-count") ?? null };
  });
}

export async function noHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

export async function pressPrimary(page: Page, stepId: string): Promise<void> {
  await readyCard(page, stepId).locator("[data-tour-primary]").click();
}
