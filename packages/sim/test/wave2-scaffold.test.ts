import { afterEach, describe, expect, it } from "vitest";
import { abaChecksumOk, DirectDepositSubmission, OFFER_TRANSITIONS } from "@weft/contracts";
import { createSimulators } from "../src/index";
import { simWorld, type SimTestWorld } from "./helpers";

let w: SimTestWorld | null = null;
afterEach(async () => { await w?.close(); w = null; });

describe("wave 2 scaffold", () => {
  it("the email simulator keeps an outbox of *.example mail and refuses other domains", async () => {
    w = await simWorld();
    const sims = createSimulators({ db: w.db, clock: w.clock });
    const { id } = await sims.email.send({ to: "ava.reyes@personal.example", from: "people@larkspur.example", subject: "Your offer from Larkspur", body: "Open the portal to review it.", kind: "offer_invite", relatedRef: "offr_0001" });
    expect(id).toMatch(/^eml_\d{4}$/);
    const inbox = await sims.email.list("ava.reyes@personal.example");
    expect(inbox.map((m) => [m.subject, m.kind, m.relatedRef])).toEqual([["Your offer from Larkspur", "offer_invite", "offr_0001"]]);
    await expect(sims.email.send({ to: "someone@gmail.com", from: "people@larkspur.example", subject: "x", body: "x", kind: "generic", relatedRef: null })).rejects.toThrow(/example/);
  });
  it("routing numbers pass the ABA checksum and offers follow the lifecycle", () => {
    expect(abaChecksumOk("011000015")).toBe(true);
    expect(abaChecksumOk("011000016")).toBe(false);
    expect(DirectDepositSubmission.safeParse({ bankName: "Demo Bank", routing: "123456789", account: "000123456", accountType: "checking", typedName: "Ava Reyes" }).success).toBe(false);
    expect(OFFER_TRANSITIONS.viewed).toContain("accepted");
    expect(OFFER_TRANSITIONS.accepted).toEqual([]);
  });
});
