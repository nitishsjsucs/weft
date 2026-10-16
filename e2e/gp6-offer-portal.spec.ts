// GP6. Offer to signed (docs/wave2.md). Owner: w2-onboarding. Dana builds an offer for a fictional CO candidate in
// Hiring, saves the draft and sends it; the email simulator holds the invite; the portal link signs in as the new
// hire persona (the offer reads Viewed); the new hire signs the offer and the confidentiality agreement by typing
// their name; signature rows carry signer, sim time and the document sha256; both show under Signed in the library.
import { TID, WeftApi, eventually, expect, openApp, test, viewAs } from "./fixtures";
import { W2_ONBOARDING_TID as T } from "../packages/contracts/src/w2/testids-onboarding";

const C = { first: "Rowan", last: "Ellery", email: "rowan.ellery@candidate.example", title: "Firmware Test Engineer" };
interface OfferDetail { id: string; status: string; personaPrincipalId: string | null; workerId: string | null; candidateEmail: string }

test("GP6: an offer goes from draft to signed through the new-hire portal", async ({ page, weft, request }) => {
  let offer: OfferDetail;
  await test.step("Dana drafts the offer in Hiring and sends it", async () => {
    await openApp(page, "/app/hiring");
    await viewAs(page, "dana");
    await page.getByTestId(T.offerFirst).fill(C.first);
    await page.getByTestId(T.offerLast).fill(C.last);
    await page.getByTestId(T.offerEmail).fill(C.email);
    // Typed key by key: a remounting field would keep only the first character.
    await page.getByTestId(T.offerTitle).pressSequentially(C.title);
    await expect(page.getByTestId(T.offerTitle)).toHaveValue(C.title);
    await page.getByTestId(T.offerDepartment).selectOption("dpt_hardware");
    await page.getByTestId(T.offerState).selectOption("CO");
    await page.getByTestId(T.offerBase).fill("132000");
    await page.getByTestId(T.offerStart).fill("2026-11-02");
    await page.getByTestId(T.offerSaveDraft).click();
    offer = await eventually(() => weft.get<{ data: OfferDetail[] }>("/v1/offers"), (p) => p.data.find((o) => o.candidateEmail === C.email && o.status === "draft"), "the draft is saved");
    const row = page.locator(`[data-testid="${T.offerRow}"][data-offer="${offer.id}"]`);
    await expect(row.getByTestId(T.offerStatus)).toHaveText("Draft");
    await row.getByTestId(T.offerSend).click();
    await expect(row.getByTestId(T.offerStatus)).toHaveText("Sent");
    // The Viewing as switcher now lists the new-hire persona; choosing it opens the portal.
    const sent = await eventually(() => weft.get<OfferDetail>(`/v1/offers/${offer.id}`), (o) => (o.personaPrincipalId ? o : null), "the persona exists");
    await expect(page.getByTestId(TID.viewingAs).locator(`option[value="portal:${sent.personaPrincipalId}"]`)).toHaveCount(1);
  });

  await test.step("the invite with the portal link is in the email simulator", async () => {
    const item = page.locator(`[data-testid="${T.outboxItem}"][data-ref="${offer.id}"]`);
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute("data-kind", "offer_invite");
    const mail = await weft.get<{ kind: string; body: string }[]>("/v1/sim/email", { to: C.email });
    expect(mail.map((m) => m.kind)).toEqual(["offer_invite"]);
    await item.getByRole("link", { name: /new-hire portal/i }).click();
  });

  offer = await weft.get<OfferDetail>(`/v1/offers/${offer!.id}`);
  const persona = new WeftApi(request, offer.personaPrincipalId!);
  await test.step("the portal opens as the new hire and marks the offer viewed", async () => {
    await expect(page).toHaveURL(new RegExp(`/portal\\?as=${offer.personaPrincipalId}`));
    await expect(page.getByTestId(T.portalCounter)).toHaveText("0 of 7 done");
    await eventually(() => weft.get<OfferDetail>(`/v1/offers/${offer.id}`), (o) => o.status === "viewed", "the offer reads viewed");
    await expect(page.getByTestId(T.docBody)).toContainText("DEMO DOCUMENT");
  });

  await test.step("the new hire signs the offer and the confidentiality agreement", async () => {
    await page.getByTestId(T.typedName).fill(`${C.first} ${C.last}`);
    await page.getByTestId(T.signButton).click();
    await expect(page.getByTestId(T.portalCounter)).toHaveText("1 of 7 done");
    await expect(page.getByTestId(T.docBody)).toContainText("Confidentiality");
    await page.getByTestId(T.typedName).fill(`${C.first} ${C.last}`);
    await page.getByTestId(T.signButton).click();
    await expect(page.getByTestId(T.portalCounter)).toHaveText("2 of 7 done");
  });

  await test.step("the offer reads Accepted, the worker is onboarding, and the signatures carry signer, time and hash", async () => {
    const accepted = await eventually(() => weft.get<OfferDetail>(`/v1/offers/${offer.id}`), (o) => (o.status === "accepted" && o.workerId ? o : null), "the offer is accepted");
    const worker = await weft.get<{ worker: { status: string } }>(`/v1/workers/${accepted.workerId}`);
    expect(worker.worker.status).toBe("onboarding");
    const docs = await weft.get<{ id: string; kind: string; sha256: string }[]>(`/v1/workers/${accepted.workerId}/documents`, { status: "signed" });
    expect(docs.map((d) => d.kind)).toEqual(["offer_letter", "confidentiality_agreement"]);
    const now = (await weft.get<{ now: string }>("/v1/sim/clock")).now;
    for (const d of docs) {
      const full = await weft.get<{ signature: { signerPrincipalId: string; signedAt: string; documentSha256: string; actionSeq: number } }>(`/v1/documents/${d.id}`);
      expect(full.signature).toMatchObject({ signerPrincipalId: offer.personaPrincipalId, documentSha256: d.sha256 });
      expect(full.signature.signedAt <= now).toBe(true);
    }
    expect((await page.request.get("/api/v1/workers", { headers: { "x-weft-principal": offer.personaPrincipalId! } })).status()).toBe(403);
    expect((await persona.get<{ done: number }>("/v1/portal/me")).done).toBe(2);
  });

  await test.step("both documents show under Signed in the person's library", async () => {
    const accepted = await weft.get<OfferDetail>(`/v1/offers/${offer.id}`);
    await openApp(page, `/app/people/${accepted.workerId}`);
    await viewAs(page, "dana");
    await page.getByRole("tab", { name: /^documents$/i }).click();
    const lib = page.getByTestId(T.docLibrary);
    await expect(lib.getByTestId(`${T.docTab}-signed`)).toBeVisible();
    await expect(lib.locator(`[data-testid="${T.docRow}"][data-status="signed"]`)).toHaveCount(2);
  });
});
