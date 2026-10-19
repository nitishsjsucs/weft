// The whole guided tour on the scripted provider, as a person would take it: start from Home, read each card for
// its planned seconds, click the real controls on the click steps, and finish within 180 s (owner: tour).
import { card, expect, noHorizontalScroll, pressPrimary, readyStep, targetInfo, test, TOUR_STEPS } from "./tour-fixtures";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// TOUR_SHOTS=1 also saves the screen at every step (once its card is ready) to docs/screenshots/tour/ (or SHOTS_DIR),
// named by step number and id. The shot is taken inside the step's reading time, so the pace is unchanged.
const SHOTS = process.env.TOUR_SHOTS === "1" ? (process.env.SHOTS_DIR ?? fileURLToPath(new URL("../../docs/screenshots/tour", import.meta.url))) : null;

test("completes the whole tour on the scripted provider in 180 s or less", async ({ page, weft, world, consoleErrors }, info) => {
  test.setTimeout(240_000);
  // The rich world has a year of decided history, so the read-backs compare against what was there before the tour.
  const executedBefore = new Set((await weft.proposals("executed")).map((p) => p.id));
  const runsBefore = (await weft.agentRuns()).length;
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
      if (world.rich) {
        expect(found, `${step.id} target found on the rich world`).toBe(true);
        // The step's own selector, not a fallback: the rich world carries everything the tour points at.
        expect.soft(await c.getAttribute("data-target-match"), `${step.id} matched its own target`).toBe("primary");
      }
      if (found) {
        await expect(page.locator('[data-tour-ring][data-target-found="true"]')).toBeVisible();
        const t = await targetInfo(page);
        expect(t.text, `${step.id} target has text`).toBeGreaterThan(0);
        if (t.count !== null) expect(Number(t.count), `${step.id} data-count`).toBeGreaterThan(0);
      }
    }
    expect.soft(readyMs, `${step.id} ready within its seconds`).toBeLessThanOrEqual(step.seconds * 1000);
    expect(await noHorizontalScroll(page), `${step.id} no horizontal scroll`).toBe(true);
    if (step.id === "memory" && world.rich) {
      // The procedure the notice run followed, with a thread linking it and its git history.
      expect(Number(await page.locator('[data-tour~="memory-backlinks"]').getAttribute("data-count")), "memory backlinks").toBeGreaterThan(0);
    }

    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/${String(step.n).padStart(2, "0")}-${step.id}.png` });
    }

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
  const executed = (await weft.proposals("executed")).filter((p) => !executedBefore.has(p.id));
  expect(executed.map((p) => p.command), "the tour executes exactly one proposal, the rate change").toEqual(["tax.update_rate"]);
  const rate = executed[0]!;
  expect(JSON.stringify(rate.args)).toContain("0.015");
  expect(JSON.stringify(rate.args)).toContain("2026-01-01");
  expect(rate.taintedBy).toBeNull();
  const pending = await weft.proposals("pending");
  expect(pending.some((p) => p.command === "notices.send_response"), "the filing still waits").toBe(true);
  expect((await weft.agentRuns()).length, "the notice run and the chart question").toBeGreaterThanOrEqual(runsBefore + 2);
  expect((await weft.chain()).ok, "the audit chain verifies").toBe(true);
  const storage = await page.evaluate(() => ({ tour: sessionStorage.getItem("weft.tour.v1"), seen: localStorage.getItem("weft.tour.seen"), who: localStorage.getItem("weft.viewingAs") }));
  expect(storage.tour).toBeNull();
  expect(storage.seen).toBe("1");
  expect(storage.who ?? "usr_dana").toBe("usr_dana");
  expect(consoleErrors.filter((e) => !/Download the React DevTools|Fast Refresh|\[HMR\]/.test(e)), "no console errors").toEqual([]);
});
