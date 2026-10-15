// GP2. Pre-payroll review and payroll run (SPEC 12, P0-6). Owner of the spec: t6-site.
// "Run review now" on the Oct 30 draft groups 4 Needs Review and 44 Ready rows with grounded explanations; the
// agent proposes payroll.submit_run with exclude_blocked; Theo approves; the run is processing, then processed after
// payday 06:00 PT, and its totals equal the approved preview.
import { approveCard, byTidPrefix, eventually, expect, openApp, SEED, test, TID, tid, viewAs, type PayrollRun } from "./fixtures";

const PAYDAY_SETTLED = "2026-10-30T13:30:00.000Z";   // Fri Oct 30 06:30 PT (PDT, UTC-7)

test("GP2: run review, approve the submit proposal as Theo, and the run is processed", async ({ page, weft }) => {
  await test.step("Run review now groups 4 Needs Review and 44 Ready rows", async () => {
    await openApp(page, `/app/payroll/${SEED.draftRun}`);
    await page.getByTestId(TID.payrollRunReview).click();
    const needs = page.getByTestId(TID.payrollGroupNeedsReview);
    const ready = page.getByTestId(TID.payrollGroupReady);
    await expect(needs).toContainText(`(${SEED.needsReview})`);
    await expect(ready).toContainText(`(${SEED.ready})`);
    await expect(byTidPrefix(needs, "payroll-row-")).toHaveCount(SEED.needsReview);
  });

  await test.step("each flagged row has a grounded explanation that cites its evidence", async () => {
    const checks = await eventually(() => weft.paychecks(SEED.draftRun), (ps) => {
      const flagged = ps.filter((p) => p.reviewGroup === "needs_review");
      return flagged.length === SEED.needsReview && flagged.every((p) => p.explanation) ? flagged : null;
    }, "4 flagged paychecks with explanations");
    const rules = new Set(checks.flatMap((p) => p.flags.map((f) => f.rule)));
    for (const r of ["GROSS_CHANGE", "HOURS_SPIKE", "MISSING_BANK_ACCOUNT", "PRORATED"]) expect(rules.has(r as never), `a ${r} flag`).toBe(true);
    for (const p of checks) {
      await expect(page.getByTestId(tid.payrollRow(p.workerId))).toBeVisible();
      for (const f of p.flags) await expect(page.getByTestId(tid.payrollFlag(p.workerId, f.rule))).toBeVisible();
    }
    // The NY raise explanation cites the raise action (pay rate id, action seq or result id).
    const raise = checks.find((p) => p.flags.some((f) => f.rule === "GROSS_CHANGE" && JSON.stringify(f.evidence).includes("prt_")));
    expect(raise, "a GROSS_CHANGE flag whose evidence carries the prt_ id").toBeTruthy();
  });

  let approved!: PayrollRun;
  let submitCents: number | null = null;
  await test.step("the agent proposes payroll.submit_run with exclude_blocked: true", async () => {
    const submit = await eventually(() => weft.proposals("pending"), (ps) => ps.find((p) => p.command === "payroll.submit_run"), "a submit_run proposal");
    expect(submit.args).toMatchObject({ exclude_blocked: true });
    expect(submit.risk).toMatch(/^R[2-4]$/);
    submitCents = submit.moneyCents;

    await openApp(page, "/app/inbox");
    await viewAs(page, "theo");
    await approveCard(page, weft, submit.id);
  });

  await test.step("status goes processing, then processed after payday 06:00 PT", async () => {
    await openApp(page, `/app/payroll/${SEED.draftRun}`);
    await expect(page.getByTestId(TID.payrollStatus)).toHaveText(/processing/i);
    approved = await weft.payroll(SEED.draftRun);
    expect(approved.status).toBe("processing");
    await weft.advanceClock({ to: PAYDAY_SETTLED });
    await page.reload();
    await expect(page.getByTestId(TID.payrollStatus)).toHaveText(/processed/i);
  });

  await test.step("totals on the processed run equal the approved preview (47 included paychecks)", async () => {
    const run = await weft.payroll(SEED.draftRun);
    expect(run.status).toBe("processed");
    expect(run.totals).toEqual(approved.totals);
    if (submitCents !== null) expect(run.totals!.totalCost.amount, "proposal amount is the totalCost after exclude_blocked").toBe(submitCents);
    const paychecks = await weft.paychecks(SEED.draftRun);
    const included = paychecks.filter((p) => p.status === "processed");
    expect(included).toHaveLength(SEED.includedAfterExclude);
    expect(paychecks.filter((p) => p.status === "excluded")).toHaveLength(1);
    expect(run.totals!.netPay.amount).toBe(included.reduce((s, p) => s + p.net.amount, 0));
    await expect(page.getByTestId(TID.payrollTotals)).toContainText(run.totals!.netPay.display);
  });
});
