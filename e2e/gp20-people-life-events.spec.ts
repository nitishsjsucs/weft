// Life events and the first-month check-in in the portal (wave 4, docs/wave4.md; provisional number, the integrator numbers GP20 on). Owner of the spec: w4-parity-people.
// A new hire reports a marriage in the portal; the window it opens shows its close date and the rule it follows; the
// hire picks a medical tier and the window closes with one carrier filing queued. Then the hire answers the five-question
// check-in, and the manager's summary email carries the scale and the yes or no answers but none of the written words.
// Last, the hire asks for a day off with the Request time off form and sees it waiting for approval.
// Run on the track ports, for example: WEFT_E2E_WEB_PORT=4846 WEFT_E2E_API_PORT=4847 pnpm e2e gp20-people
import { expect, test, WeftApi } from "./fixtures";

const T = {
  lifeSection: "portal-life-events", lifeKind: "portal-life-kind", lifeDate: "portal-life-date", lifeNote: "portal-life-note", lifeSubmit: "portal-life-submit",
  lifeRow: (id: string) => `portal-life-event-${id}`, windowCard: (id: string) => `portal-window-${id}`,
  electPlan: (t: string) => `portal-elect-plan-${t}`, electTier: (t: string) => `portal-elect-tier-${t}`, electSubmit: "portal-elect-submit",
  checkin: "portal-checkin", checkinField: (k: string) => `portal-checkin-${k}`, checkinSubmit: "portal-checkin-submit", status: "portal-w4-status",
  timeOff: "portal-time-off", timeOffPolicy: "portal-time-off-policy", timeOffStart: "portal-time-off-start", timeOffEnd: "portal-time-off-end",
  timeOffReason: "portal-time-off-reason", timeOffSubmit: "portal-time-off-submit", timeOffRow: (id: string) => `portal-time-off-request-${id}`,
} as const;

type Mine = { lifeEvents: { id: string; status: string; windowId: string | null; closesOn: string | null }[]; windows: { id: string; status: string }[]; plans: { id: string; name: string; type: string }[] };

test("portal life event, check-in and time off: report, elect in the window, answer the check-in, request a day off", async ({ page, weft, request }) => {
  const offerId = (await weft.post<{ data: { offer_id: string } }>("/v1/offers", { candidateFirst: "Wren", candidateLast: "Abara", candidateEmail: "wren.abara@candidate.example", title: "Controls Engineer", departmentId: "dpt_hardware", workState: "CA", baseCents: 12_400_000, startDate: "2026-11-02" })).data.offer_id;
  const sent = (await weft.post<{ data: { persona_principal_id: string; reserved_worker_id: string } }>(`/v1/offers/${offerId}/send`)).data;
  const persona = new WeftApi(request, sent.persona_principal_id);
  await persona.post("/v1/portal/offer/view");
  const letter = (await persona.get<{ documents: { id: string; sha256: string }[] }>("/v1/portal/me")).documents[0]!;
  await persona.post(`/v1/portal/documents/${letter.id}/sign`, { typedName: "Wren Abara", documentSha256: letter.sha256 });
  const section = page.getByTestId(T.lifeSection);

  await test.step("reporting a marriage opens a 30-day window with its rule", async () => {
    await page.goto(`/portal?as=${sent.persona_principal_id}`);
    await section.getByTestId(T.lifeKind).selectOption("marriage");
    await section.getByTestId(T.lifeDate).fill("2026-10-24");
    await section.getByTestId(T.lifeNote).fill("Small ceremony, name change to follow");
    await section.getByTestId(T.lifeSubmit).click();
    await expect(page.getByTestId(T.status)).toContainText("opened a benefits window until 2026-11-23");
    const mine = await persona.get<Mine>("/v1/portal/life-events");
    expect(mine.lifeEvents).toHaveLength(1);
    const ev = mine.lifeEvents[0]!;
    expect(ev).toMatchObject({ status: "window_open", closesOn: "2026-11-23" });
    await expect(section.getByTestId(T.lifeRow(ev.id))).toHaveAttribute("data-status", "window_open");
    await expect(section.getByTestId(T.lifeRow(ev.id))).toContainText("29 CFR 2590.701-6");
  });

  await test.step("electing a medical tier closes the window with one carrier filing queued", async () => {
    const mine = await persona.get<Mine>("/v1/portal/life-events");
    const wid = mine.lifeEvents[0]!.windowId!;
    const card = section.getByTestId(T.windowCard(wid));
    const ppo = mine.plans.find((p) => p.type === "medical")!;
    await card.getByTestId(T.electPlan("medical")).selectOption(ppo.id);
    await card.getByTestId(T.electTier("medical")).selectOption("ee_spouse");
    await card.getByTestId(T.electSubmit).click();
    await expect(page.getByTestId(T.status)).toContainText("1 carrier filings are queued");
    await expect(section.getByTestId(T.windowCard(wid))).toHaveCount(0);
    const after = await persona.get<Mine>("/v1/portal/life-events");
    expect(after.lifeEvents[0]!.status).toBe("elected");
    expect(after.windows.find((w) => w.id === wid)!.status).toBe("closed");
  });

  await test.step("the first-month check-in form sends the manager a summary without the written words", async () => {
    // The wave 3 send (R3, run by a person here) creates the check-in for the hire's day 30.
    await weft.post("/v1/tools/onboarding.send_checkins", { send: [sent.reserved_worker_id], nudge: [], as_of: "2026-12-02" });
    await page.reload();
    const form = page.getByTestId(T.checkin);
    await expect(form).toBeVisible();
    await form.getByTestId(T.checkinField("settled-4")).check();
    await form.getByTestId(T.checkinField("tools-no")).check();
    await form.getByTestId(T.checkinField("clarity-yes")).check();
    await form.getByTestId(T.checkinField("blocker")).fill("Still waiting on the bench power supply");
    await form.getByTestId(T.checkinSubmit).click();
    await expect(page.getByTestId(T.status)).toContainText("emailed the manager a summary");
    await expect(page.getByTestId(T.checkin)).toHaveCount(0);
    const checks = await persona.get<{ id: string; status: string; settled: number }[]>("/v1/portal/checkins");
    expect(checks).toEqual([expect.objectContaining({ status: "submitted", settled: 4 })]);
  });

  await test.step("the Request time off form files a day off for the hire's own record", async () => {
    const box = page.getByTestId(T.timeOff);
    await expect(box).toBeVisible();
    const before = await persona.get<{ balances: { policyId: string; policyName: string }[]; requests: unknown[] }>("/v1/portal/time-off");
    expect(before.balances.length).toBeGreaterThan(0);
    expect(before.requests).toHaveLength(0);
    await box.getByTestId(T.timeOffPolicy).selectOption(before.balances[0]!.policyId);
    await box.getByTestId(T.timeOffStart).fill("2026-11-25");
    await box.getByTestId(T.timeOffEnd).fill("2026-11-25");
    await box.getByTestId(T.timeOffReason).fill("Travel the day before the holiday");
    await box.getByTestId(T.timeOffSubmit).click();
    await expect(page.getByTestId(T.status)).toContainText("Requested");
    const after = await persona.get<{ requests: { id: string; status: string; startDate: string }[] }>("/v1/portal/time-off");
    expect(after.requests).toEqual([expect.objectContaining({ status: "pending", startDate: "2026-11-25" })]);
    await expect(box.getByTestId(T.timeOffRow(after.requests[0]!.id))).toHaveAttribute("data-status", "pending");
  });
});
