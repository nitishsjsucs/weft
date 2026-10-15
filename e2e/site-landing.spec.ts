// The landing page `/` (SPEC 11.2, P0-11). Owner: t6-site. Uses the plain Playwright test (no world reset): the
// page only reads public routes and must render with or without them.
import { expect, test } from "@playwright/test";

test.describe("landing page", () => {
  test("renders original copy, stats with a source, and the license footer", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("asks first");
    const stats = page.getByTestId("marketing-stats");
    await expect(stats).toHaveAttribute("data-source", /^(live|fallback)$/);
    await expect(stats).toContainText("real agencies contacted");
    await expect(stats).toContainText("0");
    await expect(page.locator("footer")).toContainText("Weft contributors, Apache-2.0");
    await expect(page.getByLabel("Simulators")).toContainText("CA EDD (sim)");
    await expect(page.locator('img[src^="http"], [style*="url(http"]')).toHaveCount(0);   // no hotlinked art
  });

  test("has no horizontal scroll at 390 px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    await expect(page.getByRole("link", { name: /open the demo/i }).first()).toBeVisible();
  });
});
