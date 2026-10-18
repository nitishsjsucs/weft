// The whole guided tour on the scripted provider, as a person would take it: start from Home, read each card for
// its planned seconds, click the real controls on the click steps, and finish within 180 s (owner: tour).
import { card, expect, noHorizontalScroll, pressPrimary, readyStep, targetInfo, test, TOUR_STEPS } from "./tour-fixtures";

test("completes the whole tour on the scripted provider in 180 s or less", async ({ page, weft, world, consoleErrors }, info) => {
  test.setTimeout(240_000);
  await page.goto("/app");
  await page.locator('[data-tour~="home-take-tour"]').click();

  // A base world (no rich layer yet) brings up the reset offer; carry on without resetting.
  const reset = page.locator("[data-tour-reset]");
  const first = await Promise.race([
    reset.waitFor({ state: "visible", timeout: 15_000 }).then(() => "reset" as const),
    page.locator('[data-tour-card][data-step="welcome"]').waitFor({ state: "visible", timeout: 15_000 }).then(() => "card" as const),
  ]);
  if (first === "reset") {
    expect(world.rich, "a clean rich world starts without the reset dialog").toBe(false);
    await page.locator("[data-tour-reset-skip]").click();
  }

  const timings: { step: string; readyMs: number; totalMs: number; found: boolean; skipped?: boolean }[] = [];
  let t0 = 0;
  let i = 0;
  while (i < TOUR_STEPS.length) {
    const want = TOUR_STEPS[i]!;
    const entered = Date.now();
    const got = await readyStep(page, 30_000);
    const readyMs = Date.now() - entered;
    if (!t0) t0 = Date.now();
    const gi = TOUR_STEPS.findIndex((s) => s.id === got);
    if (gi > i) {
      // Only the portal step may be skipped (no new-hire persona on this world).
      for (const s of TOUR_STEPS.slice(i, gi)) {
        expect(s.id === "portal" && !world.rich, `step ${s.id} was skipped`).toBe(true);
        timings.push({ step: s.id, readyMs: 0, totalMs: 0, found: false, skipped: true });
      }
      i = gi;
      continue;
    }
    expect(got, `step ${want.id} shows`).toBe(want.id);
    const step = want;
    const c = card(page);
    const found = (await c.getAttribute("data-target-found")) === "true";
    if (step.target) {
      if (world.rich) expect(found, `${step.id} target found on the rich world`).toBe(true);
      if (found) {
        await expect(page.locator('[data-tour-ring][data-target-found="true"]')).toBeVisible();
        const t = await targetInfo(page);
        expect(t.text, `${step.id} target has text`).toBeGreaterThan(0);
        if (t.count !== null) expect(Number(t.count), `${step.id} data-count`).toBeGreaterThan(0);
      }
    }
    expect.soft(readyMs, `${step.id} ready within its seconds`).toBeLessThanOrEqual(step.seconds * 1000);
    expect(await noHorizontalScroll(page), `${step.id} no horizontal scroll`).toBe(true);

    const dwell = async () => { const left = step.seconds * 1000 - (Date.now() - entered); if (left > 0) await page.waitForTimeout(left); };
    const nextId = TOUR_STEPS[i + 1]?.id;
    if (step.action === "click" && found && (await c.locator("[data-tour-note]").count()) === 0) {
      // The real control, not the card's proxy.
      if (step.id === "deliver-notice") await page.locator('[data-tour~="sim-deliver"][data-scenario="ca_de2088_rate_change"]').click();
      else {
        const memo = await page.evaluate(() => (JSON.parse(sessionStorage.getItem("weft.tour.v1") ?? "{}") as { memo?: { rateProposalId?: string } }).memo ?? {});
        await page.locator(`[data-tour~="inbox-card"][data-proposal-id="${memo.rateProposalId}"] [data-tour~="proposal-approve"]`).click();
      }
      await expect(page.locator(`[data-tour-card][data-step="${nextId}"]`)).toBeVisible({ timeout: (step.hardMs ?? 8_000) + 5_000 });
    } else if (step.action === "wait-run") {
      // Auto-advances once the run is waiting or done (or the budget-capped timeout passes).
      await expect(page.locator(`[data-tour-card][data-step="${nextId}"]`)).toBeVisible({ timeout: (step.hardMs ?? 20_000) + 5_000 });
    } else if (step.action === "ask" && found) {
      await expect(page.locator('[data-tour~="agent-composer"] textarea')).toHaveValue(/payroll cost/i, { timeout: 5_000 });
      await page.locator('[data-tour~="agent-send"]').click();
      await expect(page.locator(`[data-tour-card][data-step="${nextId}"]`)).toBeVisible({ timeout: (step.hardMs ?? 15_000) + 5_000 });
    } else if (step.action === "finish") {
      await dwell();
      await pressPrimary(page, step.id);
      await expect(card(page)).toHaveCount(0);
    } else {
      await dwell();
      await pressPrimary(page, step.id);
    }
    timings.push({ step: step.id, readyMs, totalMs: Date.now() - entered, found });
    console.log(`tour step ${step.id}: ready ${readyMs} ms, total ${Date.now() - entered} ms, target ${found ? "found" : "missing"}`);
    i++;
  }
  const total = Date.now() - t0;
  await info.attach("tour-timings.json", { body: JSON.stringify({ total, profile: world.profile, timings }, null, 2), contentType: "application/json" });
  console.log(`tour total ${total} ms on the ${world.profile} world`);
  expect(total, "whole tour within 180 s").toBeLessThanOrEqual(180_000);

  // Read-backs through the API.
  const executed = await weft.proposals("executed");
  const rate = executed.find((p) => p.command === "tax.update_rate");
  expect(rate, "the rate change executed").toBeTruthy();
  expect(JSON.stringify(rate!.args)).toContain("0.015");
  expect(JSON.stringify(rate!.args)).toContain("2026-01-01");
  expect(rate!.taintedBy).toBeNull();
  expect(executed.filter((p) => p.command === "payroll.submit"), "the tour never submits payroll").toHaveLength(0);
  const pending = await weft.proposals("pending");
  expect(pending.some((p) => p.command === "notices.send_response"), "the filing still waits").toBe(true);
  const runs = await weft.agentRuns();
  expect(runs.length).toBeGreaterThan(0);
  expect((await weft.chain()).ok, "the audit chain verifies").toBe(true);
  const storage = await page.evaluate(() => ({ tour: sessionStorage.getItem("weft.tour.v1"), seen: localStorage.getItem("weft.tour.seen"), who: localStorage.getItem("weft.viewingAs") }));
  expect(storage.tour).toBeNull();
  expect(storage.seen).toBe("1");
  expect(storage.who ?? "usr_dana").toBe("usr_dana");
  expect(consoleErrors.filter((e) => !/Download the React DevTools|Fast Refresh|\[HMR\]/.test(e)), "no console errors").toEqual([]);
});
