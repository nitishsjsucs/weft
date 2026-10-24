// /v1 documents contract tests (w2-onboarding): the person view's library by status, one document with its
// signature record, and the email simulator outbox.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkerDocument } from "@weft/contracts";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft.close(); });

const call = async (who: string, method: string, path: string, body?: unknown) => {
  const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};

describe("document library", () => {
  let workerId = "", persona = "";
  it("lists Sent documents after the offer goes out, then Signed after the signature", async () => {
    const offerId = (await call("usr_dana", "POST", "/v1/offers", { candidateFirst: "Pia", candidateLast: "Strand", candidateEmail: "pia.strand@candidate.example", title: "Mechanical Engineer", departmentId: "dpt_hardware", workState: "CA", baseCents: 15_000_000, startDate: "2026-11-16" })).json.data.offer_id as string;
    const sent = (await call("usr_dana", "POST", `/v1/offers/${offerId}/send`)).json.data;
    workerId = sent.reserved_worker_id; persona = sent.persona_principal_id;
    const all = (await call("usr_dana", "GET", `/v1/workers/${workerId}/documents`)).json as unknown[];
    expect(all.map((d) => WorkerDocument.parse(d).status)).toEqual(["sent", "sent"]);
    expect(JSON.stringify(all)).not.toContain("bodyText");
    const letter = (await call(persona, "GET", "/v1/portal/me")).json.documents[0];
    await call(persona, "POST", `/v1/portal/documents/${letter.id}/sign`, { typedName: "Pia Strand", documentSha256: letter.sha256 });
    expect(((await call("usr_dana", "GET", `/v1/workers/${workerId}/documents?status=signed`)).json as { kind: string }[]).map((d) => d.kind)).toEqual(["offer_letter"]);
    expect(((await call("usr_dana", "GET", `/v1/workers/${workerId}/documents?status=sent`)).json as { kind: string }[]).map((d) => d.kind)).toEqual(["confidentiality_agreement"]);
    expect((await call("usr_dana", "GET", `/v1/workers/${workerId}/documents?status=nope`)).status).toBe(400);
  });

  it("one document carries its signature record and body", async () => {
    const [letter] = (await call("usr_dana", "GET", `/v1/workers/${workerId}/documents?status=signed`)).json as { id: string; sha256: string }[];
    const d = (await call("usr_dana", "GET", `/v1/documents/${letter!.id}`)).json;
    expect(d).toMatchObject({ kind: "offer_letter", status: "signed", signature: { signerPrincipalId: persona, typedName: "Pia Strand", documentSha256: letter!.sha256, signedAt: weft.clock.now() } });
    expect(d.bodyText).toContain("Pia Strand");
    expect((await call("usr_dana", "GET", "/v1/documents/doc_9999")).status).toBe(404);
  });

  it("the email outbox filters by recipient", async () => {
    expect(((await call("usr_dana", "GET", "/v1/sim/email?to=pia.strand@candidate.example")).json as { kind: string }[]).map((m) => m.kind)).toEqual(["offer_invite"]);
    expect((await call("usr_dana", "GET", "/v1/sim/email?to=nobody@candidate.example")).json).toEqual([]);
  });
});
