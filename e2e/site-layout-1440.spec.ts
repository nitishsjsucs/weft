// Layout at 1440 px with the agent panel docked (wave 1 gate report item 4, fixed by w2-reliability; this spec is
// the integrator's, from that track's left list). The paycheck table and the run Steps card fit their cards without
// clipping, and a scripted run's provider badge never reads live.
import type { Locator } from "@playwright/test";
import { eventually, expect, openApp, SEED, test, TID } from "./fixtures";

/** The card's content fits its box: no horizontal overflow hidden by the card's overflow-hidden. */
async function fits(card: Locator): Promise<void> {
  await expect(card).toBeVisible();
  const { scroll, client } = await card.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(scroll, `scrollWidth ${scroll} within clientWidth ${client}`).toBeLessThanOrEqual(client + 1);
}

test("1440 px with the agent panel docked: paycheck table and run steps fit, and a scripted run is not live", async ({ page, weft }) => {
  expect(page.viewportSize()).toEqual({ width: 1440, height: 900 });

  await test.step("the paycheck table fits its card", async () => {
    await openApp(page, `/app/payroll/${SEED.draftRun}`);
    await expect(page.getByTestId(TID.agentComposer)).toBeVisible();
    await fits(page.getByTestId("paycheck-table-card"));
  });

  await test.step("the run Steps card fits and the scripted provider reads not live", async () => {
    const { runId } = await weft.post<{ runId: string }>("/v1/agent/runs", { text: "How many people are on payroll in CA?", pageContext: null });
    await eventually(() => weft.agentRuns(), (rs) => rs.find((r) => r.id === runId && r.status !== "queued" && r.status !== "running"), "the chat run finished");
    await openApp(page, `/app/runs/${runId}`);
    await expect(page.getByTestId(TID.agentComposer)).toBeVisible();
    await fits(page.getByTestId("run-steps-card"));
    await expect(page.getByTestId("run-provider")).toHaveAttribute("data-live", "false");
    await expect(page.getByTestId("run-provider")).not.toContainText("(live)");
  });
});
