// The tour's controls (owner: tour): keyboard, exit, restart from the command menu, resume after a reload, once
// steps on Back, deep links, the reset offer on a dirty world, and a missing target. No reading dwell.
import { card, expect, readyCard, test } from "./tour-fixtures";

/** Starts the tour from a deep link or ?tour=1 and passes the reset offer a base world brings up. */
async function startTour(page: import("@playwright/test").Page, query = "1"): Promise<void> {
  await page.goto(`/app?tour=${query}`);
  const skip = page.locator("[data-tour-reset-skip]");
  const ready = readyCard(page);
  await expect(skip.or(ready).first()).toBeVisible({ timeout: 20_000 });
  if (await skip.isVisible()) await skip.click();
  await expect(ready).toBeVisible();
}

test("keyboard: arrows and Enter move, focus lands on the title, Esc exits", async ({ page, world }) => {
  void world;
  await startTour(page);
  await expect(readyCard(page, "welcome")).toBeVisible();
  const title = readyCard(page, "welcome").locator("h2");
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("H2");
  await expect(title).toHaveText("Welcome to Weft");
  await page.keyboard.press("ArrowRight");
  await expect(readyCard(page, "env-pill")).toBeVisible();
  await expect(page.locator("[data-tour-live]")).toContainText("Step 2 of 21");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-tour-card]") !== null)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(readyCard(page, "agent-panel")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(readyCard(page, "env-pill")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator("[data-tour-closed]")).toBeVisible();
  expect(await page.evaluate(() => [sessionStorage.getItem("weft.tour.v1"), localStorage.getItem("weft.tour.seen")])).toEqual([null, "1"]);
  // The command menu starts it again.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  await page.getByTestId("cmdk-input").fill("tour");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-tour-reset-skip]").or(readyCard(page, "welcome")).first()).toBeVisible();
});

test("a reload mid-tour offers to resume at the same step", async ({ page, world }) => {
  void world;
  await startTour(page, "inbox-proposal");
  await expect(readyCard(page, "inbox-proposal")).toBeVisible();
  await page.reload();
  await expect(page.locator("[data-tour-resume]")).toContainText("Resume tour (step 6 of 21)");
  await page.locator("[data-tour-resume-go]").click();
  await expect(readyCard(page, "inbox-proposal")).toBeVisible();
});

test("Back over the Deliver step shows Already delivered and never delivers twice", async ({ page, weft, world }) => {
  void world;
  await startTour(page, "deliver-notice");
  await readyCard(page, "deliver-notice").locator("[data-tour-primary]").click();
  await expect(readyCard(page, "agent-run")).toBeVisible({ timeout: 15_000 });
  await readyCard(page, "agent-run").locator("[data-tour-back]").click();
  await expect(readyCard(page, "deliver-notice").locator("[data-tour-note]")).toHaveText("Already delivered");
  const notices = await weft.notices();
  expect(notices.filter((n) => /DE ?2088/.test(n.formCode))).toHaveLength(1);
});

test("a dirty world brings up the reset offer; Reset returns the seed clock and no DE 2088", async ({ page, weft, world }) => {
  void world;
  await weft.post("/v1/sim/notices/deliver", { scenario: "ca_de2088_rate_change" });
  await page.goto("/app");
  await page.locator('[data-tour~="home-take-tour"]').click();
  const dialog = page.locator("[data-tour-reset]");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("DE 2088");
  await page.locator("[data-tour-reset-skip]").click();
  await expect(readyCard(page, "welcome")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
  await page.locator('[data-tour~="home-take-tour"]').click();
  await expect(dialog).toBeVisible();
  await page.locator("[data-tour-reset-go]").click();
  await expect(readyCard(page, "welcome")).toBeVisible({ timeout: 30_000 });
  expect((await weft.clock()).now).toBe("2026-10-26T15:30:00.000Z");
  expect((await weft.notices()).filter((n) => /DE ?2088/.test(n.formCode))).toHaveLength(0);
});

test("a missing target shows the unanchored card and Next still works", async ({ page, world }) => {
  void world;
  await page.route("**/api/v1/routines", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await startTour(page, "routines");
  const c = readyCard(page, "routines");
  await expect(c).toHaveAttribute("data-target-found", "false", { timeout: 10_000 });
  await expect(c.locator("[data-tour-note]")).toHaveText("This part of the demo data is missing on this world.");
  await c.locator("[data-tour-primary]").click();
  await expect(readyCard(page, "integrations")).toBeVisible();
});

test("the new-hire portal settles, and the tour leaves it for the app in one hop", async ({ page, weft, world }) => {
  test.skip(!world.rich, "the base world has no new-hire persona");
  // The offer row carries the portal persona (contracts ext w2-onboarding), beyond the frozen Offer type.
  const offers = (await weft.offers()) as unknown as { status: string; personaPrincipalId?: string | null }[];
  const persona = offers.find((o) => o.status === "accepted" && o.personaPrincipalId)?.personaPrincipalId;
  expect(persona, "the rich world has an accepted offer with a portal persona").toBeTruthy();
  // A portal section once refetched on every render (hundreds of requests a second), which starved the browser
  // and stalled any navigation away from the portal.
  let calls = 0;
  page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api/")) calls++; });
  await startTour(page, "portal");
  await expect(readyCard(page, "portal")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_000);
  calls = 0;
  await page.waitForTimeout(3_000);
  expect(calls, "API calls in 3 s on a settled portal").toBeLessThan(20);
  await readyCard(page, "portal").locator("[data-tour-primary]").click();
  // The memory step on /app/memory, without the "Resume tour" prompt a full page load would bring up.
  await expect(readyCard(page, "memory")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-tour-resume]")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("weft.viewingAs") ?? "usr_dana")).toBe("usr_dana");
});
