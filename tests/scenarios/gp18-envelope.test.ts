// Scenario GP18, envelope half (docs/wave3.md 5). Owner: w3-integrations-screening-esign. With WEFT_ESIGN=docusign and
// the DocuSign simulator, an offer goes out as one envelope with both documents; completion accepts the offer once with
// provider evidence; a decline ends the offer declined; status reads per envelope are never under 20 minutes apart; the
// built-in signature is refused for an enveloped offer. The built-in path (GP6, GP7) is covered by its own scenarios.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { handlers } from "@weft/core";
import { createScheduler } from "@weft/api";
import type { RoutinesEngine } from "@weft/contracts";
import { w3EsignSimControls } from "../../packages/contracts/src/ext/w3-integrations-screening-esign";
import { createTestWeft, type TestWeft } from "./helpers";

const CANDIDATE = { candidateFirst: "Rowan", candidateLast: "Ellery", candidateEmail: "rowan.ellery@candidate.example", title: "Firmware Test Engineer", departmentId: "dpt_hardware", workState: "CO", baseCents: 13_200_000, payKind: "salary", startDate: "2026-11-16" };

describe("GP18 offer as one e-signature envelope (WEFT_ESIGN=docusign, simulated)", () => {
  let weft: TestWeft;
  const prior = process.env.WEFT_ESIGN;
  beforeAll(async () => { process.env.WEFT_ESIGN = "docusign"; weft = await createTestWeft(); });
  afterAll(async () => { await weft.close(); if (prior === undefined) delete process.env.WEFT_ESIGN; else process.env.WEFT_ESIGN = prior; });
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const noRoutines = { tick: async () => undefined, trigger: async () => ({ routineRunId: "rtr_none" }), onProposalDecided: async () => undefined } as RoutinesEngine;
  const tickAt = async (iso: string) => {
    await weft.clock.advance(iso);
    const s = createScheduler({ db: weft.db, clock: weft.clock, sims: weft.sims, executor: weft.executor, handlers, routines: noRoutines, log: () => undefined });
    await s.tick();
    await s.stop();
  };
  const ctl = () => w3EsignSimControls(weft.sims.vendors.docusign)!;
  const send = async (first: string, email: string) => {
    const offerId = (await call("usr_dana", "POST", "/v1/offers", { ...CANDIDATE, candidateFirst: first, candidateEmail: email })).json.data.offer_id as string;
    const sent = (await call("usr_dana", "POST", `/v1/offers/${offerId}/send`)).json.data;
    return { offerId, persona: sent.persona_principal_id as string, workerId: sent.reserved_worker_id as string, envelopeRef: sent.envelope_id as string };
  };

  let a: Awaited<ReturnType<typeof send>>;
  it("sends one envelope per offer with both documents and the persona as the embedded signer", async () => {
    a = await send("Rowan", "rowan.ellery@candidate.example");
    expect(a.envelopeRef).toMatch(/^env_\d{4}$/);
    const env = (await call("usr_dana", "GET", `/v1/offers/${a.offerId}/envelope`)).json;
    expect(env).toMatchObject({ provider: "docusign", mode: "simulated", status: "sent", envelopeId: expect.stringMatching(/^sim-env-/) });
    const [rec] = await weft.db.all<{ body_json: string }>(sql`SELECT body_json FROM sim_vendor_records WHERE vendor = 'docusign' AND ext_id = ${env.envelopeId}`);
    const body = JSON.parse(rec!.body_json);
    expect(body.documents.map((d: { name: string }) => d.name)).toEqual(["Offer letter: Firmware Test Engineer", "Confidentiality and invention assignment agreement"]);
    expect(body.recipients.signers).toEqual([expect.objectContaining({ clientUserId: a.persona, email: "rowan.ellery@candidate.example" })]);
    // The built-in signature is refused: acceptance comes only from the completed envelope.
    await call(a.persona, "POST", "/v1/portal/offer/view");
    const letter = (await call(a.persona, "GET", "/v1/portal/me")).json.documents.find((d: { kind: string }) => d.kind === "offer_letter");
    const builtin = await call(a.persona, "POST", `/v1/portal/documents/${letter.id}/sign`, { typedName: "Rowan Ellery", documentSha256: letter.sha256 });
    expect(builtin.json.code).toBe("DOMAIN_ESIGN_ENVELOPE");
  });

  it("embedded signing: a fresh link per click; completion accepts the offer once with provider evidence", async () => {
    const link = (await call(a.persona, "POST", "/v1/portal/esign/url", {})).json;
    expect(link.url).toContain("esign=");
    expect(Date.parse(link.expiresAt) - Date.parse(weft.clock.now())).toBe(300_000);
    const env = (await call("usr_dana", "GET", `/v1/offers/${a.offerId}/envelope`)).json;
    // A forged return redirect proves nothing: until the envelope itself is completed, the offer stays open.
    await tickAt("2026-10-26T15:35:00.000Z");
    expect((await call("usr_dana", "GET", `/v1/offers/${a.offerId}`)).json.status).toBe("viewed");
    await ctl().finish(env.envelopeId, "signed");
    await tickAt("2026-10-26T15:40:00.000Z");
    expect((await call("usr_dana", "GET", `/v1/offers/${a.offerId}`)).json).toMatchObject({ status: "accepted", workerId: a.workerId });
    expect((await call("usr_dana", "GET", `/v1/offers/${a.offerId}/envelope`)).json).toMatchObject({ status: "completed", completedAt: "2026-10-26T15:40:00.000Z" });
    const sigs = await weft.db.all<{ provider: string; envelope_id: string; signer_principal_id: string }>(sql`SELECT e.provider, e.envelope_id, s.signer_principal_id FROM signatures s JOIN signature_evidence e ON e.signature_id = s.id`);
    expect(sigs).toEqual([{ provider: "docusign", envelope_id: env.envelopeId, signer_principal_id: a.persona }, { provider: "docusign", envelope_id: env.envelopeId, signer_principal_id: a.persona }]);
    const tasks = await weft.db.all<{ kind: string; status: string }>(sql`SELECT kind, status FROM onboarding_tasks WHERE worker_id = ${a.workerId} AND kind IN ('sign_offer', 'sign_confidentiality') ORDER BY kind`);
    expect(tasks).toEqual([{ kind: "sign_confidentiality", status: "done" }, { kind: "sign_offer", status: "done" }]);
    // Idempotent: applying the completed envelope again changes nothing.
    const again = await weft.executor.system.exec("svc_events", "documents.apply_esign_event", { envelope_id: env.envelopeId }, { eventId: null, attended: false, requestedBy: null });
    expect(again).toMatchObject({ ok: true, data: { status: "completed", previous_status: "completed", offer_status: "accepted" } });
    expect((await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM events WHERE type = 'offer.accepted' AND subject_ref = ${a.offerId}`))[0]!.n).toBe(1);
    expect((await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM signatures`))[0]!.n).toBe(2);
    const dl = await weft.db.all<{ action: string; verified: number }>(sql`SELECT action, verified FROM integration_deliveries WHERE vendor = 'docusign' ORDER BY id`);
    expect(dl.map((x) => x.action)).toEqual(["envelope-sent", "envelope-delivered", "envelope-completed"]);
  });

  it("a declined envelope ends the offer in the declined state and closes the portal", async () => {
    const b = await send("Juno", "juno.ellery@candidate.example");
    const env = (await call("usr_dana", "GET", `/v1/offers/${b.offerId}/envelope`)).json;
    await ctl().finish(env.envelopeId, "declined");
    await tickAt("2026-10-26T15:45:00.000Z");
    expect((await call("usr_dana", "GET", `/v1/offers/${b.offerId}`)).json.status).toBe("declined");
    expect((await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM events WHERE type = 'offer.declined' AND subject_ref = ${b.offerId}`))[0]!.n).toBe(1);
    expect((await call(b.persona, "POST", "/v1/portal/esign/url", {})).status).toBe(404);   // no open envelope
  });

  it("voiding an enveloped offer voids the envelope, and status reads per envelope are never under 20 minutes apart", async () => {
    const c = await send("Ash", "ash.ellery@candidate.example");
    const env = (await call("usr_dana", "GET", `/v1/offers/${c.offerId}/envelope`)).json;
    const start = Date.parse(weft.clock.now());
    for (let m = 5; m <= 120; m += 5) await tickAt(new Date(start + m * 60_000).toISOString());
    const reads = (await ctl().reads(env.envelopeId)).map((t) => Date.parse(t));
    expect(reads.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < reads.length; i++) expect(reads[i]! - reads[i - 1]!, `read ${i}`).toBeGreaterThanOrEqual(20 * 60_000);
    const v = await call("usr_dana", "POST", `/v1/offers/${c.offerId}/void`);
    expect(v.json.data).toMatchObject({ status: "voided", voided_envelope_id: env.id });
    expect((await call("usr_dana", "GET", `/v1/offers/${c.offerId}/envelope`)).json.status).toBe("voided");
  });

  it("the simulated signing page: the link opens it, finish signs (or declines) for the signer only, and the offer updates before the redirect back", async () => {
    const d = await send("Kit", "kit.ellery@candidate.example");
    const e = await send("Lane", "lane.ellery@candidate.example");
    const link = (await call(d.persona, "POST", "/v1/portal/esign/url", {})).json as { url: string };
    const u = new URL(link.url, "http://portal.test");
    expect(u.pathname).toBe("/portal");
    const envelopeId = u.searchParams.get("esign")!;
    expect(u.searchParams.get("return")).toBe(`/portal?as=${d.persona}&esign_return=1`);
    // Only the envelope's own signer can finish it, with a known outcome.
    expect((await call(e.persona, "POST", "/v1/portal/esign/finish", { envelopeId, outcome: "signed" })).status).toBe(404);
    expect((await call(d.persona, "POST", "/v1/portal/esign/finish", { envelopeId, outcome: "maybe" })).status).toBe(400);
    const signed = await call(d.persona, "POST", "/v1/portal/esign/finish", { envelopeId, outcome: "signed" });
    expect(signed.json).toEqual({ ok: true, envelopeId, outcome: "signed", offerStatus: "accepted" });
    expect((await call("usr_dana", "GET", `/v1/offers/${d.offerId}/envelope`)).json.status).toBe("completed");
    const again = await call(d.persona, "POST", "/v1/portal/esign/finish", { envelopeId, outcome: "declined" });
    expect([again.status, again.json.message]).toEqual([400, expect.stringContaining("is completed")]);
    expect((await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM events WHERE type = 'offer.accepted' AND subject_ref = ${d.offerId}`))[0]!.n).toBe(1);

    const eLink = new URL(((await call(e.persona, "POST", "/v1/portal/esign/url", {})).json as { url: string }).url, "http://portal.test");
    const declined = await call(e.persona, "POST", "/v1/portal/esign/finish", { envelopeId: eLink.searchParams.get("esign"), outcome: "declined" });
    expect(declined.json).toMatchObject({ ok: true, outcome: "declined", offerStatus: "declined" });
  });
});
