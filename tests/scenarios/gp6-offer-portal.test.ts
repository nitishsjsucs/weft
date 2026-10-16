// Scenario GP6 (docs/wave2.md): offer to signed. Owner: w2-onboarding. Scripted provider, createTestWeft().
// Dana drafts and sends an offer for a fictional CO candidate; the invite lands in the email simulator; the new hire
// persona opens it (viewed) and signs the offer letter and the confidentiality agreement by typing their name.
// Signature rows and action rows carry the signer, the sim timestamp and the server-verified document sha256.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestWeft, type TestWeft } from "./helpers";

const CANDIDATE = { candidateFirst: "Rowan", candidateLast: "Ellery", candidateEmail: "rowan.ellery@candidate.example", title: "Firmware Test Engineer", departmentId: "dpt_hardware", workState: "CO", baseCents: 13_200_000, payKind: "salary", startDate: "2026-11-02" };

describe("GP6 offer to signed", () => {
  let weft: TestWeft;
  beforeAll(async () => { weft = await createTestWeft(); });
  afterAll(async () => { await weft.close(); });
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };

  let offerId = "", persona = "", workerId = "";
  it("Dana drafts the offer, sends it, and the invite with the portal link is in the email simulator", async () => {
    const draft = await call("usr_dana", "POST", "/v1/offers", CANDIDATE);
    expect(draft.status).toBe(200);
    offerId = draft.json.data.offer_id;
    expect((await call("usr_dana", "GET", `/v1/offers/${offerId}`)).json).toMatchObject({ status: "draft", allowed: ["sent", "voided"], sentAt: null });
    const sent = await call("usr_dana", "POST", `/v1/offers/${offerId}/send`);
    expect(sent.status).toBe(200);
    persona = sent.json.data.persona_principal_id;
    workerId = sent.json.data.reserved_worker_id;
    expect(persona).toMatch(/^usr_\d{4}$/);
    const detail = (await call("usr_dana", "GET", `/v1/offers/${offerId}`)).json;
    expect(detail).toMatchObject({ status: "sent", personaPrincipalId: persona, sentAt: weft.clock.now() });
    const again = await call("usr_dana", "POST", `/v1/offers/${offerId}/send`);
    expect(again.status).toBe(422);
    expect(again.json.code).toBe("DOMAIN_ILLEGAL_TRANSITION");

    const mail = (await call("usr_dana", "GET", `/v1/sim/email?to=${CANDIDATE.candidateEmail}`)).json as { kind: string; relatedRef: string; body: string }[];
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ kind: "offer_invite", relatedRef: offerId });
    expect(mail[0]!.body).toContain(`/portal?as=${persona}`);
    const acts = await weft.db.all<{ command: string; actor_id: string }>(sql`SELECT command, actor_id FROM actions WHERE command LIKE 'documents.%' ORDER BY seq`);
    expect(acts).toEqual([{ command: "documents.create_offer", actor_id: "usr_dana" }, { command: "documents.send_offer", actor_id: "usr_dana" }]);
  });

  it("the persona sees only the portal; opening it marks the offer viewed", async () => {
    expect((await call(persona, "GET", "/v1/workers")).status).toBe(403);
    expect((await call(persona, "GET", `/v1/offers/${offerId}`)).status).toBe(403);
    const before = (await call(persona, "GET", "/v1/portal/me")).json;
    expect(before).toMatchObject({ offerId, done: 0, total: 7, worker: { id: workerId, displayName: "Rowan Ellery (demo)", workState: "CO" }, offer: { status: "sent" }, stateForm: { form: "DR 0004" } });
    expect(before.tasks.map((t: { kind: string; status: string }) => `${t.kind}:${t.status}`)).toEqual(["sign_offer:pending", "sign_confidentiality:blocked", "federal_w4:blocked", "state_withholding:blocked", "direct_deposit:blocked", "i9_sim:blocked", "benefits_selection:blocked"]);
    expect((await call(persona, "POST", "/v1/portal/offer/view")).json.data).toMatchObject({ status: "viewed", changed: true });
    expect((await call("usr_dana", "GET", `/v1/offers/${offerId}`)).json).toMatchObject({ status: "viewed", viewedAt: weft.clock.now() });
  });

  it("signing refuses a stale hash and a wrong name, then accepts the offer and records signer, time and hash", async () => {
    const view = (await call(persona, "GET", "/v1/portal/me")).json;
    const letter = view.documents.find((d: { kind: string }) => d.kind === "offer_letter");
    const nda = view.documents.find((d: { kind: string }) => d.kind === "confidentiality_agreement");
    expect(letter.bodyText).toContain("DEMO DOCUMENT");
    const stale = await call(persona, "POST", `/v1/portal/documents/${letter.id}/sign`, { typedName: "Rowan Ellery", documentSha256: "0".repeat(64) });
    expect([stale.status, stale.json.code]).toEqual([422, "STALE_SUBJECT"]);
    const wrong = await call(persona, "POST", `/v1/portal/documents/${letter.id}/sign`, { typedName: "Someone Else", documentSha256: letter.sha256 });
    expect(wrong.json.code).toBe("DOMAIN_NAME_MISMATCH");
    const early = await call(persona, "POST", `/v1/portal/documents/${nda.id}/sign`, { typedName: "Rowan Ellery", documentSha256: nda.sha256 });
    expect(early.json.code).toBe("DOMAIN_SIGN_OFFER_FIRST");

    const signed = await call(persona, "POST", `/v1/portal/documents/${letter.id}/sign`, { typedName: "rowan  ellery", documentSha256: letter.sha256 });
    expect(signed.status).toBe(200);
    expect(signed.json.data).toMatchObject({ offer_status: "accepted", worker_id: workerId, signer_principal_id: persona, signed_at: weft.clock.now(), document_sha256: letter.sha256 });
    const ndaSigned = await call(persona, "POST", `/v1/portal/documents/${nda.id}/sign`, { typedName: "Rowan Ellery", documentSha256: nda.sha256 });
    expect(ndaSigned.status).toBe(200);

    const sigs = await weft.db.all<{ document_id: string; signer_principal_id: string; signed_at: string; document_sha256: string; action_seq: number }>(sql`SELECT document_id, signer_principal_id, signed_at, document_sha256, action_seq FROM signatures ORDER BY id`);
    expect(sigs.map((s) => [s.document_id, s.signer_principal_id, s.signed_at, s.document_sha256])).toEqual([[letter.id, persona, weft.clock.now(), letter.sha256], [nda.id, persona, weft.clock.now(), nda.sha256]]);
    for (const s of sigs) {
      const [a] = await weft.db.all<{ command: string; actor_id: string; ts: string; args_json: string; summary: string }>(sql`SELECT command, actor_id, ts, args_json, summary FROM actions WHERE seq = ${s.action_seq}`);
      expect(a).toMatchObject({ command: "documents.sign", actor_id: persona, ts: s.signed_at });
      expect(JSON.parse(a!.args_json)).toMatchObject({ document_id: s.document_id, document_sha256: s.document_sha256 });
      expect(a!.summary).toContain(s.document_sha256);
    }
    expect((await call("usr_dana", "GET", `/v1/offers/${offerId}`)).json).toMatchObject({ status: "accepted", workerId });
    expect((await call("usr_dana", "GET", `/v1/workers/${workerId}`)).json.worker).toMatchObject({ id: workerId, status: "onboarding", displayName: "Rowan Ellery (demo)" });
    const lib = (await call("usr_dana", "GET", `/v1/workers/${workerId}/documents?status=signed`)).json as { kind: string }[];
    expect(lib.map((d) => d.kind)).toEqual(["offer_letter", "confidentiality_agreement"]);
    const me = (await call(persona, "GET", "/v1/portal/me")).json;
    expect([me.done, me.total, me.offer.status]).toEqual([2, 7, "accepted"]);
    const evts = await weft.db.all<{ type: string }>(sql`SELECT type FROM events WHERE type IN ('offer.sent', 'offer.viewed', 'offer.accepted', 'document.signed', 'onboarding.task_completed') ORDER BY id`);
    expect(evts.map((e) => e.type)).toEqual(["offer.sent", "offer.viewed", "offer.accepted", "document.signed", "onboarding.task_completed", "document.signed", "onboarding.task_completed"]);
  });

  it("void and expire follow OFFER_TRANSITIONS; final states refuse every move", async () => {
    const mk = async (email: string, expiresOn?: string) => (await call("usr_dana", "POST", "/v1/offers", { ...CANDIDATE, candidateFirst: "Juno", candidateLast: "Marlow", candidateEmail: email, expiresOn })).json.data.offer_id as string;
    const v = await mk("juno.marlow@candidate.example");
    await call("usr_dana", "POST", `/v1/offers/${v}/send`);
    expect((await call("usr_dana", "POST", `/v1/offers/${v}/void`)).json.data).toMatchObject({ status: "voided", previous_status: "sent" });
    expect((await call("usr_dana", "POST", `/v1/offers/${v}/send`)).json.code).toBe("DOMAIN_ILLEGAL_TRANSITION");
    expect((await call("usr_dana", "POST", `/v1/offers/${v}/void`)).json.code).toBe("DOMAIN_ILLEGAL_TRANSITION");
    expect((await call("usr_dana", "POST", `/v1/offers/${offerId}/void`)).json.code).toBe("DOMAIN_ILLEGAL_TRANSITION");   // accepted is final

    const x = await mk("juno.marlow2@candidate.example", "2026-10-28");
    await call("usr_dana", "POST", `/v1/offers/${x}/send`);
    await weft.clock.set("2026-10-30T16:00:00.000Z", 0);
    const dana = { principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui" as const, keyScope: null };
    const out = await weft.executor.human.exec(dana, "documents.expire_offers", {});
    expect(out.ok && out.status === "done" ? out.data : out).toMatchObject({ expired_offer_ids: [x] });
    expect((await call("usr_dana", "GET", `/v1/offers/${x}`)).json).toMatchObject({ status: "expired", allowed: [] });
    expect((await call("usr_dana", "POST", `/v1/offers/${x}/void`)).json.code).toBe("DOMAIN_ILLEGAL_TRANSITION");
    const acts = await weft.db.all<{ command: string }>(sql`SELECT command FROM actions WHERE command IN ('documents.void_offer', 'documents.expire_offers')`);
    expect(acts.map((a) => a.command)).toEqual(["documents.void_offer", "documents.expire_offers"]);
  });
  it("signed records are tamper-evident: the database refuses edits and verify catches a bypass", async () => {
    const [sig] = await weft.db.all<{ id: string; document_id: string }>(sql`SELECT id, document_id FROM signatures ORDER BY id LIMIT 1`);
    expect(sig, "a signature from the signing test").toBeTruthy();
    const ok = (await call("usr_dana", "GET", "/v1/actions/verify")).json as { ok: boolean; signatureProblems?: string[] };
    expect(ok).toMatchObject({ ok: true, signatureProblems: [] });
    await expect(weft.db.run(sql`UPDATE documents SET body_text = body_text || ' (edited)' WHERE id = ${sig!.document_id}`)).rejects.toThrow();
    await expect(weft.db.run(sql`UPDATE signatures SET typed_name = 'Someone Else' WHERE id = ${sig!.id}`)).rejects.toThrow();
    await expect(weft.db.run(sql`DELETE FROM signatures WHERE id = ${sig!.id}`)).rejects.toThrow();
    // A tamperer who drops the trigger is still caught by the signature pass of verify.
    await weft.db.run(sql`DROP TRIGGER documents_signed_no_edit`);
    await weft.db.run(sql`UPDATE documents SET body_text = body_text || ' (edited: base salary $999,999.00)' WHERE id = ${sig!.document_id}`);
    const bad = (await call("usr_dana", "GET", "/v1/actions/verify")).json as { ok: boolean; signatureProblems: string[] };
    expect(bad.ok).toBe(false);
    expect(bad.signatureProblems.join(" ")).toContain(sig!.document_id);
  });
});
