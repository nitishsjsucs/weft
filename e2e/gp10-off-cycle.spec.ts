// GP10. Off-cycle pay (docs/wave2.md). Owner of the spec: w2-offboarding.
// From Hollis's person header Dana asks for off-cycle pay for the missed Oct 1 to 15 period with a $1,500.00 bonus.
// It arrives as a proposal whose card lists every earning line in cents; Dana approves it and the off_cycle run goes
// to the bank simulator like a regular run.
import { approveCard, eventually, expect, openApp, test, tid, type PayrollRun } from "./fixtures";
import { W2_OFFBOARDING_TID as OT } from "../packages/contracts/src/index";

const HOLLIS = "wrk_0042";   // Hollis Grey (demo), TX, $76,000.00 a year

test("GP10: off-cycle pay with a bonus is proposed with its earning lines and approval submits it to the bank", async ({ page, weft }) => {
  let proposalId = "";
  await test.step("Off-cycle pay from the person header becomes a pending proposal", async () => {
    await openApp(page, `/app/people/${HOLLIS}`);
    await page.getByTestId(OT.personOffCycle).click();
    await expect(page.getByTestId(OT.offCyclePeriodStart)).toHaveValue("2026-10-01");
    await expect(page.getByTestId(OT.offCyclePeriodEnd)).toHaveValue("2026-10-15");
    await page.getByTestId(OT.offCyclePayday).fill("2026-10-27");
    await page.getByTestId(OT.offCycleBonus).fill("1500.00");
    await page.getByTestId(OT.offCycleSubmit).click();
    const p = await eventually(() => weft.proposals("pending"), (ps) => ps.find((x) => x.command === "payroll.propose_off_cycle"), "an off-cycle proposal");
    proposalId = p.id;
    expect(p.taintedBy).toBeNull();
    expect(p.risk).toBe("R4");
  });

  await test.step("the card shows each earning line in cents", async () => {
    const card = page.getByTestId(tid.inboxCard(proposalId));
    await expect(card).toContainText("Off-cycle pay (missed payroll)");
    await expect(card).toContainText("Salary (15 of 15 days");
    await expect(card).toContainText("$3,166.67");   // 7,600,000 / 24
    await expect(card).toContainText("$1,500.00");
  });

  await test.step("approval submits the off_cycle run to the bank simulator", async () => {
    const decided = await approveCard(page, weft, proposalId);
    expect(decided.status).toBe("executed");
    const runs: PayrollRun[] = (await weft.payrolls()).filter((r) => r.subtype === "off_cycle");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("processing");
  });
});
