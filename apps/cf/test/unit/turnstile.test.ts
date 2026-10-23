// Turnstile siteverify (design 6.2 and 8.1): what the front sends, one idempotency key per verification reused only on
// the one retry after a transport failure, and the local stub's published test-secret semantics the Miniflare suite
// verifies against (design 11.4).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FrontEnv } from "../../src/shared/env";
import { siteverify } from "../../src/front/turnstile";
import { answerFor, DUMMY_TOKEN, SiteverifyStub, TEST_SECRETS } from "../support/siteverify-stub";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const env = (o: Partial<FrontEnv> = {}) => ({ TURNSTILE_SECRET: TEST_SECRETS.pass, TURNSTILE_VERIFY_URL: "https://siteverify.test/turnstile/v0/siteverify", ...o }) as FrontEnv;

type Sent = { url: string; fields: Record<string, string> };
/** A fetch that answers from a script of outcomes and records each form it was sent. */
function scripted(outcomes: (Response | Error)[]): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const fields: Record<string, string> = {};
    for (const [k, v] of init!.body as FormData) fields[k] = String(v);
    sent.push({ url: String(input), fields });
    const next = outcomes.shift() ?? new Error("no more outcomes");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetch: f, sent };
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("siteverify", () => {
  it("sends the secret, the token, the visitor's IP and a UUID idempotency key to the configured URL", async () => {
    const s = scripted([ok({ success: true, "error-codes": [], hostname: "weft.test" })]);
    expect(await siteverify(env(), DUMMY_TOKEN, "198.51.100.7", s.fetch)).toEqual({ success: true, codes: [], hostname: "weft.test" });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.url).toBe("https://siteverify.test/turnstile/v0/siteverify");
    expect(s.sent[0]!.fields).toMatchObject({ secret: TEST_SECRETS.pass, response: DUMMY_TOKEN, remoteip: "198.51.100.7" });
    expect(s.sent[0]!.fields.idempotency_key).toMatch(UUID);
  });

  it("uses a new key for each verification, so a token sent again is a second use (single-use holds)", async () => {
    const s = scripted([ok({ success: true }), ok({ success: false, "error-codes": ["timeout-or-duplicate"] })]);
    expect((await siteverify(env(), DUMMY_TOKEN, "198.51.100.7", s.fetch)).success).toBe(true);
    expect(await siteverify(env(), DUMMY_TOKEN, "198.51.100.7", s.fetch)).toMatchObject({ success: false, codes: ["timeout-or-duplicate"] });
    expect(s.sent[0]!.fields.idempotency_key).not.toBe(s.sent[1]!.fields.idempotency_key);
  });

  it("retries once with the same key after a network error, a timeout or a 5xx", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    for (const first of [new TypeError("fetch failed"), timeout, new Response("busy", { status: 503 })]) {
      const s = scripted([first, ok({ success: true, "error-codes": [] })]);
      expect((await siteverify(env(), DUMMY_TOKEN, "198.51.100.7", s.fetch)).success).toBe(true);
      expect(s.sent).toHaveLength(2);
      expect(s.sent[1]!.fields.idempotency_key).toBe(s.sent[0]!.fields.idempotency_key);
    }
  });

  it("does not retry an answer: a refusal or a 4xx is final", async () => {
    const refused = scripted([ok({ success: false, "error-codes": ["invalid-input-response"] }), ok({ success: true })]);
    expect(await siteverify(env(), "forged", "198.51.100.7", refused.fetch)).toMatchObject({ success: false, codes: ["invalid-input-response"] });
    expect(refused.sent).toHaveLength(1);
    const bad = scripted([new Response("", { status: 400 }), ok({ success: true })]);
    expect(await siteverify(env(), DUMMY_TOKEN, "198.51.100.7", bad.fetch)).toMatchObject({ success: false, codes: ["http-400"] });
    expect(bad.sent).toHaveLength(1);
  });

  it("fails closed after two transport failures, and makes no call without a secret or a usable token", async () => {
    const down = scripted([new TypeError("fetch failed"), Object.assign(new Error("timed out"), { name: "TimeoutError" })]);
    expect(await siteverify(env(), DUMMY_TOKEN, "198.51.100.7", down.fetch)).toEqual({ success: false, codes: ["timeout"], hostname: null });
    expect(down.sent).toHaveLength(2);
    const none = scripted([]);
    expect(await siteverify(env({ TURNSTILE_SECRET: "" }), DUMMY_TOKEN, "198.51.100.7", none.fetch)).toMatchObject({ success: false, codes: ["missing-input-secret"] });
    expect(await siteverify(env(), "", "198.51.100.7", none.fetch)).toMatchObject({ success: false, codes: ["invalid-input-response"] });
    expect(await siteverify(env(), "x".repeat(2049), "198.51.100.7", none.fetch)).toMatchObject({ success: false });
    expect(none.sent).toHaveLength(0);
  });

  it("leaves remoteip out when the IP is unknown", async () => {
    const s = scripted([ok({ success: true })]);
    await siteverify(env(), DUMMY_TOKEN, "0.0.0.0", s.fetch);
    expect(s.sent[0]!.fields).not.toHaveProperty("remoteip");
  });
});

describe("the siteverify stub (Cloudflare's published test secrets)", () => {
  it("passes the dummy token with 1x...AA only, fails 2x...AA, answers 3x...AA as spent, refuses other secrets", () => {
    expect(answerFor(TEST_SECRETS.pass, DUMMY_TOKEN).body).toMatchObject({ success: true, "error-codes": [] });
    expect(answerFor(TEST_SECRETS.pass, "a.real.token").body).toEqual({ success: false, "error-codes": ["invalid-input-response"] });
    expect(answerFor(TEST_SECRETS.fail, DUMMY_TOKEN).body).toEqual({ success: false, "error-codes": ["invalid-input-response"] });
    expect(answerFor(TEST_SECRETS.spent, DUMMY_TOKEN).body).toEqual({ success: false, "error-codes": ["timeout-or-duplicate"] });
    expect(answerFor("0x4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", DUMMY_TOKEN).body).toEqual({ success: false, "error-codes": ["invalid-input-secret"] });
    expect(answerFor(null, DUMMY_TOKEN).body).toEqual({ success: false, "error-codes": ["missing-input-secret"] });
    expect(answerFor(TEST_SECRETS.pass, null).body).toEqual({ success: false, "error-codes": ["missing-input-response"] });
  });

  let stub: SiteverifyStub;
  beforeAll(async () => { stub = await SiteverifyStub.start(); });
  afterAll(async () => { await stub?.close(); });

  it("answers the front's own form over HTTP and records the call without the secret", async () => {
    expect((await siteverify(env({ TURNSTILE_VERIFY_URL: stub.url }), DUMMY_TOKEN, "198.51.100.9")).success).toBe(true);
    expect(await siteverify(env({ TURNSTILE_VERIFY_URL: stub.url, TURNSTILE_SECRET: TEST_SECRETS.fail }), DUMMY_TOKEN, "198.51.100.9"))
      .toMatchObject({ success: false, codes: ["invalid-input-response"] });
    expect(stub.calls.map((c) => c.secretKind)).toEqual(["pass", "fail"]);
    expect(stub.calls[0]).toMatchObject({ response: DUMMY_TOKEN, remoteip: "198.51.100.9" });
    expect(stub.calls[0]!.idempotencyKey).toMatch(UUID);
    expect(JSON.stringify(stub.calls)).not.toContain(TEST_SECRETS.pass);
  });
});

describe("siteverify's hostname check", () => {
  const LIVE = "0x4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const live = (o: Partial<FrontEnv> = {}) => env({ TURNSTILE_SECRET: LIVE, WEFT_PUBLIC_ORIGIN: "https://weft.nitish-ratakonda.workers.dev", ...o });

  it("accepts a success only when it names this deployment's hostname", async () => {
    const good = scripted([ok({ success: true, "error-codes": [], hostname: "weft.nitish-ratakonda.workers.dev" })]);
    expect(await siteverify(live(), "a.real.token", "198.51.100.7", good.fetch)).toEqual({ success: true, codes: [], hostname: "weft.nitish-ratakonda.workers.dev" });
    const elsewhere = scripted([ok({ success: true, "error-codes": [], hostname: "copycat.example" })]);
    expect(await siteverify(live(), "a.real.token", "198.51.100.7", elsewhere.fetch)).toEqual({ success: false, codes: ["hostname-mismatch"], hostname: "copycat.example" });
    const none = scripted([ok({ success: true, "error-codes": [] })]);
    expect(await siteverify(live(), "a.real.token", "198.51.100.7", none.fetch)).toMatchObject({ success: false, codes: ["hostname-mismatch"] });
  });

  it("fails closed without WEFT_PUBLIC_ORIGIN, and leaves a refusal as it was", async () => {
    const s = scripted([ok({ success: true, hostname: "weft.nitish-ratakonda.workers.dev" })]);
    expect(await siteverify(live({ WEFT_PUBLIC_ORIGIN: undefined }), "a.real.token", "198.51.100.7", s.fetch)).toMatchObject({ success: false, codes: ["hostname-unconfigured"] });
    const refused = scripted([ok({ success: false, "error-codes": ["invalid-input-response"], hostname: "copycat.example" })]);
    expect(await siteverify(live(), "a.real.token", "198.51.100.7", refused.fetch)).toMatchObject({ success: false, codes: ["invalid-input-response"] });
  });

  it("does not apply to Cloudflare's test secrets, which answer every dummy token with a fixed hostname", async () => {
    const s = scripted([ok({ success: true, "error-codes": [], hostname: "example.com" })]);
    expect((await siteverify(env({ WEFT_PUBLIC_ORIGIN: "https://weft.test" }), DUMMY_TOKEN, "198.51.100.7", s.fetch)).success).toBe(true);
  });
});
