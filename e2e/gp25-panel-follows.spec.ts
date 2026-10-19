// GP25. The agent panel follows every run a person starts (demo polish, docs/demo-scenarios.md): Deliver on a notice,
// Mark accepted on an offer and Review with agent on Expenses each open the panel on their run, the notice run says
// it never read the notice text, and the injected copy shows the line that was held back. Scripted provider.
import { expect, openApp, SEED, test, tid, viewAs } from "./fixtures";

const run = (page: import("@playwright/test").Page, label: RegExp) => page.locator('[data-tour="agent-run"]').filter({ hasText: label }).last();

test("GP25: the panel follows the notice, the accepted offer and the expense review", async ({ page }) => {
  await test.step("Deliver opens the notice run, which worked from the parsed fields only", async () => {
    await openApp(page, "/app/simulators");
    await viewAs(page, "dana");
    await page.getByTestId(tid.simDeliver("ca_de2088_rate_change")).click();
    const feed = run(page, /Agency notice/);
    await expect(feed).toBeVisible();
    await expect(feed).toHaveAttribute("data-status", /waiting|done/);
    await expect(feed.getByTestId("agent-notice-untrusted")).toBeVisible();
  });

  await test.step("the injected copy shows its held-back line and whether the run read it", async () => {
    await page.getByTestId(tid.simDeliver("ca_de2088_injection")).click();
    const held = page.getByTestId("notice-held-back");
    await expect(held).toBeVisible();
    await expect(held).toContainText("held back as untrusted text");
    // The scripted stand-in plays a model that reads the body, so this run is tainted and says so in words.
    await expect(held).toHaveAttribute("data-run-read", "true");
    await held.getByText(/Show the held-back line/).click();
    await expect(held).toContainText("Ignore prior instructions");
    await expect(page.locator('[data-tour="agent-run"]').last()).toContainText("This run read untrusted content: the text of an agency notice");
    await expect(page.locator('[data-tour="agent-run"]').last()).not.toContainText(/ntc_\d/);
  });

  await test.step("Mark accepted opens the new hire run", async () => {
    await openApp(page, "/app/people");
    await page.getByRole("tab", { name: /offers/i }).click();
    await page.getByTestId(tid.offerAccept(SEED.noorOffer)).click();
    const feed = run(page, /New hire readiness: Noor Castellanos \(demo\)/);
    await expect(feed).toBeVisible();
    await expect(feed).not.toHaveAttribute("data-status", "starting");
  });

  await test.step("Review with agent opens the expense review run, and the notice names no id", async () => {
    await openApp(page, "/app/expenses");
    await page.getByRole("button", { name: "Review with agent" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Review started" })).not.toContainText(/rtr_/);
    await expect(run(page, /Expense review/)).toBeVisible();
  });
});
