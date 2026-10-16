// GP17. Greenhouse hire to a Weft offer (docs/wave3.md 5). Owner: w3-integrations-hr. On Integrations, five cards
// read Simulated with secret names and no values; "Simulate a hire" makes the Greenhouse simulator deliver a signed
// hire_candidate; Weft creates one draft offer, the unmapped Boulder office shows as a sync item, rt_ats_hire files
// the send proposal and Dana approves it in the Inbox. A changed start date then shows as a conflict Dana resolves.
import { W3_INTEGRATIONS_HR_TID as H, W3_INTEGRATIONS_TID as T } from "../packages/contracts/src/w3/testids-integrations";
import { approveCard, eventually, expect, openApp, test, viewAs } from "./fixtures";

interface OfferRow { id: string; status: string; candidateEmail: string; workState: string; startDate: string }
interface Prop { id: string; command: string; status: string; args: { offer_id?: string } }

test("GP17: a Greenhouse hire becomes a Weft draft offer, a proposal and a resolved conflict", async ({ page, weft }) => {
  await test.step("Integrations shows five simulated cards with secret names only", async () => {
    await openApp(page, "/app/integrations");
    await viewAs(page, "dana");
    for (const v of ["greenhouse", "workday", "checkr", "hireright", "docusign"]) {
      await expect(page.getByTestId(T.card(v))).toBeVisible();
      await expect(page.getByTestId(T.mode(v))).toHaveText("Simulated");
    }
    await expect(page.getByTestId(H.secret("greenhouse", "WEFT_GREENHOUSE_CLIENT_ID"))).toBeVisible();
  });

  let offer!: OfferRow;
  await test.step("Simulate a hire: one draft offer and an unmapped office", async () => {
    await page.getByTestId(T.simulate("greenhouse", "hire")).click();
    offer = await eventually(() => weft.get<{ data: OfferRow[] }>("/v1/offers", { limit: 100 }), (p) => p.data.find((o) => o.candidateEmail === "marisol.quint@candidate.example"), "the imported offer exists");
    expect(offer).toMatchObject({ status: "draft", workState: "CO" });
    const item = page.locator(`[data-testid^="sync-item-"][data-kind="unmapped_value"][data-subject="${offer.id}"]`);
    await expect(item).toBeVisible();
    await expect(item).toContainText("Boulder Field Office");
    await expect(page.getByTestId(H.importedOffers)).toContainText("Marisol Quint (demo)");
  });

  await test.step("rt_ats_hire proposes sending the offer and Dana approves it in the Inbox", async () => {
    const send = await eventually(() => weft.get<{ data: Prop[] }>("/v1/proposals", { limit: 100 }), (p) => p.data.find((x) => x.command === "documents.send_offer" && x.args.offer_id === offer.id && x.status === "pending"), "the send proposal is filed");
    await openApp(page, `/app/inbox?proposal=${send.id}`);
    await approveCard(page, weft, send.id);
    await eventually(() => weft.get<OfferRow>(`/v1/offers/${offer.id}`), (o) => o.status === "sent", "the offer is sent");
  });

  await test.step("a changed start date in Greenhouse waits as a conflict, and keeping the Weft value closes it", async () => {
    await openApp(page, "/app/integrations");
    await page.getByTestId(T.simulate("greenhouse", "start_date_change")).click();
    const conflict = page.locator(`[data-testid^="sync-item-"][data-kind="sync_conflict"][data-subject="${offer.id}"]`);
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText("2026-11-30");
    await conflict.getByRole("button", { name: "Keep Weft value" }).click();
    await expect(conflict).toHaveCount(0);
    expect((await weft.get<OfferRow>(`/v1/offers/${offer.id}`)).startDate).toBe("2026-11-16");
  });
});
