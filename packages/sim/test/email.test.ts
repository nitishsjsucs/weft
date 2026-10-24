// Email simulator (w2-onboarding): an outbox of *.example mail in id order, filtered by recipient, with the
// email.send fault target and the subject and body limits.
import { afterEach, describe, expect, it } from "vitest";
import { createSimulators } from "../src/index";
import { MAX_EMAIL_BODY } from "../src/email";
import { simWorld, type SimTestWorld } from "./helpers";

let w: SimTestWorld | null = null;
afterEach(async () => { await w?.close(); w = null; });
const msg = (to: string, body = "Open the portal.") => ({ to, from: "people@larkspur.example", subject: "Your offer", body, kind: "offer_invite" as const, relatedRef: "offr_0002" });

describe("email simulator", () => {
  it("keeps sent mail in order, filters by recipient and stamps the sim time", async () => {
    w = await simWorld();
    const sims = createSimulators({ db: w.db, clock: w.clock });
    await sims.email.send(msg("a@candidate.example"));
    await sims.email.send(msg("b@candidate.example"));
    expect((await sims.email.list()).map((m) => m.to)).toEqual(["a@candidate.example", "b@candidate.example"]);
    expect(await sims.email.list("b@candidate.example")).toEqual([expect.objectContaining({ id: "eml_0002", ts: w.clock.now(), kind: "offer_invite", relatedRef: "offr_0002" })]);
  });

  it("refuses an oversized body and fails at the email.send fault target", async () => {
    w = await simWorld();
    const sims = createSimulators({ db: w.db, clock: w.clock });
    await expect(sims.email.send(msg("a@candidate.example", "x".repeat(MAX_EMAIL_BODY + 1)))).rejects.toThrow(/20000/);
    await sims.faults.arm({ target: "email.send", kind: "error", mode: "once" });
    await expect(sims.email.send(msg("a@candidate.example"))).rejects.toThrow(/email.send/);
    expect((await sims.email.send(msg("a@candidate.example"))).id).toMatch(/^eml_/);
  });
});
