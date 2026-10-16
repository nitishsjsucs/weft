// Layout at 1440 px with the agent panel docked (wave 1 gate report item 4, fixed by w2-reliability; this spec is
// the integrator's, from that track's left list) and at 390 px. The paycheck table and the run Steps card fit their
// cards without clipping, and a scripted run's provider badge never reads live.
//
// Every column check reads the header cells the browser actually shows: each one's right edge must sit inside its
// card, inside <main> (which ends where the docked agent panel starts and hides anything past it) and inside the
// viewport, and neither the card nor the table's scroll wrapper may hold content wider than its box. The GP1 agency
// notice run has the longest step titles in the seed world, which is what pushed Outcome out of view.
import type { Locator, Page } from "@playwright/test";
import { eventually, expect, openApp, SEED, test, TID, type Proposal, type WeftApi } from "./fixtures";

const PHONE = { width: 390, height: 844 };

/** The card's content fits its box: no horizontal overflow hidden by the card or scrolled away inside it. */
async function fits(card: Locator): Promise<void> {
  await expect(card).toBeVisible();
  const boxes = await card.evaluate((el) => [el, ...Array.from(el.children)].map((b) => ({ tag: b.tagName, scroll: b.scrollWidth, client: b.clientWidth })));
  for (const b of boxes) expect(b.scroll, `${b.tag} scrollWidth ${b.scroll} within clientWidth ${b.client}`).toBeLessThanOrEqual(b.client + 1);
}

/** Every visible column header ends inside its card, inside <main> and inside the viewport. Returns the header labels. */
async function columnsInView(page: Page, card: Locator): Promise<string[]> {
  await fits(card);
  const { cols, cardBox, mainRight, viewport } = await card.evaluate((el) => {
    const r = (e: Element) => e.getBoundingClientRect();
    const main = el.closest("main");
    return {
      cols: Array.from(el.querySelectorAll("thead th")).filter((th) => r(th).width > 0).map((th) => ({ label: (th.textContent ?? "").trim(), left: r(th).left, right: r(th).right })),
      cardBox: { left: r(el).left, right: r(el).right },
      mainRight: main ? r(main).right : window.innerWidth,
      viewport: window.innerWidth,
    };
  });
  expect(cols.length, "the table shows at least two columns").toBeGreaterThanOrEqual(2);
  expect(cardBox.right, "the card ends inside <main>").toBeLessThanOrEqual(mainRight + 1);
  for (const c of cols) {
    expect(c.left, `column "${c.label}" starts inside its card`).toBeGreaterThanOrEqual(cardBox.left - 1);
    expect(c.right, `column "${c.label}" right edge ${c.right} inside its card (${cardBox.right})`).toBeLessThanOrEqual(cardBox.right + 1);
    expect(c.right, `column "${c.label}" right edge inside <main> (${mainRight})`).toBeLessThanOrEqual(mainRight + 1);
    expect(c.right, `column "${c.label}" right edge inside the viewport (${viewport})`).toBeLessThanOrEqual(viewport);
  }
  const page_ = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(page_.scroll, "the page itself never scrolls sideways").toBeLessThanOrEqual(page_.width);
  return cols.map((c) => c.label);
}

/** Delivers the CA EDD DE 2088 notice (the GP1 scenario) and returns the run that proposed the rate change. */
async function gp1NoticeRun(weft: WeftApi): Promise<string> {
  await weft.post("/v1/sim/notices/deliver", { scenario: "ca_de2088_rate_change" });
  const pending = await eventually(() => weft.proposals("pending"), (ps) => (ps.length >= 2 ? ps : null), "the GP1 run's two proposals");
  const rate = pending.find((p: Proposal) => p.command === "tax.update_rate");
  expect(rate?.proposerRunId, "the rate change came from an agent run").toBeTruthy();
  return rate!.proposerRunId!;
}

async function docked(page: Page): Promise<void> {
  await expect(page.getByTestId(TID.agentComposer)).toBeVisible();
  const panel = await page.getByRole("complementary", { name: "Agent" }).boundingBox();
  expect(panel, "the agent panel is docked").toBeTruthy();
  expect(panel!.x + panel!.width, "the docked panel reaches the right edge").toBeGreaterThanOrEqual(1439);
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

test("every column of the GP1 notice run's Steps and the Oct 30 paycheck table is in view at 1440 docked and at 390", async ({ page, weft }) => {
  const runId = await gp1NoticeRun(weft);

  await test.step("1440 px, panel docked: the GP1 run's Steps show Outcome and every other column", async () => {
    await openApp(page, `/app/runs/${runId}`);
    await docked(page);
    await expect(page.getByTestId(TID.runStep).filter({ hasText: "000-4817-2" }).first()).toBeVisible();
    const cols = await columnsInView(page, page.getByTestId("run-steps-card"));
    expect(cols).toEqual(expect.arrayContaining(["Step", "Outcome", "USD"]));
  });

  await test.step("1440 px, panel docked: the Oct 30 draft's paycheck table shows Net pay and every other column", async () => {
    await openApp(page, `/app/payroll/${SEED.draftRun}`);
    await docked(page);
    await expect(page.getByTestId(TID.payrollGroupNeedsReview)).toBeVisible();
    const cols = await columnsInView(page, page.getByTestId("paycheck-table-card"));
    expect(cols).toEqual(expect.arrayContaining(["Employee", "Gross pay", "Net pay"]));
  });

  await page.setViewportSize(PHONE);

  await test.step("390 px: the GP1 run's Steps keep Step and Outcome in view", async () => {
    await openApp(page, `/app/runs/${runId}`);
    await expect(page.getByTestId(TID.runStep).filter({ hasText: "000-4817-2" }).first()).toBeVisible();
    const cols = await columnsInView(page, page.getByTestId("run-steps-card"));
    expect(cols).toEqual(expect.arrayContaining(["Step", "Outcome"]));
  });

  await test.step("390 px: the Oct 30 draft's paycheck table keeps Employee and Net pay in view", async () => {
    await openApp(page, `/app/payroll/${SEED.draftRun}`);
    await expect(page.getByTestId(TID.payrollGroupNeedsReview)).toBeVisible();
    const cols = await columnsInView(page, page.getByTestId("paycheck-table-card"));
    expect(cols).toEqual(expect.arrayContaining(["Employee", "Net pay"]));
  });
});
