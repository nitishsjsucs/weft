// Screenshot capture for docs/screenshots/ (README Results). `pnpm screenshots` runs it through
// playwright.screens.config.ts: the same dev runner, ports and fresh world per test as `pnpm e2e`, driving the golden
// path flows far enough to show each screen. Never part of `pnpm e2e` (the file name is outside its testMatch).
import { eventually, expect, openApp, test, TID, tid, viewAs, type Proposal } from "../fixtures";
import { W2_ONBOARDING_TID as T } from "../../packages/contracts/src/w2/testids-onboarding";
import { W2_OFFBOARDING_TID as OT, W2_BENEFITS_TID as BT } from "../../packages/contracts/src/index";
import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const OUT = process.env.SHOTS_DIR ?? fileURLToPath(new URL("../../docs/screenshots", import.meta.url));
const shot = async (page: Page, name: string, fullPage = false) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
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
  await page.getByTestId(OT.terminateNote).fill("Moving abroad (demo)");
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
