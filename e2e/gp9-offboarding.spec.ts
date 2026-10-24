// GP9. Termination with access revocation (docs/wave2.md). Owner of the spec: w2-offboarding.
// From Imani's person header Vic terminates her (voluntary, last day Oct 30). The case opens with the eight
// ordered steps; final pay, directory suspend, SSO deactivation and device lock wait as proposals with previews.
// Approving them in the case view runs the bank, IdP and device simulators; "Run remaining steps" removes groups
// and apps, sends the COBRA notice and ends benefits. Every step has an action row and the case reads Complete.
import { approveCard, eventually, expect, openApp, test, type Proposal, type Worker } from "./fixtures";
import { W2_OFFBOARDING_TID as OT, w2OffboardingTid as ot, OFFBOARDING_STEP_ORDER, type OffboardingCase } from "../packages/contracts/src/index";

const IMANI = "wrk_0004";
const PROPOSAL_STEPS = ["final_pay", "directory_suspend", "sso_deactivate", "device_lock"] as const;

test("GP9: terminating Imani opens an offboarding case that revokes access and completes", async ({ page, weft }) => {
  await test.step("Imani has an SSO account to deactivate", async () => {
    await weft.post("/v1/tools/it.create_account", { worker_id: IMANI, system: "sso" });
  });

  let caseId = "";
  await test.step("Terminate from the person header", async () => {
    await openApp(page, `/app/people/${IMANI}`);
    await page.getByTestId(OT.personTerminate).click();
    await page.getByTestId(OT.terminateKind).selectOption("voluntary");
    await page.getByTestId(OT.terminateLastDay).fill("2026-10-30");
    await page.getByTestId(OT.terminateNote).fill("Moving abroad");
    await page.getByTestId(OT.terminateSubmit).click();
    await page.waitForURL(/\/app\/offboarding\/ofb_/);
    caseId = page.url().split("/").pop()!;
    const w = (await weft.get<{ worker: Worker }>(`/v1/workers/${IMANI}`)).worker;
    expect(w.status).toBe("offboarding");
  });

  const proposalIds: Record<string, string> = {};
  await test.step("the case shows the eight steps in order, four of them waiting for approval", async () => {
    await expect(page.getByTestId(OT.caseSteps)).toBeVisible();
    const c = await weft.get<OffboardingCase>(`/v1/offboarding/${caseId}`);
    expect(c.steps.map((s) => s.kind)).toEqual([...OFFBOARDING_STEP_ORDER]);
    for (const kind of PROPOSAL_STEPS) {
      await expect(page.getByTestId(ot.stepStatus(kind))).toHaveAttribute("data-status", "proposed");
      const s = c.steps.find((x) => x.kind === kind)!;
      expect(s.proposalId).toMatch(/^prp_/);
      proposalIds[kind] = s.proposalId!;
      await expect(page.getByTestId(ot.stepProposal(kind))).toHaveAttribute("href", `/app/inbox?proposal=${s.proposalId}`);
    }
    const fp = await weft.proposal(proposalIds.final_pay!);
    expect(fp.taintedBy).toBeNull();
    expect(fp.diff.map((d) => d.label)).toEqual(expect.arrayContaining(["Gross pay", "Net pay to bank"]));
    await expect(page.getByTestId(OT.runRemaining)).toBeDisabled();
  });

  await test.step("approving the proposals runs the bank, IdP and device simulators", async () => {
    for (const kind of PROPOSAL_STEPS) {
      const decided: Proposal = await approveCard(page, weft, proposalIds[kind]!);
      expect(decided.status).toBe("executed");
      await expect(page.getByTestId(ot.stepStatus(kind))).toHaveText("Done");
    }
    const runs = await weft.payrolls();
    const dismissal = runs.filter((r) => r.subtype === "dismissal");
    expect(dismissal).toHaveLength(1);
    expect(dismissal[0]!.status).toBe("processing");
  });

  await test.step("Run remaining steps finishes the case", async () => {
    await expect(page.getByTestId(OT.runRemaining)).toBeEnabled();
    await page.getByTestId(OT.runRemaining).click();
    await expect(page.getByTestId(OT.caseStatus)).toHaveText("Complete");
    const c = await eventually(() => weft.get<OffboardingCase>(`/v1/offboarding/${caseId}`), (x) => (x.status === "complete" ? x : null), "the case completes");
    expect(c.steps.every((s) => s.status === "done")).toBe(true);
    const w = (await weft.get<{ worker: Worker }>(`/v1/workers/${IMANI}`)).worker;
    expect(w.status).toBe("inactive");
    expect(w.endDate).toBe("2026-10-30");
    const acts = await weft.actions();
    for (const s of c.steps) expect(acts.some((a) => a.seq === s.actionSeq && a.command.startsWith("offboarding.")), s.kind).toBe(true);
  });

  await test.step("the list shows the completed case", async () => {
    await openApp(page, "/app/offboarding");
    await expect(page.getByTestId(ot.caseRow(caseId))).toContainText("Complete");
  });
});
