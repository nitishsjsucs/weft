// Autoplay paces the whole tour by itself: open /app?tour=1&autoplay=1, touch nothing, and it finishes within
// 180 s (owner: tour). On a base world (no rich layer yet) the reset offer is the one thing the test answers.
import { card, expect, readyCard, test } from "./tour-fixtures";

test("autoplay finishes the tour by itself within 180 s", async ({ page, weft, world, consoleErrors }, info) => {
  test.setTimeout(240_000);
  // Live passes (WEFT_TOUR_LIVE=1) read the spend before and after, for the ledger.
  const costs = () => weft.get<{ liveSpentUsd: number; daySpentUsd: number; provider: { model: string; live: boolean } }>("/v1/agent/costs");
  const before = await costs();
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
  const at: Record<string, number> = {};
  const poll = setInterval(() => { void readyCard(page).getAttribute("data-step", { timeout: 200 }).then((s) => { if (s && seen[seen.length - 1] !== s) { seen.push(s); at[s] = Date.now() - t0; } }, () => undefined); }, 250);
  try {
    await expect(card(page)).toHaveCount(0, { timeout: 185_000 });
  } finally { clearInterval(poll); }
  const total = Date.now() - t0;
  const after = await costs();
  const usd = Math.max(0, after.liveSpentUsd - before.liveSpentUsd);
  console.log(`autoplay step starts (ms): ${JSON.stringify(at)}`);
  console.log(`autoplay total ${total} ms over ${seen.length} steps on the ${world.profile} world, ${after.provider.model} live=${after.provider.live}, live spend $${usd.toFixed(4)}`);
  await info.attach("autoplay.json", { body: JSON.stringify({ total, seen, at, usd, model: after.provider.model }, null, 2), contentType: "application/json" });
  expect(total).toBeLessThanOrEqual(180_000);
  expect(seen[seen.length - 1]).toBe("finish");
  const executed = await weft.proposals("executed");
  expect(executed.filter((p) => p.command === "tax.update_rate")).toHaveLength(1);
  expect(executed.filter((p) => p.command === "payroll.submit" || p.command === "notices.send_response"), "nothing else executes").toHaveLength(0);
  expect(consoleErrors, "no console errors").toEqual([]);
});
