// GP20. Wave 4 compliance (w4-parity-compliance): the Taxes & Compliance calendar lists filings, deposits and contractor
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

test("an uploaded notice of an unknown kind goes to a tax specialist; required training is recorded", async ({ page }) => {
  await test.step("upload the mailed designee notice: Weft reads it and hands it to a person", async () => {
    await openApp(page, "/app/compliance?tab=notices");
    const up = page.getByTestId("notice-upload");
    await up.getByTestId("notice-upload-file").setInputFiles(new URL("../packages/sim/src/notices/mailed/irs_designee_change.txt", import.meta.url).pathname);
    await up.getByTestId("notice-upload-submit").click();
    await expect(up.getByTestId("notice-upload-result")).toContainText("Uploaded as notice ntc_");
    await openApp(page, "/app/compliance?tab=handoffs");
    await expect(page.getByTestId("handoffs-panel").getByText("unknown notice kind").first()).toBeVisible();
  });

  await test.step("the Training tab lists an overdue course with its statute; recording completion clears it", async () => {
    await openApp(page, "/app/compliance?tab=training");
    const panel = page.getByTestId("training-panel");
    await panel.getByRole("button", { name: "Overdue" }).click();
    const row = panel.locator('[data-status="overdue"]').first();
    await expect(row).toBeVisible();
    await expect(row.getByRole("link", { name: "Statute" })).toHaveAttribute("href", /^https:\/\//);
    const id = await row.getAttribute("data-testid");
    await row.getByRole("button", { name: "Record completion" }).click();
    await panel.getByRole("button", { name: "Completed" }).click();
    await expect(panel.getByTestId(id!)).toHaveAttribute("data-status", "completed");
  });
});
