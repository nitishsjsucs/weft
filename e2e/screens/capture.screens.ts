// Screenshot capture for docs/screenshots/ (README Results). `pnpm screenshots` runs it through
// playwright.screens.config.ts: the same dev runner, ports and fresh world per test as `pnpm e2e`, driving the golden
// path flows far enough to show each screen. Never part of `pnpm e2e` (the file name is outside its testMatch).
import { askAgent, eventually, expect, openApp, test, TID, tid, viewAs, type Proposal } from "../fixtures";
import { W2_ONBOARDING_TID as T } from "../../packages/contracts/src/w2/testids-onboarding";
import { W2_OFFBOARDING_TID as OT, W2_BENEFITS_TID as BT, W3_CHAT_TID, W3_EXPENSES_TID as XT, W3_INTEGRATIONS_TID as IT, W3_SHELL_TID as S, W3_TIMEOFF_TID as TT } from "../../packages/contracts/src/index";
import { ASSIST_TID as A } from "../../packages/contracts/src/ext/assist";
import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const OUT = process.env.SHOTS_DIR ?? fileURLToPath(new URL("../../docs/screenshots", import.meta.url));
/**
 * Moves focus and the pointer off the control a step last clicked, so a shot shows the resting state. The pointer
 * then leaves the window, so the cursor assistant's floating icon (which follows it) is not in the shot either.
 */
const rest = async (page: Page) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(1, page.viewportSize()!.height - 1);
  await page.evaluate(() => document.documentElement.dispatchEvent(new PointerEvent("pointerleave")));
  await page.waitForTimeout(250); // the icon's fade
};
const shot = async (page: Page, name: string, fullPage = false) => {
  await page.waitForTimeout(600);
  await rest(page);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
};

/** A crop of the top of the page (the app header and whatever menu hangs from it). */
const top = async (page: Page, name: string, height: number, keepFocus = false) => {
  await page.waitForTimeout(600);
  if (!keepFocus) await rest(page);
  // An open menu keeps focus and the pointer; the pointer still leaves the window, so the floating icon is not in it.
  else { await page.evaluate(() => document.documentElement.dispatchEvent(new PointerEvent("pointerleave"))); await page.waitForTimeout(250); }
  const width = page.viewportSize()!.width;
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 0, y: 0, width, height } });
};

test("screens wave 1", async ({ page, weft }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await shot(page, "01-landing");
  await shot(page, "01b-landing-full", true);
  await openApp(page, "/app");
  await viewAs(page, "dana");
  await shot(page, "02-app-home");
  await openApp(page, "/app/simulators");
  await shot(page, "03-simulators");
  await page.getByTestId(tid.simDeliver("ca_de2088_rate_change")).click();
  const pending = await eventually(() => weft.proposals("pending"), (ps) => (ps.length >= 2 ? ps : null), "two pending proposals");
  const rate = pending.find((p: Proposal) => p.command === "tax.update_rate")!;
  await openApp(page, `/app/runs/${rate.proposerRunId}`);
  await expect(page.getByTestId(TID.runStep).first()).toBeVisible();
  await shot(page, "04-agent-run");
  await openApp(page, "/app/inbox");
  await expect(page.getByTestId(tid.inboxCard(rate.id))).toBeVisible();
  await shot(page, "05-inbox");
  await weft.post("/v1/routines/rt_pre_payroll/trigger", {});
  await eventually(() => weft.proposals("pending"), (ps) => ps.find((p: Proposal) => p.command === "payroll.submit_run"), "a submit proposal");
  await openApp(page, "/app/payroll");
  await shot(page, "06-payroll");
  await openApp(page, "/app/payroll/pay_2026_10_30");
  await shot(page, "07-payroll-draft");
  await openApp(page, "/app/people");
  await shot(page, "08-people");
  await openApp(page, "/app/routines");
  await shot(page, "09-routines");
  await openApp(page, "/app/audit");
  await shot(page, "10-audit");
  await openApp(page, "/app/compliance");
  await shot(page, "11-compliance");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await shot(page, "12-landing-mobile");
});

test("screens hiring and portal", async ({ page, weft }) => {
  await openApp(page, "/app/hiring");
  await viewAs(page, "dana");
  await page.getByTestId(T.offerFirst).fill("Rowan");
  await page.getByTestId(T.offerLast).fill("Ellery");
  await page.getByTestId(T.offerEmail).fill("rowan.ellery@candidate.example");
  await page.getByTestId(T.offerTitle).pressSequentially("Firmware Test Engineer");
  await page.getByTestId(T.offerDepartment).selectOption("dpt_hardware");
  await page.getByTestId(T.offerState).selectOption("CO");
  await page.getByTestId(T.offerBase).fill("132000");
  await page.getByTestId(T.offerStart).fill("2026-11-02");
  await page.getByTestId(T.offerSaveDraft).click();
  const offer = await eventually(() => weft.get<{ data: { id: string; status: string; candidateEmail: string }[] }>("/v1/offers"), (p) => p.data.find((o) => o.candidateEmail === "rowan.ellery@candidate.example"), "the draft");
  const row = page.locator(`[data-testid="${T.offerRow}"][data-offer="${offer.id}"]`);
  await row.getByTestId(T.offerSend).click();
  await expect(row.getByTestId(T.offerStatus)).toHaveText("Sent");
  const item = page.locator(`[data-testid="${T.outboxItem}"][data-ref="${offer.id}"]`);
  await expect(item).toBeVisible();
  await shot(page, "13-hiring");
  await item.getByRole("link", { name: /new-hire portal/i }).click();
  await expect(page.getByTestId(T.portalCounter)).toHaveText("0 of 7 done");
  await shot(page, "14-portal");
});

test("screens offboarding", async ({ page, weft }) => {
  await weft.post("/v1/tools/it.create_account", { worker_id: "wrk_0004", system: "sso" });
  await openApp(page, "/app/people/wrk_0004");
  await viewAs(page, "dana");
  await page.getByTestId(OT.personTerminate).click();
  await page.getByTestId(OT.terminateKind).selectOption("voluntary");
  await page.getByTestId(OT.terminateLastDay).fill("2026-10-30");
  await page.getByTestId(OT.terminateNote).fill("Moving abroad");
  await page.getByTestId(OT.terminateSubmit).click();
  await page.waitForURL(/\/app\/offboarding\/ofb_/);
  await expect(page.getByTestId(OT.caseSteps)).toBeVisible();
  await shot(page, "15-offboarding-case");
});

test("screens benefits and contractors", async ({ page, weft }) => {
  await openApp(page, "/app/benefits");
  await viewAs(page, "dana");
  await page.getByTestId(BT.tabRecon).click();
  await page.getByTestId(BT.reconRun).click();
  await expect(page.getByTestId(BT.reconNotice)).toContainText("3 findings");
  await shot(page, "16-benefits-reconciliation");
  await page.getByTestId(BT.tabEnrollment).click();
  await expect(page.getByTestId(BT.enrollmentNudge)).toBeVisible();
  await shot(page, "18-open-enrollment");
  await openApp(page, "/app/contractors");
  await page.getByTestId(BT.payoutsSchedule).click();
  await eventually(() => weft.get<{ data: unknown[] }>("/v1/contractors/payouts"), (p) => (p.data.length === 3 ? p.data : null), "three payouts");
  await page.reload();
  await expect(page.getByTestId(TID.simClock)).toBeVisible();
  await shot(page, "19-contractor-payouts");
});

test("screens off-cycle", async ({ page, weft }) => {
  await openApp(page, "/app/people/wrk_0042");
  await viewAs(page, "dana");
  await page.getByTestId(OT.personOffCycle).click();
  await page.getByTestId(OT.offCyclePayday).fill("2026-10-27");
  await page.getByTestId(OT.offCycleBonus).fill("1500.00");
  await page.getByTestId(OT.offCycleSubmit).click();
  await expect(page.getByTestId(OT.terminateError)).toContainText("already paid");
  await page.getByTestId(OT.offCycleReason).selectOption("bonus");
  await page.getByTestId(OT.offCycleSubmit).click();
  const p = await eventually(() => weft.proposals("pending"), (ps) => ps.find((x: Proposal) => x.command === "payroll.propose_off_cycle"), "an off-cycle proposal");
  await openApp(page, "/app/inbox");
  await expect(page.getByTestId(tid.inboxCard(p.id))).toContainText("$1,500.00");
  await shot(page, "20-off-cycle-proposal");
});

test("screens memory", async ({ page, weft }) => {
  await weft.post("/v1/routines/rt_memory_digest/trigger", {});
  await eventually(() => weft.routineRuns("rt_memory_digest"), (rs) => (rs as unknown as { summary: string | null }[]).find((r) => /^Memory digest committed/.test(r.summary ?? "")), "a committed digest");
  await openApp(page, "/app/memory");
  await expect(page.getByTestId("memory-file")).toContainText("Headcount by state");
  await shot(page, "17-memory");
});

test("screens wave 3 top bar", async ({ page }) => {
  await openApp(page, "/app/people/wrk_0001");
  await viewAs(page, "dana");
  await expect(page.locator(`header:has([data-testid="${S.envPill}"])`)).toBeVisible();
  await top(page, "21-topbar", 120);
  await page.getByTestId(TID.viewingAs).click();
  await expect(page.getByRole("menu")).toContainText("Managers");
  await top(page, "21b-topbar-persona-menu", 420, true);
  await page.keyboard.press("Escape");
  await page.getByTestId(TID.simClock).click();
  await expect(page.getByTestId(S.clockPopover)).toContainText("Clock");
  await top(page, "21c-topbar-clock", 420, true);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, "/app/people/wrk_0001");
  await top(page, "21d-topbar-mobile", 120);
});

test("screens wave 3 expenses", async ({ page, weft }) => {
  await openApp(page, "/app/expenses");
  await viewAs(page, "dana");
  await expect(page.getByTestId(XT.band("needs_review"))).toHaveAttribute("data-count", "8");
  await shot(page, "22-expenses");
  await weft.post("/v1/routines/rt_expense_review/trigger", {});
  await eventually(() => weft.proposals("pending"), (ps) => { const mine = ps.filter((p: Proposal) => p.command === "expenses.decide"); return mine.length === 8 ? mine : null; }, "eight expense proposals", 60_000);
  await page.reload();
  await page.getByTestId(XT.row("exp_0007")).click();
  await expect(page.getByTestId(XT.drawer).getByTestId(XT.check("DUPLICATE"))).toBeVisible();
  await shot(page, "22b-expense-drawer");
});

test("screens wave 3 time off", async ({ page }) => {
  await openApp(page, "/app/time-off");
  await viewAs(page, "sam");
  await page.getByTestId(TT.tab("requests")).click();
  await expect(page.getByTestId(TT.requestRow("tor_0003")).getByTestId(TT.check("COVERAGE_CONFLICT"))).toBeVisible();
  await shot(page, "23-time-off-requests");
  await page.getByTestId(TT.tab("calendar")).click();
  await expect(page.getByTestId(TT.calendarDay("2026-11-23"))).toHaveAttribute("data-over", "true");
  await shot(page, "23b-time-off-calendar");
});

test("screens wave 3 integrations and chart", async ({ page }) => {
  await openApp(page, "/app/integrations");
  await viewAs(page, "dana");
  for (const v of ["greenhouse", "workday", "checkr", "hireright", "docusign"]) await expect(page.getByTestId(IT.mode(v))).toHaveText("Sandbox");
  await shot(page, "24-integrations");
  await openApp(page, "/app");
  const answer = await askAgent(page, "Show payroll cost by month");
  await expect(answer).toContainText("Sep 2026");
  await expect(page.getByTestId(W3_CHAT_TID.chart).last().locator(".recharts-bar-rectangle").first()).toBeVisible();
  await shot(page, "25-chat-chart");
});

// The cursor assistant (README "The cursor assistant"): point, go there and answer, each with its card next to the
// pointer. The assistant's own card stays open in the shot; rest() only moves focus and the pointer away.
test("screens cursor assistant", async ({ page, weft }) => {
  await weft.post("/v1/routines/rt_time_off_requests/trigger", {});
  const prp = await eventually(() => weft.proposals("pending"), (ps) => ps.find((p: Proposal) => p.command === "time_off.decide"), "Ruth's time-off decision in the Inbox");
  const ask = async (question: string, at: { x: number; y: number }) => {
    await page.mouse.move(at.x, at.y);
    await page.keyboard.press("ControlOrMeta+KeyJ");
    await page.getByTestId(A.input).fill(question);
    await page.getByTestId(A.input).press("Enter");
    await expect(page.getByTestId(A.popover)).toBeVisible();
  };
  await openApp(page, "/app/inbox");
  await viewAs(page, "dana");
  await expect(page.getByTestId(tid.inboxCard(prp.id))).toBeVisible();
  await ask("Where do I approve Ruth's time off?", { x: 980, y: 140 });
  await expect(page.getByTestId(A.bubble)).toHaveText("Approve it here");
  await shot(page, "42-assist-point");
  await page.keyboard.press("Escape");
  await ask("Show me the Oct 30 payroll flags", { x: 980, y: 140 });
  await expect(page).toHaveURL(/\/app\/payroll\/pay_2026_10_30/);
  await expect(page.getByTestId(A.bubble)).toHaveText("Needs review");
  await shot(page, "43-assist-navigate");
  await page.keyboard.press("Escape");
  await ask("How many paychecks need review on this draft?", { x: 760, y: 120 });
  await expect(page.getByTestId(A.answer)).toContainText("paychecks need review on this draft");
  await expect(page.getByTestId(A.continue)).toBeVisible();
  await shot(page, "44-assist-answer");
  await page.keyboard.press("Escape");
  // The handoff to the full agent: the progress card with the chat run's steps, the cited answer and its Show me chips.
  await openApp(page, "/app");
  await ask("Compare the last three pay runs and show me the outliers", { x: 980, y: 140 });
  await expect(page.getByTestId(A.progress)).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId(A.answer)).toContainText("the open draft stands out");
  await expect(page.getByTestId(A.chip).first()).toBeVisible();
  await shot(page, "45-assist-handoff");
  await page.keyboard.press("Escape");
  // A walkthrough from the help corpus, on the tour's ring.
  await ask("How do I run payroll end to end?", { x: 980, y: 140 });
  await expect(page.getByTestId(A.walk)).toContainText("Step 1 of 5");
  await expect(page).toHaveURL(/\/app\/payroll$/);
  await shot(page, "46-assist-walkthrough");
});
