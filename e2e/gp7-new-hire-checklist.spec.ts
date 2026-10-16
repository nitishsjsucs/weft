// GP7. The new-hire checklist unblocks payroll (docs/wave2.md). Owner: w2-onboarding. Setup (offer sent and signed)
// goes through the API; the new hire then files the W-4, the CO DR 0004, direct deposit (an ABA failure is refused
// inline, a valid number verifies), the I-9 with an ID image and a benefits election in the portal. 7 of 7 turns the
// worker active and the next payroll draft pays them with no MISSING_BANK_ACCOUNT flag.
import { WeftApi, eventually, expect, test } from "./fixtures";
import { W2_ONBOARDING_TID as T } from "../packages/contracts/src/w2/testids-onboarding";

const NAME = "Rowan Ellery";
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

test("GP7: the new hire completes the checklist and the next payroll draft pays them", async ({ page, weft, request }) => {
  const offerId = (await weft.post<{ data: { offer_id: string } }>("/v1/offers", { candidateFirst: "Rowan", candidateLast: "Ellery", candidateEmail: "rowan.ellery@candidate.example", title: "Firmware Test Engineer", departmentId: "dpt_hardware", workState: "CO", baseCents: 13_200_000, startDate: "2026-11-02" })).data.offer_id;
  const sent = (await weft.post<{ data: { persona_principal_id: string; reserved_worker_id: string } }>(`/v1/offers/${offerId}/send`)).data;
  const persona = new WeftApi(request, sent.persona_principal_id);
  await persona.post("/v1/portal/offer/view");
  for (const d of (await persona.get<{ documents: { id: string; sha256: string }[] }>("/v1/portal/me")).documents) {
    await persona.post(`/v1/portal/documents/${d.id}/sign`, { typedName: NAME, documentSha256: d.sha256 });
  }
  const counter = page.getByTestId(T.portalCounter);
  const sign = async () => page.getByTestId(T.typedName).fill(NAME);

  await test.step("the portal shows 2 of 7 and the W-4", async () => {
    await page.goto(`/portal?as=${sent.persona_principal_id}`);
    await expect(counter).toHaveText("2 of 7 done");
    await page.getByTestId(T.w4Filing).selectOption("single");
    await page.getByTestId(T.w4Step4c).fill("50");
    await sign();
    await page.getByTestId(T.w4Submit).click();
    await expect(counter).toHaveText("3 of 7 done");
  });

  await test.step("the CO DR 0004", async () => {
    await expect(page.getByText(/DR 0004/).first()).toBeVisible();
    await page.getByTestId(T.stateAllowances).fill("0");
    await sign();
    await page.getByTestId(T.stateSubmit).click();
    await expect(counter).toHaveText("4 of 7 done");
  });

  await test.step("direct deposit refuses a failed ABA checksum inline, then verifies a valid routing number", async () => {
    await page.getByTestId(T.ddRouting).fill("021000022");
    await page.getByTestId(T.ddAccount).fill("4417390056");
    await sign();
    await page.getByTestId(T.ddSubmit).click();
    await expect(page.getByTestId(T.ddError)).toContainText(/ABA checksum/);
    await expect(counter).toHaveText("4 of 7 done");
    await page.getByTestId(T.ddRouting).fill("021000021");
    await page.getByTestId(T.ddSubmit).click();
    await expect(counter).toHaveText("5 of 7 done");
  });

  await test.step("the I-9 with an ID image", async () => {
    await page.getByTestId(T.i9Last4).fill("A7Q2");
    await page.getByTestId(T.i9File).setInputFiles({ name: "rowan-passport.png", mimeType: "image/png", buffer: PNG });
    await sign();
    await page.getByTestId(T.i9Submit).click();
    await expect(counter).toHaveText("6 of 7 done");
    const me = await persona.get<{ upload: { masked: boolean; fileName: string } }>("/v1/portal/me");
    expect(me.upload).toMatchObject({ masked: true, fileName: "ro***.png" });
  });

  await test.step("benefits from the seeded plans; 7 of 7 turns the worker active", async () => {
    const plans = (await persona.get<{ plans: { id: string; type: string; name: string }[] }>("/v1/portal/me")).plans;
    await page.getByTestId(`${T.benefitsPlan}-medical`).selectOption(plans.find((p) => p.name.includes("PPO"))!.id);
    await page.getByTestId(`${T.benefitsPlan}-dental`).selectOption(plans.find((p) => p.type === "dental")!.id);
    await page.getByTestId(`${T.benefitsPlan}-401k`).selectOption(plans.find((p) => p.type === "401k")!.id);
    await sign();
    await page.getByTestId(T.benefitsSubmit).click();
    await expect(counter).toHaveText("7 of 7 done");
    await expect(page.getByTestId(T.portalDone)).toBeVisible();
    const w = await eventually(() => weft.get<{ worker: { status: string } }>(`/v1/workers/${sent.reserved_worker_id}`), (x) => (x.worker.status === "active" ? x : null), "the worker is active");
    expect(w.worker.status).toBe("active");
  });

  await test.step("the next payroll draft pays the hire with no MISSING_BANK_ACCOUNT flag", async () => {
    const draft = await weft.post<{ data: { run_id: string } }>("/v1/payrolls/drafts", { payScheduleId: "ps_us_semimonthly", periodEnd: "2026-11-15" });
    const checks = await weft.all<{ workerId: string; flags: { rule: string }[]; deductions?: { code: string; amountCents?: number }[] }>(`/v1/payrolls/${draft.data.run_id}/paychecks`);
    const mine = checks.find((c) => c.workerId === sent.reserved_worker_id)!;
    expect(mine).toBeDefined();
    expect(mine.flags.map((f) => f.rule)).not.toContain("MISSING_BANK_ACCOUNT");
    expect(mine.deductions).toEqual(expect.arrayContaining([{ code: "section125_medical", pretax: true, amountCents: 9_500 }, { code: "section125_medical", pretax: true, amountCents: 800 }]));
    expect(mine.deductions!.some((d) => d.code === "401k_traditional")).toBe(true);
  });
});
