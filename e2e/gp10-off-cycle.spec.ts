// GP10. Off-cycle pay (docs/wave2.md). Owner of the spec: w2-offboarding.
// An off-cycle request for Hollis (Oct 1 to 15, a bonus) arrives as a proposal; the inbox card lists every earning
// line in cents; Dana approves it there and the off_cycle run goes to the bank simulator like a regular run.
import { approveCard, expect, openApp, test, tid, type PayrollRun } from "./fixtures";

const HOLLIS = "wrk_0042";   // Hollis Grey (demo), TX, $76,000.00 a year

test("GP10: an off-cycle bonus is proposed with its earning lines and approval submits it to the bank", async ({ page, weft }) => {
  let proposalId = "";
  await test.step("the off-cycle request becomes a pending proposal", async () => {
    const out = await weft.post<{ ok: boolean; status: string; proposalId: string }>("/v1/payrolls/off-cycle", {
      workerIds: [HOLLIS], periodStart: "2026-10-01", periodEnd: "2026-10-15", payday: "2026-10-27", reason: "missed_payroll", bonusCents: { [HOLLIS]: 150_000 },
    });
    expect(out).toMatchObject({ ok: true, status: "pending_approval" });
    proposalId = out.proposalId;
  });

  await test.step("the inbox card shows each earning line in cents", async () => {
    await openApp(page, "/app/inbox");
    const card = page.getByTestId(tid.inboxCard(proposalId));
    await expect(card).toContainText("Off-cycle pay (missed payroll)");
    await expect(card).toContainText("Salary (15 of 15 days");
    await expect(card).toContainText("$3,166.67");   // 7,600,000 / 24
    await expect(card).toContainText("$1,500.00");
    const p = await weft.proposal(proposalId);
    expect(p.taintedBy).toBeNull();
    expect(p.risk).toBe("R4");
  });

  await test.step("approval submits the off_cycle run to the bank simulator", async () => {
    const decided = await approveCard(page, weft, proposalId);
    expect(decided.status).toBe("executed");
    const runs: PayrollRun[] = (await weft.payrolls()).filter((r) => r.subtype === "off_cycle");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("processing");
  });
});
