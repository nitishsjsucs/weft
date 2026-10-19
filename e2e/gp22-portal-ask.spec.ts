// GP22. Portal questions (docs/wave4.md, T9). Owner: w4-parity-agent. A signed new hire asks the portal question box
// about company policy and gets the policy answer; asks about a coworker's pay and is told the agent sees only their
// own record; asks about medical leave and is handed to a person on the HR team with no model run. A second test drives
// the Simulators panel's inbound controls: a message that tags @weft gets one read-only answer in its channel, and an
// emailed receipt from a work address on file becomes one submitted expense while an unknown sender bounces.
import { WeftApi, eventually, expect, openApp, test } from "./fixtures";
import { W4_ASK_TID as A } from "../packages/contracts/src/ext/w4-parity-agent";

const C = { first: "Tamsin", last: "Quarry", email: "tamsin.quarry@candidate.example" };

test("GP22: the portal question box answers from the asker's own record and hands sensitive topics to a person", async ({ page, weft, request }) => {
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

test("GP22: a chat mention gets one read-only answer and an emailed receipt files one expense", async ({ page, weft }) => {
  await openApp(page, "/app/simulators");

  await test.step("tagging @weft in #payroll gets one answer in the channel and changes nothing", async () => {
    const proposalsBefore = (await weft.proposals()).length;
    const chat = page.getByTestId("sim-inbound-chat");
    await chat.getByLabel("Post as").selectOption("usr_dana");
    await chat.getByTestId("sim-inbound-chat-text").fill("@weft what is the status of the draft payroll?");
    await chat.getByTestId("sim-inbound-chat-send").click();
    await expect(page.getByText("Posted in #payroll. The agent is answering in the thread (read only).")).toBeVisible();
    const reply = await eventually(() => weft.chat("#payroll"), (ms) => ms.find((m) => m.author === "Weft agent"), "the agent's reply in #payroll");
    // The thread reads the run and its payday as days, never as the row id or the ISO date.
    expect(reply.text).toMatch(/payroll for Oct 30 pays on Oct 30/);
    expect(reply.text).not.toMatch(/pay_\d|\d{4}-\d{2}-\d{2}/);
    expect(reply.inbound).toBe(false);
    await expect(chat.getByTestId("sim-mentions")).toContainText("Answered");
    expect((await weft.chat("#payroll")).filter((m) => m.author === "Weft agent").length).toBe(1);
    // Read only: the mention itself is recorded by the system, and the run behind the answer wrote and proposed nothing.
    const [mention] = await weft.get<{ status: string; runId: string | null }[]>("/v1/agent/mentions");
    expect(mention).toMatchObject({ status: "answered", runId: expect.any(String) });
    expect((await weft.actions()).filter((a) => a.agentRunId === mention!.runId)).toEqual([]);
    expect((await weft.proposals()).length).toBe(proposalsBefore);
  });

  await test.step("a receipt emailed from a work address on file becomes one submitted expense", async () => {
    const [worker] = (await weft.workers({ status: "active" })).filter((w) => w.type === "employee");
    const mail = page.getByTestId("sim-inbound-email");
    await mail.getByTestId("sim-inbound-email-from").fill(worker!.workEmail);
    await mail.getByTestId("sim-inbound-email-send").click();
    await expect(page.getByText(/Filed an expense claim from the email/)).toBeVisible();
    const intake = await weft.get<{ status: string; expenseId: string | null; fromAddress: string }[]>("/v1/expense-intake");
    const created = intake.filter((x) => x.status === "created");
    expect(created.length).toBe(1);
    expect(created[0]!.fromAddress.toLowerCase()).toBe(worker!.workEmail.toLowerCase());
    const expense = await weft.get<{ source?: string; status: string; amountCents: number }>(`/v1/expenses/${created[0]!.expenseId}`);
    expect(expense).toMatchObject({ amountCents: 6420 });
    await expect(mail.getByTestId("sim-intake")).toContainText("Created");
  });

  await test.step("the same receipt from an unknown sender bounces and files nothing", async () => {
    const mail = page.getByTestId("sim-inbound-email");
    await mail.getByTestId("sim-inbound-email-from").fill("someone@elsewhere.example");
    await mail.getByTestId("sim-inbound-email-send").click();
    await expect(page.getByText("The email was not filed: bounced unknown sender.")).toBeVisible();
    await expect(mail.getByTestId("sim-intake")).toContainText("Bounced unknown sender");
    const intake = await weft.get<{ status: string }[]>("/v1/expense-intake");
    expect(intake.filter((x) => x.status === "created").length).toBe(1);
    expect(intake.filter((x) => x.status === "bounced_unknown_sender").length).toBe(1);
  });
});
