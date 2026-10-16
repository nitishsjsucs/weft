// GP15. Chart answer and approval card (docs/wave3.md). Owner of the spec: w3-parity-chat.
// Asked for payroll cost by month, chat calls reports.query and the panel draws a bar chart with a data table. With
// agent.chat_can_propose off, an off-cycle request is answered read-only; with it on, chat files the proposal, its
// card shows fields from the stored preview with Approve, Deny and Open, and Approve executes once through the same
// decide route as the Inbox.
import { resolve } from "node:path";
import { askAgent, eventually, expect, openApp, test, TID, viewAs, type PayrollRun } from "./fixtures";
import { W3_CHAT_TID, W3_SETTINGS } from "../packages/contracts/src/index";

const OFF_CYCLE = "Pay Hollis Grey (demo) an off-cycle bonus of $1,500.00 with payday Oct 27";

/**
 * Turns agent.chat_can_propose on or off. PUT /v1/settings/agent belongs to w3-parity-routines; until it answers, the
 * spec writes the settings row in the e2e world's own database (never the dev data), the same row the API reads.
 */
async function setCanPropose(request: import("@playwright/test").APIRequestContext, on: boolean): Promise<void> {
  const res = await request.put("/api/v1/settings/agent", { data: { chatCanPropose: on }, headers: { "x-weft-principal": "usr_dana" } });
  if (res.ok()) return;
  const { openDb, closeDb, settings } = await import("../packages/db/src/index");
  const db = openDb({ dataDir: resolve(process.cwd(), process.env.WEFT_E2E_DATA_DIR ?? ".data-e2e") });
  try {
    await db.insert(settings).values({ key: W3_SETTINGS.chatCanPropose, valueJson: JSON.stringify(on) }).onConflictDoUpdate({ target: settings.key, set: { valueJson: JSON.stringify(on) } });
  } finally {
    await closeDb(db);
  }
}

test("GP15: a chart answer, a read-only answer with proposals off, and an approval card that executes once", async ({ page, weft, request }) => {
  await test.step("payroll cost by month renders a chart with a table fallback", async () => {
    await openApp(page, "/app");
    await viewAs(page, "dana");
    const answer = await askAgent(page, "Show payroll cost by month");
    await expect(answer).toContainText("Sep 2026");
    const chart = page.getByTestId(W3_CHAT_TID.chart).last();
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute("data-metric", "payroll_cost_by_month");
    await expect(chart).toHaveAttribute("data-rows", "2");
    await expect(chart.locator(".recharts-bar-rectangle").first()).toBeVisible();
    const table = chart.getByTestId(W3_CHAT_TID.chartTable);
    await expect(table.locator("tbody tr")).toHaveCount(2);
    await expect(table.locator("tbody tr").first()).toContainText("Sep 2026");
    await chart.getByRole("button", { name: "Table" }).click();
    await expect(table).toBeVisible();
    await expect(table.locator("thead")).toContainText("Gross pay");
    await expect(page.getByTestId(W3_CHAT_TID.ranTools).last()).toHaveText("Ran 1 tool");
  });

  await test.step("with chat proposals off, an off-cycle request files nothing", async () => {
    await setCanPropose(request, false);
    const before = (await weft.proposals()).length;
    await askAgent(page, OFF_CYCLE);
    await expect(page.getByTestId(TID.agentStep).last()).toHaveAttribute("data-outcome", "refused:UNAVAILABLE");
    expect((await weft.proposals()).length).toBe(before);
  });

  await test.step("with them on, chat files the proposal and its card approves it once", async () => {
    await setCanPropose(request, true);
    const actionsBefore = (await weft.actions()).length;
    await askAgent(page, OFF_CYCLE);
    const p = await eventually(() => weft.proposals("pending"), (ps) => ps.find((x) => x.command === "payroll.propose_off_cycle"), "an off-cycle proposal from chat");
    expect(p.risk).toBe("R4");
    expect((await weft.actions()).length, "nothing executed from chat").toBe(actionsBefore);
    const card = page.getByTestId(W3_CHAT_TID.card(p.id));
    await expect(card).toBeVisible();
    await expect(card).toContainText("Hollis Grey (demo)");
    await expect(card).toContainText("Bonus (supplemental wages");
    await expect(card).toContainText("$1,500.00");
    await expect(card.getByRole("link", { name: /Open/ })).toHaveAttribute("href", `/app/inbox?proposal=${p.id}`);
    await expect(card.getByTestId(W3_CHAT_TID.cardDeny(p.id))).toBeVisible();
    await card.getByTestId(W3_CHAT_TID.cardApprove(p.id)).click();
    await expect(card).toHaveAttribute("data-status", "executed");
    await expect(card.getByTestId(W3_CHAT_TID.cardApprove(p.id))).toHaveCount(0);
    expect((await weft.proposal(p.id)).status).toBe("executed");
    const runs: PayrollRun[] = (await weft.payrolls()).filter((r) => r.subtype === "off_cycle");
    expect(runs).toHaveLength(1);
    expect((await weft.actions()).length).toBe(actionsBefore + 1);
    await setCanPropose(request, false);
  });
});
