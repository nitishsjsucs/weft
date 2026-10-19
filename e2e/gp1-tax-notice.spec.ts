// GP1. Tax notice to rate change, the hero flow (SPEC 12, P0-5). Owner of the spec: t6-site.
// Simulators panel delivers the CA EDD DE 2088 revised rate notice; the agent proposes the SUI rate change and the
// filed response; Dana approves both; the rate history, notice, next preview and audit chain reflect it; Undo on
// the rate change restores 3.4% and the filing says it cannot be reversed.
import { approveCard, byTidPrefix, employerTaxCents, eventually, expect, openApp, SEED, test, TID, tid, viewAs, type Paycheck, type Proposal } from "./fixtures";

const SCENARIO = "ca_de2088_rate_change";

test("GP1: CA EDD DE 2088 notice becomes an approved SUI rate change, a filed response, and an undo", async ({ page, weft }) => {
  const before = await weft.paychecks(SEED.draftRun);
  const caSuiBefore = new Map(before.map((p) => [p.workerId, employerTaxCents(p, "sui", "CA")]));

  await test.step("deliver the notice from the Simulators panel", async () => {
    await openApp(page, "/app/simulators");
    await viewAs(page, "dana");
    await page.getByTestId(tid.simDeliver(SCENARIO)).click();
  });

  let rate!: Proposal, filing!: Proposal;
  await test.step("the agent run shows live steps and two proposals land", async () => {
    const pending = await eventually(() => weft.proposals("pending"), (ps) => (ps.length >= 2 ? ps : null), "two pending proposals");
    expect(pending).toHaveLength(2);
    rate = pending.find((p) => p.command === "tax.update_rate")!;
    filing = pending.find((p) => p.command === "notices.send_response")!;
    expect(rate, "a tax.update_rate proposal").toBeTruthy();
    expect(filing, "a notices.send_response proposal").toBeTruthy();
    // Arg names belong to T2's command; assert the values (SPEC 12 L1: CA SUI 0.034 to 0.015 from 2026-01-01).
    const args = JSON.stringify(rate.args);
    for (const v of ["0.015", "2026-01-01"]) expect(args).toContain(v);
    expect(args.toLowerCase()).toContain("sui");
    expect(rate.taintedBy).toBeNull();
    expect(filing.taintedBy).toBeNull();

    const run = (await weft.agentRuns()).find((r) => r.id === rate.proposerRunId);
    expect(run, "the proposing run is listed").toBeTruthy();
    expect(run!.status).toBe("waiting");
    expect(run!.tainted).toBe(false);

    await openApp(page, `/app/runs/${rate.proposerRunId}`);
    await expect(page.getByTestId(TID.runStep).first()).toBeVisible();
  });

  await test.step("the Inbox shows the rate diff and the content to be sent, untainted", async () => {
    await openApp(page, "/app/inbox");
    const rateCard = page.getByTestId(tid.inboxCard(rate.id));
    const filingCard = page.getByTestId(tid.inboxCard(filing.id));
    await expect(rateCard).toBeVisible();
    await expect(filingCard).toBeVisible();
    const diff = rateCard.getByTestId(TID.proposalDiff);
    await expect(diff).toContainText("3.4%");
    await expect(diff).toContainText("1.5%");
    // The diff carries the exact YTD credit computed by tax.rate_change_impact; the card must show those cents.
    for (const row of rate.diff) {
      await expect(diff).toContainText(row.before);
      await expect(diff).toContainText(row.after);
    }
    const credit = rate.diff.find((d) => /credit|ytd/i.test(d.label));
    expect(credit, "the diff has a YTD credit row").toBeTruthy();
    await expect(filingCard.getByTestId(TID.proposalContent)).not.toBeEmpty();
    for (const c of filing.content) await expect(filingCard.getByTestId(TID.proposalContent)).toContainText(c.text.slice(0, 60));
    await expect(page.getByTestId(TID.inboxTaintedBanner)).toHaveCount(0);
    // The notice routine's run proposed both, so each card names the routine (its run id behind the name) and links
    // the agent run.
    for (const [card, p] of [[rateCard, rate], [filingCard, filing]] as const) {
      await expect(card).toContainText("Routine: Agency notice handling");
      await expect(card).toContainText(p.routineRunId!);
      await expect(card.locator(`a[href="/app/runs/${p.proposerRunId}"]`)).toBeVisible();
    }
  });

  await test.step("Dana approves both; the run ends done with no further model steps", async () => {
    const stepsBefore = (await weft.agentRuns()).find((r) => r.id === rate.proposerRunId)!.stepsUsed;
    await approveCard(page, weft, rate.id);
    await approveCard(page, weft, filing.id);
    const done = await eventually(() => weft.agentRuns(), (rs) => rs.find((r) => r.id === rate.proposerRunId && r.status === "done"), "the run ends done");
    expect(done.stepsUsed).toBe(stepsBefore);
  });

  let rateSeq = 0;
  await test.step("rate history, notice and next preview reflect the change", async () => {
    const rates = await weft.rates("CA");
    const fresh = rates.find((r) => r.code === "sui" && r.rate === "0.015" && r.source.startsWith("notice:ntc_"));
    expect(fresh, "a CA SUI 1.5% row sourced from the notice").toBeTruthy();
    expect(fresh!.effectiveFrom).toBe("2026-01-01");
    rateSeq = fresh!.createdActionSeq!;

    const notice = (await weft.notices()).find((n) => n.formCode.toUpperCase().includes("DE 2088") || n.formCode.toUpperCase().includes("DE2088"));
    expect(notice, "the DE 2088 notice").toBeTruthy();
    const resolved = await eventually(() => weft.notice(notice!.id), (n) => (n.status === "resolved" ? n : null), "the notice is resolved");
    expect(resolved.responseConfirmation).toMatch(/^CA-EDD-R-\d+/);

    await openApp(page, "/app/compliance");
    await page.getByRole("tab", { name: /rates/i }).click();
    await expect(byTidPrefix(page, tid.rateRow("CA", "sui")).filter({ hasText: "1.5" }).first()).toBeVisible();
    await page.getByRole("tab", { name: /notices/i }).click();
    const row = page.getByTestId(tid.noticeRow(notice!.id));
    await expect(row.getByTestId(TID.noticeStatus)).toHaveText(/resolved/i);

    await openApp(page, `/app/payroll/${SEED.draftRun}`);
    await page.getByTestId(TID.payrollPreview).click();
    const after = await eventually(() => weft.paychecks(SEED.draftRun), (ps) => (ps.some((p) => employerTaxCents(p, "sui", "CA") !== caSuiBefore.get(p.workerId)) ? ps : null), "preview shows the new SUI");
    const changed = after.filter((p) => employerTaxCents(p, "sui", "CA") !== caSuiBefore.get(p.workerId));
    expect(changed, "exactly the 3 CA workers under the wage base change").toHaveLength(SEED.caUnderWageBase);
    for (const p of changed) expect(employerTaxCents(p, "sui", "CA")).toBeLessThan(caSuiBefore.get(p.workerId)!);
  });

  await test.step("the audit log shows the rows with a valid chain", async () => {
    await openApp(page, "/app/audit");
    await expect(page.getByTestId(TID.auditChainStatus)).toHaveText(/valid|verified|intact|ok/i);
    await expect(page.getByTestId(tid.auditRow(rateSeq))).toBeVisible();
    expect((await weft.chain()).ok).toBe(true);
  });

  await test.step("Undo on the rate change restores 3.4% and the preview returns to the prior numbers", async () => {
    await page.getByTestId(tid.auditUndo(rateSeq)).click();
    const reversal = await eventually(() => weft.actions(), (as) => as.find((a) => a.reversesSeq === rateSeq), "a reversing action row");
    await expect(page.getByTestId(tid.auditRow(reversal.seq))).toBeVisible();
    const original = (await weft.actions()).find((a) => a.seq === rateSeq)!;
    expect(original.reversedBySeq).toBe(reversal.seq);

    const filingAction = (await weft.actions()).find((a) => a.proposalId === filing.id)!;
    expect(filingAction.reversible).toBe("no");
    await expect(page.getByTestId(tid.auditRow(filingAction.seq))).toContainText("Not reversible: filed with the agency simulator");
    await expect(page.getByTestId(tid.auditUndo(filingAction.seq))).toHaveCount(0);

    await openApp(page, `/app/payroll/${SEED.draftRun}`);
    await page.getByTestId(TID.payrollPreview).click();
    await eventually(() => weft.paychecks(SEED.draftRun), (ps: Paycheck[]) => ps.every((p) => employerTaxCents(p, "sui", "CA") === caSuiBefore.get(p.workerId)), "preview returns to the prior SUI");
    expect((await weft.chain()).ok).toBe(true);
  });
});
