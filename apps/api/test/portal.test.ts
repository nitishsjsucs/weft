// /v1/portal contract tests (w2-onboarding): the persona is confined to the portal, the state certificate appears
// only for states that have one, direct deposit validates inline, and I-9 uploads are masked and type-checked.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { W2OnboardingPortalView } from "@weft/contracts";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft.close(); });

const call = async (who: string, method: string, path: string, body?: unknown) => {
  const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};
const NAMES: Record<string, [string, string]> = { CA: ["Mara", "Quill"], NY: ["Tobin", "Ashe"], CO: ["Lena", "Sorrel"], TX: ["Odell", "Pike"] };
async function hire(state: string, sign = true) {
  const [first, last] = NAMES[state]!;
  const offerId = (await call("usr_dana", "POST", "/v1/offers", { candidateFirst: first, candidateLast: last, candidateEmail: `${first.toLowerCase()}@candidate.example`, title: "Test Technician", departmentId: "dpt_operations", workState: state, baseCents: 9_000_000, startDate: "2026-11-16" })).json.data.offer_id as string;
  const sent = (await call("usr_dana", "POST", `/v1/offers/${offerId}/send`)).json.data as { persona_principal_id: string; reserved_worker_id: string };
  const persona = sent.persona_principal_id;
  if (sign) {
    const letter = (await call(persona, "GET", "/v1/portal/me")).json.documents[0];
    expect((await call(persona, "POST", `/v1/portal/documents/${letter.id}/sign`, { typedName: `${first} ${last}`, documentSha256: letter.sha256 })).status).toBe(200);
  }
  return { offerId, persona, workerId: sent.reserved_worker_id, name: `${first} ${last}` };
}

describe("the new hire persona", () => {
  it("reaches only /v1/portal/*; admin routes answer 403 PORTAL_ONLY", async () => {
    const { persona } = await hire("CO", false);
    for (const path of ["/v1/workers", "/v1/offers", "/v1/payrolls", "/v1/proposals", "/v1/sim/email", "/v1/stats"]) {
      const r = await call(persona, "GET", path);
      expect([path, r.status, r.json.code ?? r.json.extra?.code]).toEqual([path, 403, "PORTAL_ONLY"]);
    }
    expect((await call(persona, "POST", "/v1/payrolls/drafts", { payScheduleId: "ps_us_semimonthly", periodEnd: "2026-11-15" })).status).toBe(403);
    const me = await call(persona, "GET", "/v1/portal/me");
    expect(me.status).toBe(200);
    expect(W2OnboardingPortalView.safeParse(me.json).success).toBe(true);
  });

  it("a person who is not a new hire has no portal", async () => {
    const r = await call("usr_dana", "GET", "/v1/portal/me");
    expect(r.status).toBe(403);
    expect((await call("usr_dana", "POST", "/v1/portal/w4", { filingStatus: "single", step2Checkbox: false, step3Cents: 0, step4aCents: 0, step4bCents: 0, step4cCents: 0, typedName: "Dana Whitfield" })).json.code).toBe("DOMAIN_NOT_NEW_HIRE");
  });

  it("the state certificate appears for CA, NY and CO and not for TX", async () => {
    const forms: Record<string, string | null> = {};
    for (const st of ["CA", "NY", "TX"]) {
      const { persona } = await hire(st);
      const v = (await call(persona, "GET", "/v1/portal/me")).json;
      forms[st] = v.stateForm?.form ?? null;
      expect(v.tasks.some((t: { kind: string }) => t.kind === "state_withholding"), st).toBe(st !== "TX");
      expect(v.total, st).toBe(st === "TX" ? 6 : 7);
    }
    expect(forms).toEqual({ CA: "DE 4", NY: "IT-2104", TX: null });
  });

  it("direct deposit refuses an ABA failure inline and a closed account through the bank simulator", async () => {
    const { persona, name } = await hire("CO");
    const bad = await call(persona, "POST", "/v1/portal/direct-deposit", { bankName: "Sim Federal Credit Union", routing: "123456789", account: "99887766", accountType: "checking", typedName: name });
    expect([bad.status, bad.json.code, bad.json.field]).toEqual([422, "INVALID_INPUT", "routing"]);
    const closed = await call(persona, "POST", "/v1/portal/direct-deposit", { bankName: "Sim Federal Credit Union", routing: "011000015", account: "12340000", accountType: "savings", typedName: name });
    expect([closed.status, closed.json.code]).toEqual([422, "DOMAIN_BANK_NOT_VERIFIED"]);
    const ok = await call(persona, "POST", "/v1/portal/direct-deposit", { bankName: "Sim Federal Credit Union", routing: "011000015", account: "12345678", accountType: "savings", typedName: name });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.json)).not.toContain("12345678");
    expect((await call(persona, "GET", "/v1/portal/me")).json.bank).toEqual({ bankName: "Sim Federal Credit Union", routingLast4: "0015", accountLast4: "5678", status: "active" });
  });

  it("the I-9 upload refuses a non-image and answers masked", async () => {
    const { persona, name } = await hire("CO");
    const form = (type: string) => {
      const f = new FormData();
      f.set("citizenship", "permanent_resident"); f.set("documentKind", "permanent_resident_card"); f.set("documentNumberLast4", "Z0Z1"); f.set("typedName", name);
      f.set("idImage", new Blob([Buffer.from("sample id image")], { type }), "card-front.jpg");
      return f;
    };
    const txt = await weft.app.request("/v1/portal/i9", { method: "POST", headers: weft.uiHeaders(persona), body: form("text/plain") });
    expect(txt.status).toBe(422);
    const ok = await weft.app.request("/v1/portal/i9", { method: "POST", headers: weft.uiHeaders(persona), body: form("image/jpeg") });
    const body = (await ok.json()) as any;
    expect(ok.status).toBe(200);
    expect(body.data.upload).toMatchObject({ masked: true, fileName: "ca***.jpg" });
    expect(JSON.stringify(body)).not.toContain("card-front");
  });
});
