// Screening and e-signature adapters and routes (w3-integrations-screening-esign). The real adapters run only against a
// fake fetch here (no network); secrets come from a temporary WEFT_SECRETS_FILE holding fake values.
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCheckrClient } from "../../../packages/integrations/src/real/checkr";
import { createDocusignClient, docusignAssertion, verifyDocusignConnect } from "../../../packages/integrations/src/real/docusign";
import { createHireRightRefusal } from "../../../packages/integrations/src/real/hireright";
import { createTestWeft, type TestWeft } from "../src/testing";

const CHECKR_BODY = '{"id":"sim_evt_000001","object":"event","type":"report.completed","created_at":"2026-10-27T15:30:00.000Z","data":{"object":{"id":"sim_rpt_000003","object":"report","status":"complete","result":"clear"}}}';
const DS_BODY = '{"event":"envelope-completed","apiVersion":"v2.1","generatedDateTime":"2026-10-27T15:30:00.000Z","data":{"accountId":"sim-account-0001","envelopeId":"sim-env-000001"}}';
const enc = (s: string) => new TextEncoder().encode(s);

let dir = "";
let env: Record<string, string> = {};
let publicPem = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "weft-screening-"));
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  publicPem = publicKey;
  writeFileSync(join(dir, "ds.pem"), privateKey);
  // Fake values only: the HMAC keys equal the simulators' published sim keys so the same vectors check both paths.
  writeFileSync(join(dir, "secrets.env"), [
    "CHECKR_API_KEY=weft-sim-checkr-webhook-key-not-a-secret", "DOCUSIGN_INTEGRATION_KEY=ik-test-0001", "DOCUSIGN_USER_ID=user-test-0001",
    "DOCUSIGN_ACCOUNT_ID=acct-test-0001", `DOCUSIGN_PRIVATE_KEY_FILE=${join(dir, "ds.pem")}`, "DOCUSIGN_CONNECT_HMAC_KEY=weft-sim-docusign-connect-key-not-a-secret",
  ].join("\n"));
  env = { WEFT_SECRETS_FILE: join(dir, "secrets.env"), VITEST: "true" };
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

type Seen = { url: string; method: string; headers: Record<string, string>; body: string | undefined };
function fakeFetch(answer: (s: Seen) => unknown) {
  const seen: Seen[] = [];
  const f = (async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const s = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body };
    seen.push(s);
    return new Response(JSON.stringify(answer(s)), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe("Checkr adapter (published shapes, fake fetch)", () => {
  it("verifies X-Checkr-Signature hex HMAC on the raw bytes with the API key; a re-serialized body fails", () => {
    const c = createCheckrClient({ env, fetch: fakeFetch(() => ({})).f });
    const sig = "3babe9f9d6561e6b2b48194a200ba640412304881fd0aa66764d3db3b6b8b8fb";
    expect(c.verifyWebhook(enc(CHECKR_BODY), { "X-Checkr-Signature": sig })).toEqual({ ok: true, dedupeKey: "sim_evt_000001" });
    expect(c.verifyWebhook(enc(JSON.stringify(JSON.parse(CHECKR_BODY))), { "X-Checkr-Signature": sig }).ok).toBe(true);   // compact JSON.stringify keeps the same bytes
    expect(c.verifyWebhook(enc(JSON.stringify(JSON.parse(CHECKR_BODY), null, 2)), { "X-Checkr-Signature": sig }).ok).toBe(false);
    expect(c.verifyWebhook(enc(CHECKR_BODY), {}).ok).toBe(false);
  });
  it("orders through the hosted invitation flow with Basic auth and idempotency keys, on staging by default", async () => {
    const { f, seen } = fakeFetch((s) => s.url.endsWith("/candidates") ? { id: "cand_1" } : s.url.endsWith("/invitations") ? { id: "inv_1", status: "pending", invitation_url: "https://apply.example/inv_1" } : s.url.includes("/invitations/") ? { id: "inv_1", status: "completed", report_id: "rpt_1" } : { id: "rpt_1", status: "complete", result: "clear", adjudication: null, completed_at: "2026-10-27T15:30:00Z" });
    const c = createCheckrClient({ env, fetch: f });
    const o = await c.createOrder({ orderId: "scr_0001", candidate: { first: "Rowan", last: "Ellery", email: "rowan@candidate.example" }, packageSlug: "basic", workLocation: { country: "US", state: "CO", city: null } });
    expect(o).toEqual({ vendorCandidateId: "cand_1", vendorOrderId: "inv_1", applyUrl: "https://apply.example/inv_1", status: "invited" });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["POST https://api.checkr-staging.com/v1/candidates", "POST https://api.checkr-staging.com/v1/invitations"]);
    expect(seen[0]!.headers.authorization).toBe(`Basic ${Buffer.from("weft-sim-checkr-webhook-key-not-a-secret:").toString("base64")}`);
    expect(seen[1]!.headers["idempotency-key"]).toMatch(/^[0-9a-f]{40}$/);
    expect(JSON.parse(seen[0]!.body!)).toEqual({ first_name: "Rowan", last_name: "Ellery", email: "rowan@candidate.example", work_locations: [{ country: "US", state: "CO" }] });
    expect(JSON.parse(seen[1]!.body!)).toMatchObject({ candidate_id: "cand_1", package: "basic" });
    expect(await c.getOrder("inv_1")).toMatchObject({ status: "complete_clear", result: "clear", vendorReportId: "rpt_1" });
  });
  it("refuses production unless WEFT_LIVE_CHECKR=1, and refuses to run without an injected fetch inside a test", async () => {
    const prod = createCheckrClient({ env: { ...env, CHECKR_ENV: "production" }, fetch: fakeFetch(() => ({})).f });
    await expect(prod.listPackages()).rejects.toThrow(/INTEGRATION_LIVE_DISABLED/);
    expect((await prod.status()).health).toBe("permission_gap");
    await expect(createCheckrClient({ env }).listPackages()).rejects.toThrow(/LIVE_INTEGRATION_IN_TEST/);
  });
});

describe("HireRight adapter", () => {
  it("always refuses INTEGRATION_NOT_AVAILABLE", async () => {
    const h = createHireRightRefusal();
    expect(await h.status()).toMatchObject({ health: "not_available", detail: "INTEGRATION_NOT_AVAILABLE" });
    await expect(h.listPackages()).rejects.toThrow(/INTEGRATION_NOT_AVAILABLE/);
    await expect(h.createOrder({} as never)).rejects.toThrow(/INTEGRATION_NOT_AVAILABLE/);
    expect(h.verifyWebhook(enc("{}"), {}).ok).toBe(false);
  });
});

describe("DocuSign adapter (JWT grant, Connect HMAC, poll guard; fake fetch)", () => {
  const live = () => ({ ...env, WEFT_ESIGN: "docusign", WEFT_LIVE_DOCUSIGN: "1" });
  it("verifies the base64 Connect vector on raw bytes; a re-serialized body fails", () => {
    expect(verifyDocusignConnect(enc(DS_BODY), { "X-DocuSign-Signature-1": "mJrSEMlywVvSNoALGrJ0EgWk8r81rHCZGwmDUPfbda0=" }, "weft-sim-docusign-connect-key-not-a-secret")).toBe(true);
    expect(verifyDocusignConnect(enc(JSON.stringify(JSON.parse(DS_BODY), null, 2)), { "X-DocuSign-Signature-1": "mJrSEMlywVvSNoALGrJ0EgWk8r81rHCZGwmDUPfbda0=" }, "weft-sim-docusign-connect-key-not-a-secret")).toBe(false);
    const c = createDocusignClient({ env: live(), fetch: fakeFetch(() => ({})).f });
    expect(c.verifyWebhook(enc(DS_BODY), { "x-docusign-signature-2": "mJrSEMlywVvSNoALGrJ0EgWk8r81rHCZGwmDUPfbda0=" }).ok).toBe(true);
  });
  it("signs an RS256 assertion the public key verifies, with the documented claims", () => {
    const pem = readFileSync(join(dir, "ds.pem"), "utf8");
    const jwt = docusignAssertion({ integrationKey: "ik", userId: "u", aud: "account-d.docusign.com", privateKeyPem: pem, nowSec: 1_800_000_000 });
    const [h, b, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(b, "base64url").toString())).toEqual({ iss: "ik", sub: "u", aud: "account-d.docusign.com", iat: 1_800_000_000, exp: 1_800_003_600, scope: "signature impersonation" });
    expect(createVerify("RSA-SHA256").update(`${h}.${b}`).verify(publicPem, Buffer.from(s, "base64url"))).toBe(true);
  });
  it("sends one envelope with both documents and an embedded signer, and reads status at most once per 15 minutes", async () => {
    let now = Date.parse("2026-10-26T15:30:00Z");
    const { f, seen } = fakeFetch((s) => s.url.endsWith("/oauth/token") ? { access_token: "tok", expires_in: 3600 } : s.url.endsWith("/oauth/userinfo") ? { accounts: [{ account_id: "acct-test-0001", base_uri: "https://demo.example" }] }
      : s.url.endsWith("/envelopes") ? { envelopeId: "env-1", status: "sent" } : { status: "completed", recipients: { signers: [{ clientUserId: "usr_0010", status: "completed" }] } });
    const c = createDocusignClient({ env: live(), fetch: f, nowMs: () => now });
    const docs = [{ weftDocId: "doc_1", title: "Offer letter", bytes: enc("letter"), sha256: "a".repeat(64) }, { weftDocId: "doc_2", title: "Confidentiality agreement", bytes: enc("nda"), sha256: "b".repeat(64) }];
    expect(await c.send({ offerId: "offr_0002", documents: docs, signer: { name: "Rowan Ellery", email: "rowan@candidate.example", clientUserId: "usr_0010" }, expiresOn: "2026-11-09" })).toEqual({ envelopeId: "env-1", status: "sent" });
    const post = seen.find((s) => s.url === "https://demo.example/restapi/v2.1/accounts/acct-test-0001/envelopes")!;
    const body = JSON.parse(post.body!);
    expect(body.documents).toHaveLength(2);
    expect(body.recipients.signers).toEqual([expect.objectContaining({ clientUserId: "usr_0010", recipientId: "1" })]);
    expect(body.customFields.textCustomFields[0]).toMatchObject({ name: "weft_offer_id", value: "offr_0002" });
    expect(new URLSearchParams(seen[0]!.body!).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect((await c.envelope("env-1")).status).toBe("completed");
    now += 14 * 60_000;
    await expect(c.envelope("env-1")).rejects.toThrow(/INTEGRATION_RATE_GUARD/);
    now += 60_000;
    expect((await c.envelope("env-1")).status).toBe("completed");
    expect(seen.filter((s) => s.url.endsWith("/oauth/token"))).toHaveLength(1);   // the token is reused until 15 minutes before expiry
  });
  it("refuses unless WEFT_ESIGN=docusign and WEFT_LIVE_DOCUSIGN=1", async () => {
    const c = createDocusignClient({ env, fetch: fakeFetch(() => ({})).f });
    await expect(c.envelope("env-1")).rejects.toThrow(/INTEGRATION_LIVE_DISABLED/);
  });
});

describe("screening routes", () => {
  let weft: TestWeft;
  beforeAll(async () => { weft = await createTestWeft(); });
  afterAll(async () => { await weft.close(); });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders("usr_dana"), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  it("lists the seeded catalog and ceilings, refuses an order before acceptance, validates steps, and has no envelope on the built-in path", async () => {
    const pk = (await call("GET", "/v1/screening/packages")).json as { vendor: string; slug: string; priceCents: number; phase: string }[];
    expect(pk.filter((p) => p.vendor === "checkr").map((p) => `${p.slug}:${p.priceCents}:${p.phase}`)).toEqual(["weft_nyc_criminal_sim:2500:criminal", "weft_nyc_noncriminal_sim:2000:non_criminal", "weft_standard_mvr_sim:5500:full", "weft_standard_sim:3500:full"]);
    const lim = await weft.db.all<{ key: string; cents: number }>("SELECT key, cents FROM limits WHERE key LIKE 'agent.screening%' ORDER BY key" as never);
    expect(lim).toEqual([{ key: "agent.screening_cents", cents: 10_000 }, { key: "agent.screening_day_cents", cents: 30_000 }]);
    const offers = (await call("GET", "/v1/offers?limit=100")).json.data as { id: string; status: string }[];
    const open = offers.find((o) => o.status !== "accepted")!;
    const r = await call("POST", `/v1/offers/${open.id}/screening`, {});
    expect([r.status, r.json.code]).toEqual([422, "DOMAIN_SCREENING_BEFORE_OFFER"]);
    expect((await call("GET", "/v1/screening/orders")).json).toEqual({ hasMore: false, count: 0, data: [] });
    expect((await call("POST", "/v1/screening/orders/scr_0001/adjudicate", { step: "approve_all" })).status).toBe(400);
    expect((await call("GET", `/v1/offers/${open.id}/envelope`)).status).toBe(404);
  });
});
