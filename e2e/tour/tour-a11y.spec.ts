// The tour under reduced motion, at phone width, and for screen readers (owner: tour).
import { expect, noHorizontalScroll, readyCard, test } from "./tour-fixtures";

async function startTour(page: import("@playwright/test").Page, query = "1"): Promise<void> {
  await page.goto(`/app?tour=${query}`);
  const skip = page.locator("[data-tour-reset-skip]");
  await expect(skip.or(readyCard(page)).first()).toBeVisible({ timeout: 20_000 });
  if (await skip.isVisible()) await skip.click();
  await expect(readyCard(page)).toBeVisible();
}

test("reduced motion: no ring pulse, no card animation, the prompt appears at once", async ({ page, world }) => {
  void world;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await startTour(page, "env-pill");
  const ring = page.locator('[data-tour-ring][data-target-found="true"]');
  await expect(ring).toBeVisible();
  expect(await ring.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  expect(await readyCard(page, "env-pill").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await page.goto("/app?tour=ask-chart");
  await expect(readyCard(page, "ask-chart")).toBeVisible();
  await expect(page.locator('[data-tour~="agent-composer"] textarea')).toHaveValue("Show payroll cost by month", { timeout: 300 });
});

test("screen readers: the card is a named dialog with a progressbar and named buttons", async ({ page, world }) => {
  void world;
  await startTour(page, "env-pill");
  const dialog = page.getByRole("dialog", { name: "Your demo controls" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
  for (const b of await dialog.getByRole("button").all()) expect((await b.getAttribute("aria-label")) ?? (await b.innerText()).trim()).not.toBe("");
  await expect(dialog.getByRole("button", { name: "Exit tour" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /autoplay/i })).toHaveAttribute("aria-pressed", "false");
  // The highlighted control is described by the card body while its step is active.
  const bodyId = await dialog.locator("p[id]").first().getAttribute("id");
  await expect(page.locator(`[data-tour~="env-pill"][aria-describedby="${bodyId}"]`)).toHaveCount(1);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the card is a sheet inside 16 px gutters, agent steps dock at the top, the run and the proposal keep their heads visible", async ({ page, world }) => {
    void world;
    await startTour(page);
    const check = async (stepId: string, top?: boolean) => {
      const c = readyCard(page, stepId);
      await expect(c).toBeVisible({ timeout: 20_000 });
      expect(await noHorizontalScroll(page), `${stepId} scroll width`).toBe(true);
      const box = (await c.boundingBox())!;
      if (stepId !== "welcome") {
        expect(box.x, `${stepId} left gutter`).toBeGreaterThanOrEqual(15.5);
        expect(box.x + box.width, `${stepId} right gutter`).toBeLessThanOrEqual(390 - 15.5);
        expect(box.y + box.height).toBeLessThanOrEqual(844);
        if (top !== undefined) await expect(c).toHaveAttribute("data-sheet", top ? "top" : /top|bottom/);
      }
      return c;
    };
    await (await check("welcome")).locator("[data-tour-primary]").click();
    await (await check("env-pill")).locator("[data-tour-primary]").click();
    await (await check("agent-panel", true)).locator("[data-tour-primary]").click();
    await (await check("deliver-notice", true)).locator("[data-tour-primary]").click();
    // The run step docks at the bottom on a phone (the tool lines it explains sit at the top of the panel) and waits
    // for Next once the run is waiting.
    const run = await check("agent-run");
    await expect(run).toHaveAttribute("data-sheet", "bottom");
    await expect(run.locator("[data-tour-primary]")).toBeEnabled({ timeout: 25_000 });
    await run.locator("[data-tour-primary]").click();
    const inbox = await check("inbox-proposal");
    await expect(inbox).toHaveAttribute("data-sheet", "bottom");
    await inbox.locator("[data-tour-primary]").click({ timeout: 30_000 });
    await check("approve");
    await page.goto("/app/payroll?tour=ask-chart");
    const ask = await check("ask-chart", true);
    await ask.locator("[data-tour-primary]").click();
    // The chart stays up until Next.
    await expect(ask.locator('[data-tour-status="done"], [data-tour-note]').first()).toBeVisible({ timeout: 20_000 });
    await ask.locator("[data-tour-primary]").click();
    await check("person");
    await expect(page.locator('[data-tour~="person-tabs"]')).toBeVisible();
  });
});
