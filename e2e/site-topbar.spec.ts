// GP19. A coherent top bar (docs/wave3.md 5; research/wave3/topbar-design.md). Owner: w3-topbar-shell.
// At 1440 and 1280 with the agent docked, at 1024 and at 390 the header never overflows; every bar control is 32 px
// tall and every pill segment 28 px; no badge wash appears in the bar (the only fill colors are the model dot and the
// amber persona avatar). Tab shows the same blue ring on every header control. The persona menu switches personas,
// the clock popover advances time, the model popover shows spend, search lives in the sidebar, and detail pages put
// the record's name in the breadcrumb instead of its id.
import type { Page } from "@playwright/test";
import { expect, openApp, test, TID, viewAs } from "./fixtures";
import { W3_SHELL_TID as S } from "../packages/contracts/src/w3/testids-shell";
import { W3_TOPBAR_SHELL_DOM as DOM } from "../packages/contracts/src/ext/w3-topbar-shell";

const LAYOUTS = [
  { name: "1440 docked", width: 1440, height: 900, docked: true },
  { name: "1280 docked", width: 1280, height: 800, docked: true },
  { name: "1024", width: 1024, height: 768, docked: false },
  { name: "390", width: 390, height: 844, docked: false },
] as const;

const GREEN_3 = "rgb(230, 246, 235)";
const AMBER_3 = "rgb(255, 248, 231)";
const BLUE_RING = /rgb\(0, 144, 255\) 0px 0px 0px (2px inset|3px)/;

const header = (page: Page) => page.locator(`header:has([data-testid="${S.envPill}"])`);

test("GP19: the top bar fits, lines up and reads as one strip at four widths", async ({ page }) => {
  for (const l of LAYOUTS) {
    await test.step(`${l.name}: no overflow, 32 px controls, 28 px segments, no badge fill`, async () => {
      await page.setViewportSize({ width: l.width, height: l.height });
      await openApp(page, "/app/people/wrk_0001");
      const bar = header(page);
      await expect(bar).toBeVisible();
      if (l.docked) {
        await expect(page.getByTestId(S.agentToggle)).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator(`#${DOM.agentPanel}`)).toBeVisible();
      }
      const m = await bar.evaluate((h) => {
        const box = (e: Element) => e.getBoundingClientRect();
        const controls = [...h.querySelectorAll(":scope > button, [data-testid=env-pill]")].map((e) => ({ name: e.getAttribute("aria-label") ?? e.getAttribute("data-testid"), h: box(e).height }));
        const segments = [...h.querySelectorAll("[data-seg]")].map((e) => ({ name: e.getAttribute("data-testid"), h: box(e).height }));
        const fills = [...h.querySelectorAll("*")].map((e) => ({ bg: getComputedStyle(e).backgroundColor, avatar: e.hasAttribute("data-avatar") }));
        const model = h.querySelector("[data-testid=provider-badge]")!;
        return { scroll: h.scrollWidth, client: h.clientWidth, controls, segments, fills, modelBg: getComputedStyle(model).backgroundColor };
      });
      expect(m.scroll, `${l.name}: header scrollWidth ${m.scroll} within clientWidth ${m.client}`).toBeLessThanOrEqual(m.client);
      expect(m.controls.length).toBeGreaterThanOrEqual(3);
      for (const c of m.controls) expect(c.h, `${l.name}: ${c.name} is 32 px`).toBe(32);
      expect(m.segments.map((s) => s.name)).toEqual([TID.providerBadge, TID.simClock, TID.viewingAs]);
      for (const s of m.segments) expect(s.h, `${l.name}: segment ${s.name} is 28 px`).toBe(28);
      expect(m.fills.filter((f) => f.bg === GREEN_3), "no green-3 wash in the bar").toEqual([]);
      expect(m.fills.filter((f) => f.bg === AMBER_3 && !f.avatar), "amber only on the persona avatar").toEqual([]);
      expect(m.modelBg, "the model segment is not a status badge").toBe("rgba(0, 0, 0, 0)");
    });
  }

  await test.step("390: the sidebar is a drawer, so the bar carries the search icon; the persona is an avatar", async () => {
    await expect(header(page).getByRole("button", { name: /search/i })).toBeVisible();
    const w = await page.getByTestId(TID.viewingAs).evaluate((e) => e.getBoundingClientRect().width);
    expect(w).toBe(28);
  });

  await test.step("1440: Tab shows the same blue ring on every header control", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "/app/people/wrk_0001");
    // Reach the bar from the keyboard: Tab until focus lands in the header, then walk it.
    const inHeader = () => page.evaluate(() => !!document.activeElement?.closest("header"));
    for (let i = 0; i < 40 && !(await inHeader()); i++) await page.keyboard.press("Tab");
    const seen: string[] = [];
    for (let i = 0; i < 12 && (await inHeader()); i++) {
      const name = await page.evaluate(() => document.activeElement!.getAttribute("data-testid") ?? document.activeElement!.getAttribute("aria-label") ?? document.activeElement!.textContent ?? "");
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.activeElement!).boxShadow), { message: `${name} shows the blue ring`, timeout: 2_000 }).toMatch(BLUE_RING);
      seen.push(name);
      await page.keyboard.press("Tab");
    }
    expect(seen).toEqual(["Toggle sidebar", "People", TID.providerBadge, TID.simClock, TID.viewingAs, S.agentToggle]);
  });

  await test.step("the persona menu is a radio menu grouped under the demo control label", async () => {
    await page.getByTestId(TID.viewingAs).click();
    const menu = page.getByRole("menu");
    await expect(menu).toContainText("Viewing as (demo control)");
    await expect(menu.getByRole("menuitemradio")).toHaveCount(3);
    await expect(menu.getByRole("menuitemradio", { name: /Dana/ })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await viewAs(page, "theo");
    await expect(page.getByTestId(TID.viewingAs)).toHaveAttribute("aria-label", /Theo Marsh/);
    await viewAs(page, "dana");
  });

  await test.step("the clock popover advances simulated time; the model popover shows spend", async () => {
    await page.getByTestId(TID.simClock).click();
    const clock = page.getByTestId(S.clockPopover);
    await expect(clock).toContainText("Simulated time");
    await expect(clock).toContainText(/Monday, October 26, 8:30\sAM PT/);
    await expect(clock).toContainText("Paused");
    await clock.getByRole("button", { name: "+1 hour" }).click();
    await expect(page.getByTestId(TID.simClock)).toContainText(/9:30/);
    await page.keyboard.press("Escape");
    await page.getByTestId(TID.providerBadge).click();
    const model = page.getByTestId(S.modelPopover);
    await expect(model).toContainText("Scripted, no model calls");
    await expect(model).toContainText(/Spent today\s*\$\d+\.\d{2}/);
    await page.keyboard.press("Escape");
  });

  await test.step("search sits in the sidebar; Cmd or Ctrl+K opens it anywhere; hiding the sidebar puts it in the bar", async () => {
    await page.getByTestId(S.sidebarSearch).click();
    await expect(page.getByTestId(TID.cmdkInput)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId(TID.cmdkInput)).toBeHidden();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId(TID.cmdkInput)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(header(page).getByRole("button", { name: /search/i })).toHaveCount(0);
    const toggle = header(page).getByRole("button", { name: "Toggle sidebar" });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.click();
    await expect(page.getByTestId(S.sidebarSearch)).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await header(page).getByRole("button", { name: /search/i }).click();
    await expect(page.getByTestId(TID.cmdkInput)).toBeVisible();
    await page.keyboard.press("Escape");
    await header(page).getByRole("button", { name: "Toggle sidebar" }).click();
    await expect(page.getByTestId(S.sidebarSearch)).toBeVisible();
  });

  await test.step("detail breadcrumbs show names, not wrk_ or pay_ ids", async () => {
    const crumb = header(page).getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumb).toContainText("Dana Whitfield (demo)");
    await expect(crumb).not.toContainText("wrk_");
    await openApp(page, "/app/payroll/pay_2026_09_15");
    await expect(crumb).toContainText("Sep 1 to Sep 15");
    await expect(crumb).not.toContainText("pay_");
  });
});
