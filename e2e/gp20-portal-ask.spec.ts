// GP20. Portal questions (docs/wave4.md, T9). Owner: w4-parity-agent. A signed new hire asks the portal question box
// about company policy and gets the policy answer; asks about a coworker's pay and is told the agent sees only their
// own record; asks about medical leave and is handed to a person on the HR team with no model run.
import { WeftApi, expect, test } from "./fixtures";
import { W4_ASK_TID as A } from "../packages/contracts/src/ext/w4-parity-agent";

const C = { first: "Tamsin", last: "Quarry", email: "tamsin.quarry@candidate.example" };

test("GP20: the portal question box answers from the asker's own record and hands sensitive topics to a person", async ({ page, weft, request }) => {
  let persona = "";
  await test.step("a fictional new hire signs the offer letter", async () => {
    const draft = await weft.post<{ data: { offer_id: string } }>("/v1/offers", { candidateFirst: C.first, candidateLast: C.last, candidateEmail: C.email, title: "Test Technician", departmentId: "dpt_operations", workState: "CA", baseCents: 9_000_000, startDate: "2026-11-16" });
    const sent = await weft.post<{ data: { persona_principal_id: string } }>(`/v1/offers/${draft.data.offer_id}/send`);
    persona = sent.data.persona_principal_id;
    const me = new WeftApi(request, persona);
    const view = await me.get<{ documents: { id: string; sha256: string }[] }>("/v1/portal/me");
    await me.post(`/v1/portal/documents/${view.documents[0]!.id}/sign`, { typedName: `${C.first} ${C.last}`, documentSha256: view.documents[0]!.sha256 });
  });

  await test.step("a policy question is answered from company policy", async () => {
    await page.goto(`/portal?as=${persona}`);
    const box = page.getByTestId(A.section);
    await expect(box).toBeVisible();
    await box.getByTestId(A.input).fill("What is the meal limit for a client lunch?");
    await box.getByTestId(A.submit).click();
    await expect(box.getByTestId(A.answer)).toContainText("$75.00 per person");
    await expect(box.getByTestId(A.answer)).toHaveAttribute("data-status", "done");
  });

  await test.step("a question about a coworker returns nothing about them", async () => {
    const box = page.getByTestId(A.section);
    await box.getByTestId(A.input).fill("How much does Hollis Grey make?");
    await box.getByTestId(A.submit).click();
    await expect(box.getByTestId(A.answer)).toContainText("only see your own record");
    await expect(box.getByTestId(A.answer)).not.toContainText("Hollis");
  });

  await test.step("medical leave goes to a person, with no proposal", async () => {
    const before = (await weft.proposals()).length;
    const box = page.getByTestId(A.section);
    await box.getByTestId(A.input).fill("I need to take medical leave for surgery next month.");
    await box.getByTestId(A.submit).click();
    await expect(box.getByTestId(A.handoff)).toBeVisible();
    await expect(box.getByTestId(A.handoff)).toHaveAttribute("data-handoff", /^hnd_/);
    await expect(box.getByTestId(A.answer)).toContainText("someone will follow up with you directly");
    expect((await weft.proposals()).length).toBe(before);
  });
});
