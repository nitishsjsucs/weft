// GP3. New hire in a new state (SPEC 12, P0-7). Owner of the spec: t6-site.
// "Mark accepted" on Noor's offer starts New hire readiness: accounts and the #new-hires post happen directly,
// the CO registrations and the laptop arrive as proposals; once approved, CO shows Awaiting state, a Nov 1 to 15
// draft blocks Noor with UNREGISTERED_STATE, and two simulated business days later both accounts are active,
// CO UI 3.05% exists, and the block is gone (PRORATED and NEW_IN_RUN remain).
import { approveCard, byTidPrefix, chatChannel, eventually, expect, openApp, SEED, test, TID, tid, viewAs } from "./fixtures";

// Registration completes 2 simulated business days after Monday 08:30 PT; stop just before Wednesday's
// 09:00 PT cron slot so the pre-payroll routine does not add proposals to this test.
const AFTER_TWO_BUSINESS_DAYS = "2026-10-28T15:59:00.000Z";

test("GP3: accepting Noor's offer onboards her in Colorado and the first payroll unblocks after registration", async ({ page, weft }) => {
  let noorId = "";
  await test.step("Mark accepted on the Offers tab", async () => {
    await openApp(page, "/app/people");
    await viewAs(page, "dana");
    await page.getByRole("tab", { name: /offers/i }).click();
    await page.getByTestId(tid.offerAccept(SEED.noorOffer)).click();
    const offer = await eventually(() => weft.offers(), (os) => os.find((o) => o.id === SEED.noorOffer && o.status === "accepted" && o.workerId), "the offer is accepted");
    noorId = offer.workerId!;
    const noor = (await weft.workers()).find((w) => w.id === noorId)!;
    expect(noor.displayName).toContain("Noor");
    expect(noor.status).toBe("onboarding");
  });

  await test.step("Noor has a checklist; accounts and the welcome post are created directly", async () => {
    await openApp(page, `/app/people/${noorId}`);
    await expect(byTidPrefix(page, "onboarding-task-").first()).toBeVisible();
    await expect(page.getByTestId(tid.onboardingTask("state_registration"))).toBeVisible();

    const posts = await eventually(() => weft.chat("#new-hires"), (ms) => (ms.some((m) => m.text.includes("Noor")) ? ms : null), "a welcome post in #new-hires");
    expect(posts.some((m) => m.text.includes("Noor"))).toBe(true);
    await openApp(page, "/app/simulators");
    await expect(chatChannel(page, "#new-hires")).toContainText("Noor");

    const direct = await eventually(() => weft.actions(), (as) => {
      const mine = as.filter((a) => a.command === "it.create_account" && a.summary.includes("Noor"));
      return mine.length >= 3 ? mine : null;
    }, "chat, Google Workspace and GitHub accounts created (audited)");
    expect(direct.length).toBeGreaterThanOrEqual(3);
  });

  const proposalIds: string[] = [];
  await test.step("proposals arrive for CO withholding, CO UI and a $1,899.00 laptop; the run is untainted", async () => {
    const pending = await eventually(() => weft.proposals("pending"), (ps) => {
      const regs = ps.filter((p) => p.command === "tax.register_state_account");
      const laptop = ps.find((p) => p.command === "it.order_device");
      return regs.length === 2 && laptop ? [...regs, laptop] : null;
    }, "two registrations and a laptop order");
    const laptop = pending.find((p) => p.command === "it.order_device")!;
    expect(laptop.moneyCents).toBe(189_900);
    for (const p of pending) { expect(p.taintedBy).toBeNull(); proposalIds.push(p.id); }

    await openApp(page, "/app/inbox");
    await expect(page.getByTestId(tid.inboxCard(laptop.id))).toContainText("$1,899.00");
    await expect(page.getByTestId(TID.inboxTaintedBanner)).toHaveCount(0);
    for (const id of proposalIds) await approveCard(page, weft, id);
  });

  await test.step("Compliance shows the CO rows Awaiting state", async () => {
    await openApp(page, "/app/compliance");
    const rows = page.getByTestId(tid.registrationRow("CO"));
    await expect(rows).toHaveCount(2);
    for (const row of await rows.all()) {
      await expect(row).toHaveAttribute("data-status", "awaiting_state");
      await expect(row).toContainText(/awaiting state/i);
    }
  });

  let nextRun = "";
  await test.step("New draft for Nov 1 to 15 flags Noor UNREGISTERED_STATE (block)", async () => {
    await openApp(page, "/app/payroll");
    await page.getByTestId(TID.payrollNewDraft).click();
    const run = await eventually(() => weft.payrolls(), (rs) => rs.find((r) => r.periodStart === "2026-11-01" && r.status === "draft"), "a Nov 1 to 15 draft");
    nextRun = run.id;
    expect((await weft.payroll(SEED.draftRun)).status).toBe("draft");
    await openApp(page, `/app/payroll/${nextRun}`);
    await expect(page.getByTestId(tid.payrollFlag(noorId, "UNREGISTERED_STATE"))).toBeVisible();
    const pc = (await weft.paychecks(nextRun)).find((p) => p.workerId === noorId)!;
    expect(pc.flags.find((f) => f.rule === "UNREGISTERED_STATE")?.severity).toBe("block");
  });

  await test.step("two business days later both accounts are active and CO UI 3.05% appears", async () => {
    await weft.advanceClock({ to: AFTER_TWO_BUSINESS_DAYS });
    const co = await eventually(() => weft.taxAccounts(), (as) => {
      const rows = as.filter((a) => a.jurisdiction === "CO");
      return rows.length === 2 && rows.every((a) => a.status === "active" && a.accountNumber) ? rows : null;
    }, "both CO accounts active with synthetic numbers");
    expect(co).toHaveLength(2);
    const rates = await weft.rates("CO");
    expect(rates.find((r) => r.code === "sui" && r.rate === "0.0305")).toBeTruthy();
    const confirmations = (await weft.notices()).filter((n) => n.kind === "registration_confirmed");
    expect(confirmations.length).toBeGreaterThanOrEqual(2);

    await openApp(page, "/app/compliance");
    for (const row of await page.getByTestId(tid.registrationRow("CO")).all()) await expect(row).toHaveAttribute("data-status", "active");
    await openApp(page, `/app/people/${noorId}`);
    await expect(page.getByTestId(tid.onboardingTask("state_registration"))).toHaveAttribute("data-status", "done");
  });

  await test.step("Preview again shows no block flag on Noor; PRORATED and NEW_IN_RUN remain", async () => {
    await openApp(page, `/app/payroll/${nextRun}`);
    await page.getByTestId(TID.payrollPreview).click();
    await expect(page.getByTestId(tid.payrollFlag(noorId, "UNREGISTERED_STATE"))).toHaveCount(0);
    const pc = await eventually(() => weft.paychecks(nextRun), (ps) => {
      const p = ps.find((x) => x.workerId === noorId);
      return p && !p.flags.some((f) => f.severity === "block") ? p : null;
    }, "Noor has no block flag");
    const rules = pc.flags.map((f) => f.rule);
    expect(rules).toContain("PRORATED");
    expect(rules).toContain("NEW_IN_RUN");
    await expect(page.getByTestId(tid.payrollFlag(noorId, "PRORATED"))).toBeVisible();
  });
});
