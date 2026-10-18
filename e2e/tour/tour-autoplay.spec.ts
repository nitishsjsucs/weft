// Autoplay paces the whole tour by itself: open /app?tour=1&autoplay=1, touch nothing, and it finishes within
// 180 s (owner: tour). On a base world (no rich layer yet) the reset offer is the one thing the test answers.
import { card, expect, readyCard, test } from "./tour-fixtures";

test("autoplay finishes the tour by itself within 180 s", async ({ page, weft, world, consoleErrors }, info) => {
  test.setTimeout(240_000);
  await page.goto("/app?tour=1&autoplay=1");
  const skip = page.locator("[data-tour-reset-skip]");
  await expect(skip.or(readyCard(page, "welcome")).first()).toBeVisible({ timeout: 20_000 });
  if (await skip.isVisible()) {
    expect(world.rich, "a clean rich world starts without the reset dialog").toBe(false);
    await skip.click();
  }
  await page.mouse.move(0, 0);
  await expect(readyCard(page, "welcome")).toBeVisible();
  const t0 = Date.now();
  const seen: string[] = [];
  const poll = setInterval(() => { void readyCard(page).getAttribute("data-step", { timeout: 200 }).then((s) => { if (s && seen[seen.length - 1] !== s) seen.push(s); }, () => undefined); }, 250);
  try {
    await expect(card(page)).toHaveCount(0, { timeout: 185_000 });
  } finally { clearInterval(poll); }
  const total = Date.now() - t0;
  console.log(`autoplay total ${total} ms over ${seen.length} steps on the ${world.profile} world`);
  await info.attach("autoplay.json", { body: JSON.stringify({ total, seen }, null, 2), contentType: "application/json" });
  expect(total).toBeLessThanOrEqual(180_000);
  expect(seen[seen.length - 1]).toBe("finish");
  const executed = await weft.proposals("executed");
  expect(executed.filter((p) => p.command === "tax.update_rate")).toHaveLength(1);
  expect(executed.filter((p) => p.command === "payroll.submit" || p.command === "notices.send_response"), "nothing else executes").toHaveLength(0);
  expect(consoleErrors, "no console errors").toEqual([]);
});
