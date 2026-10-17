// GP20 (number provisional; the integrator numbers wave 4 golden paths). Wave 4 compliance (w4-parity-compliance): the Taxes & Compliance calendar lists filings, deposits and contractor
// forms by due date; the Q3 Form 941 is prepared from the processed runs and filing it goes to the Inbox as a pending
// R4 proposal, never a direct filing.
import { eventually, expect, openApp, test, type Proposal } from "./fixtures";

test("compliance calendar and the Q3 Form 941 filed through the Inbox", async ({ page, weft }) => {
  await test.step("the calendar shows the Q3 941 due soon, deposits and contractor forms", async () => {
    await openApp(page, "/app/compliance?tab=calendar");
    const cal = page.getByTestId("compliance-calendar");
    await expect(cal).toBeVisible();
    await expect(cal.locator('[data-kind="filing"][data-status="due_soon"]').filter({ hasText: "Form 941 for 2026-Q3" })).toBeVisible();
    await expect(cal.locator('[data-kind="deposit"]').first()).toBeVisible();
    await expect(cal.locator('[data-kind="contractor_form_expiry"]').first()).toBeVisible();
  });

  await test.step("prepare the 941 from payroll and request approval to file it", async () => {
    await openApp(page, "/app/compliance?tab=filings");
    await page.getByTestId("filing-row-941-2026-Q3").click();
    const d = page.getByTestId("filing-detail");
    await d.getByTestId("filing-prepare").click();
    await expect(d.getByTestId("filing-line-2")).toContainText("$439,407.62");
    await expect(d.getByTestId("filing-line-14")).toContainText("$0.00");
    await d.getByTestId("filing-file").click();
    await expect(d.getByTestId("filing-proposed")).toBeVisible();
    const p = await eventually(() => weft.get<{ data: Proposal[] }>("/v1/proposals?status=pending&limit=100"), (r) => r.data.find((x) => x.command === "tax.file_return"), "the tax.file_return proposal");
    expect(p.risk).toBe("R4");
  });
});
