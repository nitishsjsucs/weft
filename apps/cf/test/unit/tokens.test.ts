// The signed values the hosted path trusts (design 3.4, 6.2, 6.4, 9.2): session cookie, human grant, x-weft-ctx,
// the smoke header, the admin signature and the daily IP hash.
import { describe, expect, it } from "vitest";
import {
  grantToken, ipHash, ipKeyOf, mcpKeyId, newVisitorId, operatorVisitorId, readCtx, readGrant, readSession, sessionToken, SIGNATURE_FUTURE_S, SIGNATURE_WINDOW_S, signAdmin, signCtx, signSmoke, verifyAdmin, verifySmoke,
} from "../../src/shared/tokens";
import { formatHostedMcpKey, parseHostedMcpKey } from "../../src/shared/contracts";
import { fromBase64Url, randomAlnum, toBase64Url } from "../../src/shared/crypto";

const SECRET = "s".repeat(64);
const nowS = 1_792_000_000;
const visitor = "vis_" + "a".repeat(32);

describe("session and grant tokens", () => {
  it("round-trips a session and rejects tampering, expiry and malformed claims", async () => {
    const t = await sessionToken(SECRET, { visitor, slot: "slot-1", gen: 3, exp: nowS + 60 });
    expect(await readSession(SECRET, t, nowS)).toEqual({ ok: true, claims: { visitor, slot: "slot-1", gen: 3, exp: nowS + 60 } });
    expect(await readSession(SECRET, t, nowS + 60)).toEqual({ ok: false, reason: "expired" });
    expect((await readSession("x".repeat(64), t, nowS)).ok).toBe(false);
    const [v, body, sig] = t.split(".");
    const forged = JSON.parse(new TextDecoder().decode(fromBase64Url(body!)!)) as Record<string, unknown>;
    forged.slot = "slot-2";
    const forgedBody = toBase64Url(new TextEncoder().encode(JSON.stringify(forged)));
    expect(await readSession(SECRET, `${v}.${forgedBody}.${sig}`, nowS)).toEqual({ ok: false, reason: "signature" });
    expect(await readSession(SECRET, "garbage", nowS)).toEqual({ ok: false, reason: "malformed" });
    const bad = await sessionToken(SECRET, { visitor: "nope", slot: "slot-1", gen: 1, exp: nowS + 60 });
    expect(await readSession(SECRET, bad, nowS)).toEqual({ ok: false, reason: "malformed" });
  });

  it("never accepts a grant as a session or a session as a grant (labels differ)", async () => {
    const g = await grantToken(SECRET, { visitor, exp: nowS + 600 });
    expect(await readGrant(SECRET, g, nowS)).toEqual({ ok: true, claims: { visitor, exp: nowS + 600 } });
    expect((await readSession(SECRET, g, nowS)).ok).toBe(false);
    const s = await sessionToken(SECRET, { visitor, slot: "slot-1", gen: 1, exp: nowS + 600 });
    expect((await readGrant(SECRET, s, nowS)).ok).toBe(false);
  });

  it("makes visitor ids of the cookie's shape", () => {
    expect(newVisitorId()).toMatch(/^vis_[0-9a-f]{32}$/);
    expect(newVisitorId()).not.toBe(newVisitorId());
  });
});

describe("x-weft-ctx", () => {
  it("is HMAC'd, fresh and well formed", async () => {
    const c = { slot: "slot-2", gen: 4, visitor, ipHash: "ab".repeat(16), human: true, smoke: false, iat: nowS };
    const h = await signCtx(SECRET, c);
    expect(await readCtx(SECRET, h, nowS + 10)).toEqual({ ok: true, claims: c });
    expect(await readCtx(SECRET, h, nowS + 301)).toEqual({ ok: false, reason: "expired" });
    expect((await readCtx("y".repeat(64), h, nowS)).ok).toBe(false);
    expect(await readCtx(SECRET, null, nowS)).toEqual({ ok: false, reason: "malformed" });
    const odd = await signCtx(SECRET, { ...c, slot: "../x" });
    expect(await readCtx(SECRET, odd, nowS)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("smoke and admin signatures", () => {
  it("accepts a smoke header within 5 minutes and nothing else", async () => {
    const tok = "t".repeat(48);
    const req = { method: "GET", path: "/api/v1/health" };
    const h = await signSmoke(tok, req, nowS);
    expect(await verifySmoke(tok, h, req, nowS + 299)).toBe(true);
    expect(await verifySmoke(tok, h, req, nowS + 301)).toBe(false);
    expect(await verifySmoke("u".repeat(48), h, req, nowS)).toBe(false);
    expect(await verifySmoke(undefined, h, req, nowS)).toBe(false);
    expect(await verifySmoke(tok, "123.abc", req, nowS)).toBe(false);
  });

  it("binds the smoke header to the method and path it was signed for", async () => {
    const tok = "t".repeat(48);
    const h = await signSmoke(tok, { method: "get", path: "/api/v1/notes" }, nowS);
    expect(await verifySmoke(tok, h, { method: "GET", path: "/api/v1/notes" }, nowS)).toBe(true);
    expect(await verifySmoke(tok, h, { method: "POST", path: "/api/v1/notes" }, nowS)).toBe(false);
    expect(await verifySmoke(tok, h, { method: "GET", path: "/api/v1/workers" }, nowS)).toBe(false);
    expect(await verifySmoke(tok, h, { method: "GET", path: "/api/v1/notes/" }, nowS)).toBe(false);
  });

  it("binds the admin signature to the method, path, time, nonce and body", async () => {
    const token = "k".repeat(48);
    const sig = await signAdmin({ token, method: "post", path: "/api/_admin/provision", body: "{}", nowS });
    const check = (o: Partial<{ method: string; path: string; body: string; nowS: number; token: string; header: string }>) =>
      verifyAdmin({ token, header: sig, method: "POST", path: "/api/_admin/provision", body: "{}", nowS, ...o });
    const ok = async (o: Parameters<typeof check>[0]) => (await check(o)).ok;
    expect(await check({})).toEqual({ ok: true, ts: nowS, id: sig.split(".")[2]!.slice(0, 32) });
    expect(await ok({ method: "GET" })).toBe(false);
    expect(await ok({ path: "/api/_admin/ops" })).toBe(false);
    expect(await ok({ body: '{"force":true}' })).toBe(false);
    expect(await ok({ nowS: nowS + 301 })).toBe(false);
    expect(await ok({ token: "short" })).toBe(false);
    const [ts, nonce, mac] = sig.split(".");
    expect(await ok({ header: `${ts}.${"0".repeat(16)}.${mac}` })).toBe(false);
    expect(await ok({ header: `${ts}.${mac}` })).toBe(false);
    expect(nonce).toMatch(/^[0-9a-f]{16}$/);
  });

  it("makes every admin signature distinct, even for one request in one second, so each can be taken once", async () => {
    const token = "k".repeat(48);
    const a = await signAdmin({ token, method: "GET", path: "/api/_admin/ops", nowS });
    const b = await signAdmin({ token, method: "GET", path: "/api/_admin/ops", nowS });
    expect(a).not.toBe(b);
    const ids = await Promise.all([a, b].map(async (header) => verifyAdmin({ token, header, method: "GET", path: "/api/_admin/ops", body: "", nowS })));
    expect(ids.every((c) => c.ok)).toBe(true);
    expect(new Set(ids.map((c) => (c.ok ? c.id : ""))).size).toBe(2);
  });

  it("allows only clock skew ahead of now (30 s), on admin and smoke signatures alike", async () => {
    const token = "k".repeat(48);
    const ahead = (s: number) => signAdmin({ token, method: "GET", path: "/api/_admin/ops", nowS: nowS + s });
    const at = async (header: string) => (await verifyAdmin({ token, header, method: "GET", path: "/api/_admin/ops", body: "", nowS })).ok;
    expect(await at(await ahead(SIGNATURE_FUTURE_S))).toBe(true);
    expect(await at(await ahead(SIGNATURE_FUTURE_S + 1))).toBe(false);
    expect(await at(await ahead(SIGNATURE_WINDOW_S))).toBe(false);
    const req = { method: "GET", path: "/api/v1/health" };
    expect(await verifySmoke(token, await signSmoke(token, req, nowS + SIGNATURE_FUTURE_S), req, nowS)).toBe(true);
    expect(await verifySmoke(token, await signSmoke(token, req, nowS + SIGNATURE_FUTURE_S + 1), req, nowS)).toBe(false);
  });
});

describe("operator lease visitors", () => {
  it("are stable per name, distinct across names and admin tokens, and of the session cookie's shape", async () => {
    const token = "k".repeat(48);
    const a = await operatorVisitorId(token, "operator");
    expect(a).toMatch(/^vis_[0-9a-f]{32}$/);
    expect(await operatorVisitorId(token, "operator")).toBe(a);
    expect(await operatorVisitorId(token, "smoke")).not.toBe(a);
    expect(await operatorVisitorId("j".repeat(48), "operator")).not.toBe(a);
    const cookie = await sessionToken(SECRET, { visitor: a, slot: "slot-1", gen: 2, exp: nowS + 60 });
    expect(await readSession(SECRET, cookie, nowS)).toMatchObject({ ok: true, claims: { visitor: a } });
  });
});

describe("IP hash and MCP keys", () => {
  it("salts the IP hash by day and never returns the IP", async () => {
    const a = await ipHash(SECRET, "203.0.113.7", "2026-10-26");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toContain("203");
    expect(await ipHash(SECRET, "203.0.113.7", "2026-10-26")).toBe(a);
    expect(await ipHash(SECRET, "203.0.113.7", "2026-10-27")).not.toBe(a);
  });

  it("counts an IPv6 visitor once per /64, in any spelling, and an IPv4-mapped address as its IPv4 address", async () => {
    const day = "2026-10-26";
    const a = await ipHash(SECRET, "2001:db8:1:2::1", day);
    // Every address of one /64 is one visitor for leases, rate limits and caps.
    expect(await ipHash(SECRET, "2001:db8:1:2:ffff:ffff:ffff:fffe", day)).toBe(a);
    expect(await ipHash(SECRET, "2001:0DB8:0001:0002:0000:0000:0000:0042", day)).toBe(a);
    expect(await ipHash(SECRET, "[2001:db8:1:2::7]", day)).toBe(a);
    expect(await ipHash(SECRET, "2001:db8:1:2::9%eth0", day)).toBe(a);
    // The next /64 is someone else.
    expect(await ipHash(SECRET, "2001:db8:1:3::1", day)).not.toBe(a);
    expect(await ipHash(SECRET, "::ffff:203.0.113.7", day)).toBe(await ipHash(SECRET, "203.0.113.7", day));
    expect(ipKeyOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipKeyOf("::1")).toBe("0:0:0:0::/64");
    expect(ipKeyOf("198.51.100.4")).toBe("198.51.100.4");
    expect(ipKeyOf("not:an:address::x")).toBe("not:an:address::x");
  });

  it("routes MCP keys by their prefix and ids them without keeping them", async () => {
    const key = formatHostedMcpKey("slot-1", 7, randomAlnum(40));
    expect(parseHostedMcpKey(key)).toEqual({ slot: "slot-1", gen: 7 });
    expect(parseHostedMcpKey("weft_sk_" + "0".repeat(48))).toBeNull();
    const id = await mcpKeyId(key);
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    expect(key).not.toContain(id);
  });

  it("draws alphanumeric randomness without bias toward a few characters", () => {
    const s = randomAlnum(6200);
    expect(s).toMatch(/^[A-Za-z0-9]+$/);
    const counts = new Map<string, number>();
    for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(62);
    for (const n of counts.values()) expect(n).toBeLessThan(200);
  });
});
