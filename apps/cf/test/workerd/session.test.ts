// Design 11.4: Turnstile with Cloudflare's published test secrets (1x...AA passes, 2x...AA fails), the session and
// human-grant cookies, a tampered cookie gets 401, mutations need a lease and a fresh grant (428), cross-origin
// mutations are refused, and the kill switch answers model-calling admissions 503.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOSTED_CONFIG_KEYS, HUMAN_GRANT_COOKIE, SESSION_COOKIE, type SessionStatus } from "../../src/shared/contracts";
import { Harness, TURNSTILE } from "../support/harness";

let h: Harness;
beforeAll(async () => {
  h = await Harness.start({ poolSize: 12 });
  await h.provision();
});
afterAll(async () => { await h?.close(); });

describe("session and Turnstile", () => {
  it("starts a lease behind the always-pass test secret and sets both cookies HttpOnly, Secure, SameSite=Strict", async () => {
    const v = h.visitor();
    const r = await v.fetch("/api/_session/lease", { method: "POST", body: JSON.stringify({ token: TURNSTILE.dummyToken }) });
    expect(r.status).toBe(200);
    const body = await r.json() as { status: string; slot: string; gen: number; expiresAt: string; idleExpiresAt: string; resetsLeft: number };
    expect(body).toMatchObject({ status: "leased", resetsLeft: 3 });
    expect(body.slot).toMatch(/^slot-\d+$/);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(179 * 60_000);
    expect(Date.parse(body.idleExpiresAt) - Date.now()).toBeLessThanOrEqual(30 * 60_000);
    const cookies = r.headers.getSetCookie();
    for (const name of [SESSION_COOKIE, HUMAN_GRANT_COOKIE]) {
      const c = cookies.find((x) => x.startsWith(`${name}=`))!;
      expect(c).toMatch(/; Path=\//);
      expect(c).toMatch(/; Secure/);
      expect(c).toMatch(/; HttpOnly/);
      expect(c).toMatch(/; SameSite=Strict/);
      expect(c).not.toMatch(/Domain=/i);
    }
    const st = await v.json<SessionStatus>("/api/_session");
    expect(st.body).toMatchObject({ world: "slot", lease: { slot: body.slot, gen: body.gen }, agentEnabled: true, pool: { size: 12 } });
    expect(st.body.grantExpiresAt).not.toBeNull();
  });

  it("returns the same lease when the visitor starts again", async () => {
    const v = h.visitor();
    const a = await v.lease();
    const b = await v.lease();
    expect(b).toMatchObject({ status: "leased", slot: a.slot, gen: a.gen });
  });

  it("refuses a lease start without a token or from another origin", async () => {
    const v = h.visitor();
    expect((await v.fetch("/api/_session/lease", { method: "POST", body: "{}" })).status).toBe(403);
    const cross = await v.fetch("/api/_session/lease", { method: "POST", body: JSON.stringify({ token: TURNSTILE.dummyToken }) }, { origin: "https://evil.example" });
    expect(cross.status).toBe(403);
    expect((await cross.json() as { code: string }).code).toBe("ORIGIN_REFUSED");
  });

  it("answers 401 SESSION_INVALID to a tampered cookie and clears it", async () => {
    const v = h.visitor();
    await v.lease();
    const real = v.jar.cookies.get(SESSION_COOKIE)!;
    const [ver, body, sig] = real.split(".");
    v.jar.cookies.set(SESSION_COOKIE, `${ver}.${body}x.${sig}`);
    const r = await v.fetch("/api/v1/notes");
    expect(r.status).toBe(401);
    expect((await r.json() as { code: string }).code).toBe("SESSION_INVALID");
    expect(v.jar.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  it("needs a lease for a mutation (409 LEASE_REQUIRED at the edge) and a fresh grant (428)", async () => {
    const anon = h.visitor();
    const r = await anon.fetch("/api/v1/notes", { method: "POST", body: JSON.stringify({ text: "x" }) });
    expect(r.status).toBe(409);
    expect((await r.json() as { code: string }).code).toBe("LEASE_REQUIRED");

    const v = h.visitor();
    await v.lease();
    v.jar.cookies.delete(HUMAN_GRANT_COOKIE);
    const noGrant = await v.fetch("/api/v1/notes", { method: "POST", body: JSON.stringify({ text: "x" }) });
    expect(noGrant.status).toBe(428);
    expect((await noGrant.json() as { code: string }).code).toBe("TURNSTILE_REQUIRED");
    const ver = await v.fetch("/api/_session/verify", { method: "POST", body: JSON.stringify({ token: TURNSTILE.dummyToken }) });
    expect(ver.status).toBe(200);
    expect(await ver.json()).toMatchObject({ ok: true });
    const ok = await v.fetch("/api/v1/notes", { method: "POST", body: JSON.stringify({ text: "after verify" }) });
    expect(ok.status).toBe(201);
  });

  it("refuses a grant minted for another visitor", async () => {
    const a = h.visitor();
    const b = h.visitor();
    await a.lease();
    await b.lease();
    b.jar.cookies.set(HUMAN_GRANT_COOKIE, a.jar.cookies.get(HUMAN_GRANT_COOKIE)!);
    expect((await b.fetch("/api/v1/notes", { method: "POST", body: JSON.stringify({ text: "x" }) })).status).toBe(428);
  });

  it("verify needs a lease", async () => {
    const r = await h.visitor().fetch("/api/_session/verify", { method: "POST", body: JSON.stringify({ token: TURNSTILE.dummyToken }) });
    expect(r.status).toBe(409);
  });

  it("pauses model-calling admissions with the kill switch (503 AGENT_PAUSED), other mutations still work", async () => {
    const env = await h.coreEnv();
    const v = h.visitor();
    await v.lease();
    await env.CONFIG.put(HOSTED_CONFIG_KEYS.agentEnabled, "false");
    try {
      // The front memoizes KV per isolate (200 ms in this harness, 60 s deployed): wait for the memo to see the flag.
      let status = 0;
      for (let i = 0; i < 20 && status !== 503; i++) {
        const r = await v.fetch("/api/v1/agent/runs", { method: "POST", body: JSON.stringify({ live: false }) });
        status = r.status;
        if (status === 503) expect((await r.json() as { code: string }).code).toBe("AGENT_PAUSED");
        else await new Promise((res) => setTimeout(res, 250));
      }
      expect(status).toBe(503);
      expect((await v.fetch("/api/v1/notes", { method: "POST", body: JSON.stringify({ text: "still fine" }) })).status).toBe(201);
      const st = await v.json<SessionStatus>("/api/_session");
      expect(st.body).toMatchObject({ agentEnabled: false, provider: { id: "scripted", reason: "paused" } });
    } finally {
      await env.CONFIG.delete(HOSTED_CONFIG_KEYS.agentEnabled);
    }
  }, 120_000);
});

describe("Turnstile failing secret", () => {
  let f: Harness;
  beforeAll(async () => { f = await Harness.start({ turnstileSecret: TURNSTILE.failSecret }); });
  afterAll(async () => { await f?.close(); });

  it("refuses the lease with the always-fail test secret (403 TURNSTILE_FAILED)", async () => {
    const r = await f.visitor().fetch("/api/_session/lease", { method: "POST", body: JSON.stringify({ token: TURNSTILE.dummyToken }) });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ code: "TURNSTILE_FAILED", _tag: "Forbidden" });
    expect(r.headers.getSetCookie()).toEqual([]);
  });
});
