// DocuSign simulator (w3-integrations-screening-esign): Connect HMAC vector (base64 over the raw bytes), the JSON SIM
// parser and dedupe key, one envelope per offer, embedded signing link rules, completion, decline and void.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFaults } from "../../src/faults";
import { createDocuSignSim, docusignDedupeKey, DOCUSIGN_SIM_HMAC_KEY } from "../../src/vendors/docusign";
import { w3EsignSimControls } from "../../../contracts/src/ext/w3-integrations-screening-esign";
import { simWorld, type SimTestWorld } from "../helpers";

const VECTOR_BODY = '{"event":"envelope-completed","apiVersion":"v2.1","generatedDateTime":"2026-10-27T15:30:00.000Z","data":{"accountId":"sim-account-0001","envelopeId":"sim-env-000001"}}';
const VECTOR_B64 = "mJrSEMlywVvSNoALGrJ0EgWk8r81rHCZGwmDUPfbda0=";   // printf body | openssl dgst -sha256 -hmac key -binary | base64
const enc = (s: string) => new TextEncoder().encode(s);
const DOCS = [{ weftDocId: "doc_0001", title: "Offer letter", bytes: enc("Offer letter text (demo)"), sha256: "a".repeat(64) }, { weftDocId: "doc_0002", title: "Confidentiality agreement", bytes: enc("NDA text (demo)"), sha256: "b".repeat(64) }];
const SIGNER = { name: "Rowan Ellery (demo)", email: "rowan.ellery@candidate.example", clientUserId: "usr_0010" };

let w: SimTestWorld;
beforeEach(async () => { w = await simWorld(); });
afterEach(async () => { await w.close(); });
const sim = () => createDocuSignSim(w.db, w.clock, createFaults(w.db));

describe("DocuSign simulator Connect signatures", () => {
  it("verifies the base64 vector on raw bytes with any X-DocuSign-Signature-N header and rejects re-serialized bodies", () => {
    const s = sim();
    expect(DOCUSIGN_SIM_HMAC_KEY).toBe("weft-sim-docusign-connect-key-not-a-secret");
    const key = docusignDedupeKey("sim-env-000001", "envelope-completed", "2026-10-27T15:30:00.000Z");
    expect(s.verifyWebhook(enc(VECTOR_BODY), { "X-DocuSign-Signature-1": VECTOR_B64 })).toEqual({ ok: true, dedupeKey: key });
    expect(s.verifyWebhook(enc(VECTOR_BODY), { "X-DocuSign-Signature-1": "bm9wZQ==", "X-DocuSign-Signature-2": VECTOR_B64 }).ok).toBe(true);
    expect(s.verifyWebhook(enc(JSON.stringify(JSON.parse(VECTOR_BODY), null, 2)), { "X-DocuSign-Signature-1": VECTOR_B64 }).ok).toBe(false);
    expect(s.verifyWebhook(enc(`${VECTOR_BODY}\r\n`), { "X-DocuSign-Signature-1": VECTOR_B64 }).ok).toBe(false);
    expect(s.verifyWebhook(enc(VECTOR_BODY), { "X-Other": VECTOR_B64 }).ok).toBe(false);
    expect(s.parseWebhook(enc(VECTOR_BODY))).toEqual([{ dedupeKey: key, envelopeId: "sim-env-000001", event: "envelope-completed" }]);
    expect(s.parseWebhook(enc("not json"))).toEqual([]);
  });
});

describe("DocuSign simulator envelopes", () => {
  it("sends one envelope with both documents, delivers on the signing link, completes, and records each status read", async () => {
    const s = sim(), c = w3EsignSimControls(s)!;
    const e = await s.send({ offerId: "offr_0002", documents: DOCS, signer: SIGNER, expiresOn: "2026-11-09" });
    expect(e).toEqual({ envelopeId: "sim-env-000001", status: "sent" });
    await expect(s.signingUrl(e.envelopeId, { ...SIGNER, clientUserId: "usr_9999" }, "/portal")).rejects.toThrow(/unknown embedded recipient/);
    const link = await s.signingUrl(e.envelopeId, SIGNER, "/portal?esign_return=1");
    expect(link.expiresAt).toBe(new Date(Date.parse(w.clock.now()) + 300_000).toISOString());
    expect((await s.envelope(e.envelopeId)).status).toBe("delivered");
    await expect(s.download(e.envelopeId, "combined")).rejects.toThrow(/not completed/);
    await c.finish(e.envelopeId, "signed");
    expect(await s.envelope(e.envelopeId)).toEqual({ status: "completed", recipients: [{ clientUserId: "usr_0010", status: "completed" }] });
    expect(new TextDecoder().decode(await s.download(e.envelopeId, "combined"))).toContain("NDA text (demo)");
    expect(await c.reads(e.envelopeId)).toHaveLength(2);
    const events = (await c.outbox(w.clock.now())).map((d) => JSON.parse(d.raw).event);
    expect(events).toEqual(["envelope-sent", "envelope-delivered", "envelope-completed"]);
    for (const d of await c.outbox(w.clock.now())) expect(s.verifyWebhook(enc(d.raw), d.headers)).toEqual({ ok: true, dedupeKey: d.dedupeKey });
    await expect(s.void(e.envelopeId, "x")).rejects.toThrow(/completed/);
  });
  it("declines, voids with the reason cut to 200 characters, and the esign.send fault fails the send", async () => {
    const faults = createFaults(w.db);
    const s = createDocuSignSim(w.db, w.clock, faults), c = w3EsignSimControls(s)!;
    const a = await s.send({ offerId: "offr_0002", documents: DOCS, signer: SIGNER, expiresOn: null });
    await c.finish(a.envelopeId, "declined");
    expect((await s.envelope(a.envelopeId)).status).toBe("declined");
    const b = await s.send({ offerId: "offr_0003", documents: DOCS, signer: SIGNER, expiresOn: null });
    await s.void(b.envelopeId, "x".repeat(300));
    expect((await s.envelope(b.envelopeId)).status).toBe("voided");
    await faults.arm({ target: "esign.send", kind: "error", mode: "once" });
    await expect(s.send({ offerId: "offr_0004", documents: DOCS, signer: SIGNER, expiresOn: null })).rejects.toThrow(/esign.send/);
  });
});
