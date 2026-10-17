// GP23. Reports (wave 4, w4-parity-admin). At 1440 with the agent docked: the sidebar opens Reports, every metric in the
// catalog draws a chart and a table, the range and grouping refetch, and "Email this report" files a proposal that
// sends nothing until it is approved. At 390 the metric list is a select and nothing scrolls sideways.
import type { Page } from "@playwright/test";
import { eventually, expect, openApp, test, tid, WeftApi } from "./fixtures";
import { W3_SHELL_TID as S } from "../packages/contracts/src/w3/testids-shell";
import { W3_TOPBAR_SHELL_DOM as DOM } from "../packages/contracts/src/ext/w3-topbar-shell";
import { ReportMetric, ReportMetricW4 } from "../packages/contracts/src/index";
import { W4_ADMIN_TID as T } from "../apps/web/src/components/app/reports/testids";

const METRICS = [...ReportMetric.options, ...ReportMetricW4.options];
type Mail = { id: string; to: string; subject: string };
type Prop = { id: string; status: string; command: string };

async function noSideScroll(page: Page, label: string) {
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(m.scroll, `${label}: page scrollWidth ${m.scroll} within ${m.client}`).toBeLessThanOrEqual(m.client);
}

test("Reports: every metric charts and tabulates, and emailing one waits for approval", async ({ page, request }) => {
  const weft = new WeftApi(request);
  await test.step("1440 docked: the sidebar opens Reports beside the docked agent panel", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "/app");
    await page.getByTestId(tid.nav("reports")).click();
    await expect(page.getByTestId(T.reportsPage)).toBeVisible();
    await expect(page.getByTestId(S.agentToggle)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(`#${DOM.agentPanel}`)).toBeVisible();
  });

  await test.step("every catalog metric draws a chart and a table", async () => {
    await page.getByTestId(T.from).fill("2026-01-01");
    for (const m of METRICS) {
      await page.getByTestId(T.metric(m)).click();
      await expect(page.getByTestId(T.chart)).toHaveAttribute("data-metric", m);
      await expect(page.getByTestId(T.table)).toBeVisible();
      await noSideScroll(page, `1440 ${m}`);
    }
  });

  await test.step("payroll cost by state: the table carries a row per state and the range total", async () => {
    await page.getByTestId(T.metric("payroll_cost_by_state")).click();
    await expect(page.getByTestId(T.chart)).toHaveAttribute("data-metric", "payroll_cost_by_state");
    const table = page.getByTestId(T.table);
    for (const s of ["CA", "NY", "TX"]) await expect(table).toContainText(s);
    await expect(table.locator("tr[data-total=true]")).toContainText("Total");
  });

  await test.step("grouping by quarter refetches a series metric", async () => {
    await page.getByTestId(T.metric("contractor_vs_employee_cost_by_month")).click();
    await page.getByTestId(T.groupBy).selectOption("quarter");
    await expect(page.getByTestId(T.table)).toContainText("Q4 2026");
  });

  await test.step("Email this report files a proposal and sends nothing yet", async () => {
    await page.getByTestId(T.metric("headcount_and_cost_by_state")).click();
    await expect(page.getByTestId(T.chart)).toHaveAttribute("data-metric", "headcount_and_cost_by_state");
    const before = (await weft.get<Mail[]>("/v1/sim/email", { to: "cfo@larkspur.example" })).length;
    await page.getByTestId(T.emailOpen).click();
    await page.getByTestId(T.emailRecipients).fill("cfo@larkspur.example");
    await page.getByTestId(T.emailSend).click();
    const result = page.getByTestId(T.emailResult);
    await expect(result).toHaveAttribute("data-status", "pending_approval");
    const id = await result.getAttribute("data-proposal");
    const p = await weft.get<Prop>(`/v1/proposals/${id}`);
    expect(p).toMatchObject({ status: "pending", command: "comms.send_report" });
    expect((await weft.get<Mail[]>("/v1/sim/email", { to: "cfo@larkspur.example" })).length).toBe(before);
    await weft.post(`/v1/proposals/${id}/approve`, { reasonCode: null, note: null });
    const mail = await eventually(() => weft.get<Mail[]>("/v1/sim/email", { to: "cfo@larkspur.example" }), (m) => (m.length === before + 1 ? m : null), "the approved report email");
    expect(mail.at(-1)!.subject).toContain("Headcount and payroll cost by state");
  });

  await test.step("390: the metric list is a select, the chart and table fit, nothing scrolls sideways", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, "/app/reports");
    const select = page.getByTestId(T.metricSelect);
    await expect(select).toBeVisible();
    for (const m of ["payroll_cost_by_month", "payroll_cost_by_state", "compliance_due_by_month"]) {
      await select.selectOption(m);
      await expect(page.getByTestId(T.chart)).toHaveAttribute("data-metric", m);
      await expect(page.getByTestId(T.table)).toBeVisible();
      await noSideScroll(page, `390 ${m}`);
    }
  });
});
