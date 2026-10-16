// GP11. Benefits reconciliation and contractor payouts (docs/wave2.md). Owner of the spec: w2-benefits-contractors.
// Dana runs reconciliation for October on the Benefits screen and sees exactly the three planted findings with the
// billed, expected and deducted amounts the API reports; she disputes the missing dependent finding; the Open
// enrollment tab lists who still has to choose; on Contractors she pays the three contractors and, as the sim clock
// moves two business days, the rail status goes from sent to delivered.
import { W2_BENEFITS_TID as BT, type ContractorPayout, type ReconFinding } from "../packages/contracts/src/index";
import { eventually, expect, openApp, SIM_STEP, test, tid } from "./fixtures";

const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

test("GP11: reconciliation finds the three planted errors, a dispute goes out, payouts move sent to delivered", async ({ page, weft }) => {
  await test.step("run reconciliation for October", async () => {
    await openApp(page, "/app/benefits");
    await page.getByTestId(BT.tabRecon).click();
    await expect(page.getByTestId(BT.reconMonth)).toHaveValue("2026-10");
    await page.getByTestId(BT.reconRun).click();
    await expect(page.getByTestId(BT.reconNotice)).toContainText("3 findings");
    const findings = await weft.get<ReconFinding[]>("/v1/benefits/reconciliation", { month: "2026-10" });
    expect(findings.map((f) => f.kind)).toEqual(["terminated_but_billed", "missing_dependent", "wrong_tier"]);
    for (const f of findings) {
      const row = page.getByTestId(BT.reconRow(f.id));
      await expect(row).toHaveAttribute("data-kind", f.kind);
      for (const c of [f.billedCents, f.expectedCents, f.deductedCents]) await expect(row).toContainText(usd(c));
    }
  });

  await test.step("dispute the missing dependent finding", async () => {
    const [f] = (await weft.get<ReconFinding[]>("/v1/benefits/reconciliation", { month: "2026-10" })).filter((x) => x.kind === "missing_dependent");
    await page.getByTestId(BT.reconDispute(f!.id)).click();
    await page.getByTestId(BT.reconDisputeConfirm).click();
    await expect(page.getByTestId(BT.reconRow(f!.id))).toContainText("Disputed");
    const after = await weft.get<ReconFinding[]>("/v1/benefits/reconciliation", { status: "disputed" });
    expect(after.map((x) => x.id)).toEqual([f!.id]);
  });

  await test.step("open enrollment lists who still has to choose", async () => {
    await page.getByTestId(BT.tabEnrollment).click();
    const rows = await weft.get<{ workerId: string; status: string }[]>("/v1/benefits/open-enrollment");
    const waiting = rows.filter((r) => r.status === "not_started" || r.status === "in_progress");
    expect(waiting.length).toBeGreaterThan(0);
    await expect(page.getByTestId(BT.enrollmentRow(waiting[0]!.workerId))).toHaveAttribute("data-status", waiting[0]!.status);
    await expect(page.getByTestId(BT.enrollmentNudge)).toContainText(`Remind ${waiting.length}`);
  });

  await test.step("pay the contractors and watch the rail deliver on the sim clock", async () => {
    await openApp(page, "/app/contractors");
    await page.getByTestId(BT.payoutsSchedule).click();
    const booked = await eventually(() => weft.get<{ data: ContractorPayout[] }>("/v1/contractors/payouts"), (p) => (p.data.length === 3 ? p.data : null), "three payouts");
    expect(booked.map((p) => p.usdCents)).toEqual([702_000, 492_000, 715_400]);
    await page.reload();
    for (const p of booked) await expect(page.getByTestId(BT.payoutRow(p.id))).toHaveAttribute("data-rail", "sent");
    await openApp(page, "/app/simulators");
    await page.getByTestId(tid.simAdvance(SIM_STEP.oneDay)).click();
    await page.getByTestId(tid.simAdvance(SIM_STEP.oneDay)).click();
    await expect.poll(async () => (await weft.get<{ data: ContractorPayout[] }>("/v1/contractors/payouts")).data.map((p) => p.railStatus).join(",")).toBe("delivered,delivered,delivered");
    await openApp(page, "/app/contractors");
    for (const p of booked) await expect(page.getByTestId(BT.payoutRow(p.id))).toHaveAttribute("data-rail", "delivered");
  });
});
