// Design 11.4: Turnstile with Cloudflare's published test secrets (1x...AA passes, 2x...AA fails) against the local
// siteverify stub (one opt-in case asks Cloudflare's real endpoint), the session and human-grant cookies, a tampered
// cookie gets 401, mutations need a lease and a fresh grant (428), cross-origin mutations are refused, the kill switch
// answers model-calling admissions 503, the session reports the world's model switch, and the operator lease
// (POST /api/_admin/lease and /api/_admin/grant) is the admin signature's alone.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DO_NAMES, HOSTED_CONFIG_KEYS, HUMAN_GRANT_COOKIE, SESSION_COOKIE, type SessionStatus } from "../../src/shared/contracts";
import { signAdmin } from "../../src/shared/tokens";
import { Harness, TURNSTILE } from "../support/harness";

let h: Harness;
beforeAll(async () => {
  h = await Harness.start({ poolSize: 12 });
  await h.provision();
});
afterAll(async () => { await h?.close(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Ends every lease, so a describe starts with the whole pool free. */
async function releaseAll(): Promise<void> {
  const env = await h.coreEnv();
  const lobby = env.LOBBY.get(env.LOBBY.idFromName(DO_NAMES.lobby));
  for (const x of (await h.ops()).lobby.leases) await lobby.release({ slot: x.slot, reason: "test" });
}

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

  it("verifies against the local siteverify stub: the visitor's IP, the test secret, a fresh UUID key per check", async () => {
    const stub = h.siteverify!;
    const before = stub.calls.length;
    const v = h.visitor("198.51.100.199");
    await v.lease();
    expect((await v.fetch("/api/_session/verify", { method: "POST", body: JSON.stringify({ token: TURNSTILE.dummyToken }) })).status).toBe(200);
    const calls = stub.calls.slice(before);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c).toMatchObject({ secretKind: "pass", response: TURNSTILE.dummyToken, remoteip: "198.51.100.199" });
      expect(c.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
    expect(calls[0]!.idempotencyKey).not.toBe(calls[1]!.idempotencyKey);
  });

  it("refuses a token the test secret does not accept (only the dummy token passes)", async () => {
    const r = await h.visitor().fetch("/api/_session/lease", { method: "POST", body: JSON.stringify({ token: "a.real.looking.token" }) });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ code: "TURNSTILE_FAILED" });
    expect(r.headers.getSetCookie()).toEqual([]);
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

describe("the session's provider", () => {
  beforeAll(async () => {
    await releaseAll();
    await sleep(400);   // past the front's KV memo (200 ms here), so the kill switch case above is gone
  });

  it("reports the world's model switch as reason world, and the default once it is cleared", async () => {
    const v = h.visitor();
    expect((await v.lease()).status).toBe("leased");
    const provider = async () => (await v.json<SessionStatus>("/api/_session")).body.provider;
    expect(await provider()).toEqual({ id: "openai", reason: "default" });
    expect((await v.fetch("/api/_hosted/model", { method: "PUT", body: JSON.stringify({ provider: "workers_ai" }) })).status).toBe(200);
    expect(await provider()).toEqual({ id: "workers_ai", reason: "world" });
    expect((await v.fetch("/api/_hosted/model", { method: "PUT", body: JSON.stringify({ provider: "scripted" }) })).status).toBe(200);
    expect(await provider()).toEqual({ id: "scripted", reason: "world" });
    expect((await v.fetch("/api/_hosted/model", { method: "PUT", body: JSON.stringify({ provider: null }) })).status).toBe(200);
    expect(await provider()).toEqual({ id: "openai", reason: "default" });
    // Another visitor's world, and the showcase, keep the default.
    const other = h.visitor();
    await other.lease();
    await v.fetch("/api/_hosted/model", { method: "PUT", body: JSON.stringify({ provider: "workers_ai" }) });
    expect((await other.json<SessionStatus>("/api/_session")).body.provider).toEqual({ id: "openai", reason: "default" });
    expect((await h.visitor().json<SessionStatus>("/api/_session")).body.provider).toEqual({ id: "openai", reason: "default" });
  });
});

describe("the operator lease", () => {
  const LEASE = "/api/_admin/lease";
  let leasesBefore = 0;
  beforeAll(async () => {
    await releaseAll();
    leasesBefore = (await h.ops()).lobby.leases.length;
  });
  const signed = async (o: { token?: string; nowS?: number; path?: string; body?: string } = {}) => ({
    "x-weft-admin": await signAdmin({ token: o.token ?? h.secrets.admin, method: "POST", path: o.path ?? LEASE, body: o.body ?? "{}", nowS: o.nowS }),
    "content-type": "application/json",
  });

  it("refuses no signature, a wrong token, a stale timestamp, another path's or another body's signature", async () => {
    const v = h.visitor("198.51.100.180");
    const tries: Record<string, HeadersInit> = {
      none: { "content-type": "application/json" },
      wrong: await signed({ token: "w".repeat(64) }),
      stale: await signed({ nowS: Math.floor(Date.now() / 1000) - 600 }),
      future: await signed({ nowS: Math.floor(Date.now() / 1000) + 600 }),
      path: await signed({ path: "/api/_admin/grant" }),
      body: await signed({ body: '{"name":"other"}' }),
    };
    for (const [why, headers] of Object.entries(tries)) {
      const r = await v.fetch(LEASE, { method: "POST", body: "{}", headers }, { origin: null });
      expect(r.status, why).toBe(401);
      expect(await r.json(), why).toMatchObject({ code: "ADMIN_SIGNATURE" });
      expect(r.headers.getSetCookie(), why).toEqual([]);
    }
    expect(v.jar.cookies.size).toBe(0);
    expect((await h.ops()).lobby.leases.length).toBe(leasesBefore);
  });

  it("leases a pool slot with both cookies, no Turnstile, and returns the same lease when asked again", async () => {
    const stub = h.siteverify!;
    const calls = stub.calls.length;
    const v = h.visitor("198.51.100.181");
    const l = await v.operatorLease("op-a");
    expect(l).toMatchObject({ status: "leased", operator: "op-a" });
    expect(l.slot).toMatch(/^slot-\d+$/);
    expect(stub.calls.length).toBe(calls);
    expect([...v.jar.cookies.keys()].sort()).toEqual([SESSION_COOKIE, HUMAN_GRANT_COOKIE].sort());
    const st = await v.json<SessionStatus>("/api/_session");
    expect(st.body).toMatchObject({ world: "slot", lease: { slot: l.slot, gen: l.gen } });
    expect(st.body.grantExpiresAt).not.toBeNull();
    expect((await v.fetch("/api/v1/notes", { method: "POST", body: JSON.stringify({ text: "operator note" }) })).status).toBe(201);
    // Another client asking for the same name gets the same lease (and its own copy of the cookies).
    const again = h.visitor("198.51.100.182");
    expect(await again.operatorLease("op-a")).toMatchObject({ status: "leased", slot: l.slot, gen: l.gen });
    expect((await again.json<{ text: string }[]>("/api/v1/notes")).body.map((n) => n.text)).toContain("operator note");
    // Other names are other leases.
    const b = await h.visitor("198.51.100.183").operatorLease("op-b");
    expect(b.slot).not.toBe(l.slot);
    expect((await h.admin("POST", LEASE, { name: "Not A Name" })).status).toBe(400);
  });

  it("needs the grant for mutations like any lease: without it 428, with POST /api/_admin/grant 201", async () => {
    const v = h.visitor("198.51.100.184");
    await v.operatorLease("op-grant");
    v.jar.cookies.delete(HUMAN_GRANT_COOKIE);
    const noGrant = await v.fetch("/api/v1/notes", { method: "POST", body: JSON.stringify({ text: "x" }) });
    expect(noGrant.status).toBe(428);
    expect(await noGrant.json()).toMatchObject({ code: "TURNSTILE_REQUIRED" });
    const g = await h.admin("POST", "/api/_admin/grant", { name: "op-grant" }, { ip: v.ip, jar: v.jar });
    expect(g.status).toBe(200);
    expect(await g.json()).toMatchObject({ ok: true });
    expect(v.jar.cookies.has(HUMAN_GRANT_COOKIE)).toBe(true);
    expect((await v.fetch("/api/v1/notes", { method: "POST", body: JSON.stringify({ text: "after grant" }) })).status).toBe(201);
    // The grant route serves the operator's own session only, and never starts a lease.
    const visitor = h.visitor("198.51.100.185");
    await visitor.lease();
    expect((await h.admin("POST", "/api/_admin/grant", { name: "op-grant" }, { ip: visitor.ip, jar: visitor.jar })).status).toBe(409);
    expect((await h.admin("POST", "/api/_admin/grant", { name: "op-never-leased" })).status).toBe(409);
  });

  it("ends like any lease: the cookie stops, the grant route answers LEASE_ENDED, the slot is reset", async () => {
    const env = await h.coreEnv();
    const v = h.visitor("198.51.100.186");
    const l = await v.operatorLease("op-end");
    expect(l.status).toBe("leased");
    await v.fetch("/api/v1/notes", { method: "POST", body: JSON.stringify({ text: "operator was here" }) });
    const oldCookie = v.jar.cookies.get(SESSION_COOKIE)!;
    await env.LOBBY.get(env.LOBBY.idFromName(DO_NAMES.lobby)).release({ slot: l.slot!, reason: "test" });
    const stale = h.visitor(v.ip);
    stale.jar.cookies.set(SESSION_COOKIE, oldCookie);
    expect(await stale.json("/api/v1/notes")).toMatchObject({ status: 409, body: { code: "LEASE_ENDED" } });
    const g = await h.admin("POST", "/api/_admin/grant", { name: "op-end" }, { ip: v.ip, jar: v.jar });
    expect(g.status).toBe(409);
    expect(await g.json()).toMatchObject({ code: "LEASE_ENDED" });
    expect(v.jar.cookies.has(SESSION_COOKIE)).toBe(false);
    const next = await v.operatorLease("op-end");
    expect(next.status).toBe("leased");
    expect((await v.json<{ text: string }[]>("/api/v1/notes")).body.map((n) => n.text)).not.toContain("operator was here");
  });

  it("holds an MCP key on its pool slot (scenario 8 on the deployed URL) that dies with the lease", async () => {
    const env = await h.coreEnv();
    const v = h.visitor("198.51.100.187");
    const l = await v.operatorLease("op-mcp");
    expect(l.status).toBe("leased");
    const k = await v.fetch("/api/_hosted/mcp-key", { method: "POST" });
    expect(k.status).toBe(201);
    const { key } = await k.json() as { key: string };
    const mcp = () => h.fetch("/mcp", { method: "POST", body: JSON.stringify({ method: "tools/list" }), headers: { authorization: `Bearer ${key}` } }, { origin: null });
    const ok = await mcp();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ mcp: true, world: { slot: l.slot, gen: l.gen } });
    await env.LOBBY.get(env.LOBBY.idFromName(DO_NAMES.lobby)).release({ slot: l.slot!, reason: "test" });
    expect((await mcp()).status).toBe(409);
  });
});

// Opt-in (WEFT_CF_REAL_SITEVERIFY=1, needs outbound HTTPS from workerd): the same lease against Cloudflare's own
// siteverify with the always-pass test secret, so the stub's semantics stay pinned to the real endpoint.
describe.skipIf(process.env.WEFT_CF_REAL_SITEVERIFY !== "1")("Turnstile against Cloudflare's siteverify", () => {
  let r: Harness;
  beforeAll(async () => { r = await Harness.start({ realSiteverify: true, poolSize: 1 }); await r.provision(); });
  afterAll(async () => { await r?.close(); });

  it("leases with the always-pass test secret and the dummy token", async () => {
    expect(await r.visitor().lease()).toMatchObject({ status: "leased", slot: "slot-1" });
  });
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
    expect(f.siteverify!.calls.at(-1)).toMatchObject({ secretKind: "fail" });
  });

  it("fails a lease helper loudly, naming the siteverify that refused", async () => {
    await expect(f.visitor().lease()).rejects.toThrow(/lease answered 403 .*TURNSTILE_FAILED.*siteverify stub \(fail\)/);
  });
});
