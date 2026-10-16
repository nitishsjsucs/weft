// GP10. Off-cycle pay (docs/wave2.md). Owner of the spec: w2-offboarding.
// From Hollis's person header Dana first asks for missed pay for Oct 1 to 15; the Oct 15 run already paid him, so it
// is refused and nothing is paid twice. She then proposes a $1,500.00 bonus only. It arrives as a proposal whose card
// lists every earning line in cents; Dana approves it and the off_cycle run goes to the bank simulator like a
// regular run. The missed-period proration is covered by the GP10 scenario test and pnpm demo.
import { approveCard, eventually, expect, openApp, PEOPLE, test, tid, type PayrollRun } from "./fixtures";
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
    await expect(page.getByTestId(OT.terminateError)).toContainText("already paid");
    await page.getByTestId(OT.offCycleReason).selectOption("bonus");
    await page.getByTestId(OT.offCycleSubmit).click();
    const p = await eventually(() => weft.proposals("pending"), (ps) => ps.find((x) => x.command === "payroll.propose_off_cycle"), "an off-cycle proposal");
    proposalId = p.id;
    expect(p.taintedBy).toBeNull();
    expect(p.risk).toBe("R4");
  });

  await test.step("the card shows each earning line in cents", async () => {
    const card = page.getByTestId(tid.inboxCard(proposalId));
    await expect(card).toContainText("Off-cycle pay (bonus)");
    await expect(card).toContainText("Bonus (supplemental wages");
    await expect(card).toContainText("$1,500.00");
    await expect(card).not.toContainText("Salary (");
  });

  await test.step("the card names Dana as the proposer and labels her reason as her note, not the agent's", async () => {
    const card = page.getByTestId(tid.inboxCard(proposalId));
    const p = await weft.proposal(proposalId);
    expect(p.proposerRunId, "Dana proposed it in the app, not through an agent run").toBeNull();
    expect(p.onBehalfOf).toBe(PEOPLE.dana.id);
    await expect(card.getByTestId("proposal-note-label")).toHaveText(`Note from ${PEOPLE.dana.name}`);
    await expect(card.getByTestId("proposal-note-label")).toHaveAttribute("data-proposer", "person");
    await expect(card.locator("dt", { hasText: "Proposed by" }).locator("xpath=following-sibling::dd")).toHaveText(PEOPLE.dana.name);
    await expect(card).not.toContainText("Agent's note");
    await expect(card).not.toContainText("Note from the agent");
  });

  await test.step("approval submits the off_cycle run to the bank simulator", async () => {
    const decided = await approveCard(page, weft, proposalId);
    expect(decided.status).toBe("executed");
    const runs: PayrollRun[] = (await weft.payrolls()).filter((r) => r.subtype === "off_cycle");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("processing");
  });
});
