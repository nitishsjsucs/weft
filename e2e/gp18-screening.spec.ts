// GP18. Background check after acceptance (docs/wave3.md 5). Owner: w3-integrations-screening-esign. An offer is
// accepted through the portal; Dana orders the check from Hiring (Simulated badge, price from the catalog); the new
// hire authorizes it on the labeled simulated apply page in the portal; one business day later on the sim clock the
// signed webhook completes it and Hiring reads Clear. Runs on WEFT_E2E_WEB_PORT 4670 and WEFT_E2E_API_PORT 4671.
import { WeftApi, eventually, expect, openApp, test, viewAs } from "./fixtures";

const C = { candidateFirst: "Rowan", candidateLast: "Ellery", candidateEmail: "rowan.ellery@candidate.example", title: "Firmware Test Engineer", departmentId: "dpt_hardware", workState: "CO", baseCents: 13_200_000, payKind: "salary", startDate: "2026-11-02" };
interface OfferDetail { id: string; status: string; personaPrincipalId: string | null; candidateEmail: string }
interface Order { id: string; status: string; result: string | null; priceCents: number; mode: string }

test("GP18: a background check is ordered after acceptance, authorized in the portal and completes clear", async ({ page, weft, request }) => {
  let offer: OfferDetail;
  await test.step("an offer is sent and accepted through the portal", async () => {
    const draft = await weft.post<{ data: { offer_id: string } }>("/v1/offers", C);
    await weft.post(`/v1/offers/${draft.data.offer_id}/send`);
    offer = await weft.get<OfferDetail>(`/v1/offers/${draft.data.offer_id}`);
    const persona = new WeftApi(request, offer.personaPrincipalId!);
    await persona.post("/v1/portal/offer/view");
    const me = await persona.get<{ documents: { id: string; kind: string; sha256: string }[] }>("/v1/portal/me");
    const letter = me.documents.find((d) => d.kind === "offer_letter")!;
    await persona.post(`/v1/portal/documents/${letter.id}/sign`, { typedName: "Rowan Ellery", documentSha256: letter.sha256 });
    await eventually(() => weft.get<OfferDetail>(`/v1/offers/${offer.id}`), (o) => o.status === "accepted", "the offer is accepted");
  });

  await test.step("Dana orders the background check in Hiring", async () => {
    await openApp(page, "/app/hiring");
    await viewAs(page, "dana");
    const row = page.locator(`[data-testid="offer-row"][data-offer="${offer.id}"]`);
    await row.getByTestId("offer-screening-order").click();
    await expect(row.getByTestId("offer-screening-status")).toHaveText("Invited");
    const orders = await weft.get<{ data: Order[] }>("/v1/screening/orders", { offerId: offer.id });
    expect(orders.data).toEqual([expect.objectContaining({ status: "invited", priceCents: 3_500, mode: "simulated" })]);
  });

  await test.step("the new hire authorizes it on the simulated apply page", async () => {
    await page.goto(`/portal?as=${offer.personaPrincipalId}`);
    const apply = page.getByTestId("screening-apply-page");
    await expect(apply).toContainText("Screening company apply page (simulated)");
    await apply.getByTestId("screening-apply-next").click();
    await apply.getByTestId("screening-apply-next").click();
    await apply.getByTestId("screening-apply-name").fill("Rowan Ellery");
    await apply.getByTestId("screening-apply-sign").click();
    await expect(page.getByTestId("portal-screening-status")).toHaveText("In progress");
  });

  await test.step("one business day later the signed webhook completes the check clear", async () => {
    await weft.advanceClock({ to: "2026-10-27T15:30:00.000Z" });
    await eventually(() => weft.get<{ data: Order[] }>("/v1/screening/orders", { offerId: offer.id }), (p) => p.data[0]?.status === "complete_clear", "the check is clear");
    await openApp(page, "/app/hiring");
    const row = page.locator(`[data-testid="offer-row"][data-offer="${offer.id}"]`);
    await expect(row.getByTestId("offer-screening-status")).toHaveText("Clear");
  });
});
