// GP13. Expense review to reimbursement (docs/wave3.md 5). Owner of the spec: w3-expenses.
// Expenses shows the four bands with the seeded counts; rt_expense_review proposes one decision per needs-review
// item; Dana approves the two for Mateo in the Inbox and declines the duplicate from the drawer; the open draft carries
// the reimbursements on Mateo's paycheck outside gross; processing the run moves them to Paid out.
// Run on the track ports (docs/wave3.md 7 table, or the pair assigned for the round), for example:
// WEFT_E2E_WEB_PORT=4680 WEFT_E2E_API_PORT=4681 pnpm e2e gp13
import { W3_EXPENSES_TID as XT, type PageResult, type Paycheck, type Proposal } from "../packages/contracts/src/index";
import { approveCard, eventually, expect, openApp, SEED, test } from "./fixtures";

type Row = { id: string; status: string; band: string };
type Bands = { needs_review: number; approved: number; paid_out: number; declined: number };

test("GP13: one decision per expense, reimbursed on the draft outside gross, paid on processing", async ({ page, weft }) => {
  await test.step("the four bands show the seeded counts", async () => {
    await openApp(page, "/app/expenses");
    for (const [band, n] of Object.entries({ needs_review: 8, approved: 4, paid_out: 0, declined: 2 })) await expect(page.getByTestId(XT.band(band))).toHaveAttribute("data-count", String(n));
    await expect(page.getByTestId(XT.row("exp_0007"))).toHaveAttribute("data-status", "needs_review");
  });

  let proposals: Proposal[] = [];
  await test.step("rt_expense_review proposes exactly one decision per item", async () => {
    await weft.post("/v1/routines/rt_expense_review/trigger", {});
    proposals = await eventually(() => weft.proposals("pending"), (ps) => { const mine = ps.filter((p) => p.command === "expenses.decide"); return mine.length === 8 ? mine : null; }, "eight expense proposals", 60_000);
    const subjects = proposals.map((p) => p.subjectRef).sort();
    expect(subjects).toEqual(["exp_0001", "exp_0002", "exp_0003", "exp_0004", "exp_0005", "exp_0006", "exp_0007", "exp_0008"].map((id) => `expense:${id}`));
  });

  await test.step("Dana approves Mateo's two proposals in the Inbox", async () => {
    await openApp(page, "/app/inbox");
    for (const id of ["exp_0001", "exp_0006"]) await approveCard(page, weft, proposals.find((p) => p.subjectRef === `expense:${id}`)!.id);
    const pcs = await weft.get<PageResult<Paycheck>>(`/v1/payrolls/${SEED.draftRun}/paychecks`, { workerId: "wrk_0005" });
    expect(pcs.data[0]!.reimbursements.amount).toBe(47_622);
  });

  await test.step("the drawer shows the duplicate check and declines that one item", async () => {
    await openApp(page, "/app/expenses");
    await page.getByTestId(XT.row("exp_0007")).click();
    const drawer = page.getByTestId(XT.drawer);
    await expect(drawer.getByTestId(XT.check("DUPLICATE"))).toHaveAttribute("data-severity", "block");
    await expect(drawer.getByTestId(XT.decide("approve"))).toHaveCount(0);
    await drawer.getByTestId(XT.decide("decline")).click();
    await expect(page.getByTestId(XT.drawer)).toHaveAttribute("data-status", "declined");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId(XT.row("exp_0001"))).toHaveAttribute("data-status", "scheduled");
  });

  await test.step("processing the run moves the two reimbursements to Paid out", async () => {
    await weft.post(`/v1/payrolls/${SEED.draftRun}/submit`, { excludeBlocked: true });
    await weft.post("/v1/sim/clock/advance", { to: "2026-10-30T13:00:00.000Z" });
    const paid = await eventually(() => weft.get<{ data: Row[]; bands: Bands }>("/v1/expenses", { band: "paid_out" }), (r) => (r.data.length === 2 ? r.data : null), "two paid expenses");
    expect(paid.map((e) => e.id)).toEqual(["exp_0001", "exp_0006"]);
    await page.reload();
    await expect(page.getByTestId(XT.band("paid_out"))).toHaveAttribute("data-count", "2");
  });
});
