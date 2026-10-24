// GP13. Expense review to reimbursement (docs/wave3.md 5). Owner of the spec: w3-expenses.
// Expenses shows the four bands with the seeded counts; rt_expense_review proposes one decision per needs-review
// item; Vic approves the two for Mateo in the Inbox and declines the duplicate from the drawer; the open draft carries
// the reimbursements on Mateo's paycheck outside gross; processing the run moves them to Paid out. The second test is
// the employee side: a new hire files a claim with a receipt in the portal, reads the return note and resubmits it.
// Run on the track ports (docs/wave3.md 7 table, or the pair assigned for the round), for example:
// WEFT_E2E_WEB_PORT=4680 WEFT_E2E_API_PORT=4681 pnpm e2e gp13
import { W3_EXPENSES_TID as XT, type PageResult, type Paycheck, type Proposal } from "../packages/contracts/src/index";
import { approveCard, eventually, expect, openApp, SEED, test, WeftApi } from "./fixtures";

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

  await test.step("Vic approves Mateo's two proposals in the Inbox", async () => {
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

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

test("GP13 portal: the employee files a claim with a receipt, reads the return note and resubmits the fix", async ({ page, weft, request }) => {
  const offerId = (await weft.post<{ data: { offer_id: string } }>("/v1/offers", { candidateFirst: "Juno", candidateLast: "Hale", candidateEmail: "juno.hale@candidate.example", title: "Field Test Technician", departmentId: "dpt_hardware", workState: "CA", baseCents: 9_800_000, startDate: "2026-11-02" })).data.offer_id;
  const sent = (await weft.post<{ data: { persona_principal_id: string; reserved_worker_id: string } }>(`/v1/offers/${offerId}/send`)).data;
  const persona = new WeftApi(request, sent.persona_principal_id);
  await persona.post("/v1/portal/offer/view");
  const letter = (await persona.get<{ documents: { id: string; sha256: string }[] }>("/v1/portal/me")).documents[0]!;
  await persona.post(`/v1/portal/documents/${letter.id}/sign`, { typedName: "Juno Hale", documentSha256: letter.sha256 });
  const section = page.getByTestId(XT.portal);
  let id = "";

  await test.step("the portal submits a meal with a receipt and lists it in review", async () => {
    await page.goto(`/portal?as=${sent.persona_principal_id}`);
    await expect(section).toContainText("No expenses yet");
    await section.getByTestId(XT.portalNew).click();
    await section.getByTestId(XT.portalField("category")).selectOption("meals");
    await section.getByTestId(XT.portalField("date")).fill("2026-10-20");
    await section.getByTestId(XT.portalField("merchant")).fill("Harbor Noodle");
    await section.getByTestId(XT.portalField("amount")).fill("42.50");
    await section.getByTestId(XT.portalField("purpose")).fill("Lunch with the hiring team");
    await section.getByTestId(XT.portalField("receipt")).setInputFiles({ name: "lunch.png", mimeType: "image/png", buffer: PNG });
    await section.getByTestId(XT.portalSubmit).click();
    await expect(section.getByRole("status")).toContainText("waiting for review");
    const mine = await persona.get<{ data: { id: string; status: string; hasReceipt: boolean; checks: { rule: string }[] }[] }>("/v1/portal/expenses");
    expect(mine.data).toHaveLength(1);
    id = mine.data[0]!.id;
    expect(mine.data[0]).toMatchObject({ status: "needs_review", hasReceipt: true });
    expect(mine.data[0]!.checks.map((c) => c.rule).sort()).toEqual(["MEALS_DETAIL_MISSING", "OUTSIDE_EMPLOYMENT"]);
    await expect(section.getByTestId(`portal-expense-${id}`)).toHaveAttribute("data-status", "needs_review");
  });

  await test.step("Vic returns it with a note; the employee reads it and resubmits with the attendees", async () => {
    await weft.post(`/v1/expenses/${id}/decide`, { decision: "return", note: "Please list who joined the lunch." });
    await page.reload();
    await expect(section.getByTestId(`portal-expense-${id}`)).toHaveAttribute("data-status", "returned");
    await expect(section.getByTestId(XT.portalNote(id))).toHaveText("Please list who joined the lunch.");
    await section.getByTestId(XT.portalResubmit(id)).click();
    await expect(section.getByTestId(XT.portalField("merchant"))).toHaveValue("Harbor Noodle");
    await section.getByTestId(XT.portalField("attendees")).fill("Juno Hale, Vic Akisole");
    await section.getByTestId(XT.portalSubmit).click();
    await expect(section.getByTestId(`portal-expense-${id}`)).toHaveAttribute("data-status", "needs_review");
    const d = await weft.get<{ attendees: string; hasReceipt: boolean; checks: { rule: string }[]; trail: { command: string }[] }>(`/v1/expenses/${id}`);
    expect(d).toMatchObject({ attendees: "Juno Hale, Vic Akisole", hasReceipt: true });
    expect(d.checks.map((c) => c.rule)).toEqual(["OUTSIDE_EMPLOYMENT"]);
    expect(d.trail.map((t) => t.command)).toEqual(["expenses.submit", "expenses.decide", "expenses.resubmit"]);
  });
});
