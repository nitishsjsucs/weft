// The front Worker's gates on Node over a fake env (design 3.4, 6.2 and 6.3): what reaches a world, what is refused
// before anything is read, and which keys the Rate Limiting bindings are asked about. The Miniflare suite runs the
// same Worker in workerd; these cases need control the bindings there do not give (a body that never ends).
import { describe, expect, it } from "vitest";
import front, { showcaseMemo } from "../../src/front/index";
import { ADMIN_MAX_BODY_BYTES } from "../../src/shared/http";
import type { FrontEnv } from "../../src/shared/env";
import { grantToken, ipHash, readSession, sessionToken, signAdmin, signSmoke } from "../../src/shared/tokens";
import { utcDay } from "../../src/shared/http";
import { formatHostedMcpKey, HOSTED_RATE_LIMITS, HUMAN_GRANT_COOKIE, SESSION_COOKIE } from "../../src/shared/contracts";

export interface FakeFront {
  env: FrontEnv;
  /** Requests that reached a world: the object name, the URL and the principal header it got. */
  worlds: { slot: string; url: string; principal: string | null }[];
  /** Every Rate Limiting call: the binding and the key. */
  limits: { binding: string; key: string }[];
  takes: { key: string; limit: number }[];
}

export function fakeFront(o: { pool?: number; worldBody?: (url: URL) => unknown; worldHeaders?: Record<string, string>; status?: (input: { visitor: string | null; slot?: string | null; gen?: number | null }) => unknown } = {}): FakeFront {
  const out: FakeFront = { env: null as never, worlds: [], limits: [], takes: [] };
  const rl = (binding: string, max: number) => {
    const seen = new Map<string, number>();
    return { limit: async ({ key }: { key: string }) => { out.limits.push({ binding, key }); const n = (seen.get(key) ?? 0) + 1; seen.set(key, n); return { success: n <= max }; } };
  };
  const taken = new Map<string, number>();
  out.env = {
    WEFT_SESSION_SECRET: "s".repeat(64), WEFT_CTX_SECRET: "c".repeat(64), WEFT_PROXY_SECRET: "p".repeat(64), WEFT_ADMIN_TOKEN: "a".repeat(64), WEFT_SMOKE_TOKEN: "m".repeat(64),
    WEFT_PUBLIC_ORIGIN: "https://weft.test", WEFT_POOL_SIZE: String(o.pool ?? 2), WEFT_CONFIG_MEMO_MS: "0",
    RL_API: rl("RL_API", 600), RL_MUTATE: rl("RL_MUTATE", 30), RL_MCP: rl("RL_MCP", 60),
    CONFIG: { get: async (keys: string[] | string) => (Array.isArray(keys) ? new Map(keys.map((k) => [k, null])) : null) },
    COMPANY: {
      idFromName: (n: string) => n,
      get: (slot: string) => ({
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          out.worlds.push({ slot, url: req.url, principal: req.headers.get("x-weft-principal") });
          return new Response(JSON.stringify(o.worldBody?.(url) ?? { slot, path: url.pathname }), { status: 200, headers: { "content-type": "application/json", ...o.worldHeaders } });
        },
      }),
    },
    LOBBY: {
      idFromName: (n: string) => n,
      get: () => ({
        take: async ({ key, limit }: { key: string; limit: number }) => {
          out.takes.push({ key, limit });
          const n = (taken.get(key) ?? 0) + 1;
          taken.set(key, n);
          return { ok: n <= limit, used: n, left: Math.max(0, limit - n) };
        },
        ops: async () => ({ ok: true }),
        status: async (input: { visitor: string | null; slot?: string | null; gen?: number | null }) => o.status?.(input) ?? { level: 0, pool: { size: 2, free: 2, waitlist: 0 }, lease: null, waitlistPosition: null, worldProvider: null },
        sweep: async () => ({ released: 0 }),
      }),
    },
    SPEND: { idFromName: (n: string) => n, get: () => ({ status: async () => ({}) }) },
  } as unknown as FrontEnv;
  return out;
}

export const call = (f: FakeFront, path: string, init: RequestInit & { ip?: string } = {}) => {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", init.ip ?? "203.0.113.10");
  return front.fetch(new Request(`https://weft.test${path}`, { ...init, headers } as RequestInit), f.env);
};

/** A body that sends `bytes` and then never ends (a client that keeps the request open). */
function stalling(bytes: number): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(c) {
      if (sent) return new Promise<void>(() => undefined);
      sent = true;
      c.enqueue(new Uint8Array(bytes).fill(0x20));
      return undefined;
    },
  });
}

const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms))]);

describe("admin bodies", () => {
  it("refuse a declared Content-Length over 64 KB before reading the body", async () => {
    const f = fakeFront();
    const sig = await signAdmin({ token: f.env.WEFT_ADMIN_TOKEN!, method: "POST", path: "/api/_admin/provision", body: "{}" });
    const res = await within(call(f, "/api/_admin/provision", {
      method: "POST", body: stalling(10), duplex: "half",
      headers: { "x-weft-admin": sig, "content-length": String(ADMIN_MAX_BODY_BYTES + 1), "content-type": "application/json" },
    } as RequestInit), 2_000);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "TOO_LARGE" });
    expect(f.takes).toEqual([]);
  });

  it("stop reading a chunked body as soon as it passes 64 KB", async () => {
    const f = fakeFront();
    const res = await within(call(f, "/api/_admin/provision", { method: "POST", body: stalling(ADMIN_MAX_BODY_BYTES + 1), duplex: "half" } as RequestInit), 2_000);
    expect(res.status).toBe(413);
  });

  it("still read a small signed body", async () => {
    const f = fakeFront();
    const body = JSON.stringify({ slots: ["slot-1"] });
    const sig = await signAdmin({ token: f.env.WEFT_ADMIN_TOKEN!, method: "POST", path: "/api/_admin/sweep", body });
    const res = await call(f, "/api/_admin/sweep", { method: "POST", body, headers: { "x-weft-admin": sig, "content-type": "application/json" } });
    expect(res.status).toBe(200);
  });
});

describe("lease, verify and reset bodies", () => {
  const visitor = "vis_" + "d".repeat(32);
  const leased = async (f: FakeFront) => {
    const nowS = Math.floor(Date.now() / 1000);
    return `${SESSION_COOKIE}=${await sessionToken(f.env.WEFT_SESSION_SECRET!, { visitor, slot: "slot-1", gen: 1, exp: nowS + 600 })}; ${HUMAN_GRANT_COOKIE}=${await grantToken(f.env.WEFT_SESSION_SECRET!, { visitor, exp: nowS + 600 })}`;
  };
  const cases = [
    { path: "/api/_session/lease", code: "TURNSTILE_FAILED", session: false },
    { path: "/api/_session/verify", code: "TURNSTILE_FAILED", session: true },
    { path: "/api/v1/sim/reset", code: "BAD_BODY", session: true },
  ];

  it("stop reading a chunked body (no Content-Length) as soon as it passes 16 KB", async () => {
    for (const c of cases) {
      const f = fakeFront();
      const headers: Record<string, string> = { origin: "https://weft.test", "content-type": "application/json" };
      if (c.session) headers.cookie = await leased(f);
      const res = await within(call(f, c.path, { method: "POST", body: stalling(16 * 1024 + 1), duplex: "half", headers } as RequestInit), 2_000);
      expect(await res.json(), c.path).toMatchObject({ code: c.code });
      expect(f.worlds, c.path).toEqual([]);
    }
  });

  it("refuse a declared Content-Length over 16 KB before reading the body", async () => {
    for (const c of cases) {
      const f = fakeFront();
      const headers: Record<string, string> = { origin: "https://weft.test", "content-type": "application/json", "content-length": String(16 * 1024 + 1) };
      if (c.session) headers.cookie = await leased(f);
      const res = await within(call(f, c.path, { method: "POST", body: stalling(10), duplex: "half", headers } as RequestInit), 2_000);
      expect(await res.json(), c.path).toMatchObject({ code: c.code });
    }
  });
});

describe("/mcp", () => {
  const key = (slot: string, rand = "A".repeat(24)) => formatHostedMcpKey(slot, 1, rand);
  const mcpCall = (f: FakeFront, k: string, ip?: string) => call(f, "/mcp", { method: "POST", body: "{}", headers: { authorization: `Bearer ${k}` }, ip });

  it("routes only a real pool slot's key, so a key cannot name a Durable Object into existence", async () => {
    const f = fakeFront({ pool: 2 });
    expect((await mcpCall(f, key("slot-1"))).status).toBe(200);
    expect((await mcpCall(f, key("slot-2"))).status).toBe(200);
    for (const slot of ["slot-3", "slot-99", "slot-0", "slot-01", "slot-smoke", "showcase", "conformance", "x"]) {
      const r = await mcpCall(f, key(slot));
      expect(r.status, slot).toBe(401);
      expect(await r.json(), slot).toMatchObject({ code: "MCP_KEY_REQUIRED" });
    }
    expect(f.worlds.map((w) => w.slot)).toEqual(["slot-1", "slot-2"]);
  });

  it("limits random well-formed keys from one address by its IP hash, not only per key", async () => {
    const f = fakeFront({ pool: 2 });
    const statuses: number[] = [];
    for (let i = 0; i < HOSTED_RATE_LIMITS.RL_MCP.limit + 5; i++) statuses.push((await mcpCall(f, key("slot-1", `K${String(i).padStart(23, "0")}`), "203.0.113.50")).status);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    expect(f.worlds).toHaveLength(HOSTED_RATE_LIMITS.RL_MCP.limit);
    // Another address has its own allowance; every key was also checked on its own.
    expect((await mcpCall(f, key("slot-1", "Z".repeat(24)), "203.0.113.51")).status).toBe(200);
    expect(f.limits.filter((l) => l.binding === "RL_MCP" && l.key.startsWith("mcp-ip:"))).toHaveLength(HOSTED_RATE_LIMITS.RL_MCP.limit + 6);
    expect(f.limits.filter((l) => l.binding === "RL_MCP" && l.key.startsWith("mcp:"))).toHaveLength(HOSTED_RATE_LIMITS.RL_MCP.limit + 1);
  });
});

describe("the showcase memo", () => {
  it("answers cache-busting queries and made-up principals from the memo, asking the showcase the normalized read", async () => {
    showcaseMemo.clear();
    const f = fakeFront({ worldHeaders: { "cache-control": "private, no-cache" } });
    const get = (path: string, principal?: string) => call(f, path, { headers: principal ? { "x-weft-principal": principal } : {} });
    const first = await get("/api/v1/time-off/requests?status=pending&cb=1", "usr_dana");
    expect(first.headers.get("x-weft-memo")).toBe("miss");
    for (const path of ["/api/v1/time-off/requests?cb=2&status=pending", "/api/v1/time-off/requests?status=pending&x=y&status=other"]) {
      const r = await get(path, "usr_dana");
      expect(r.headers.get("x-weft-memo"), path).toBe("hit");
      expect(r.headers.get("cache-control"), path).toBe("private, no-cache");
    }
    expect(f.worlds).toHaveLength(1);
    expect(new URL(f.worlds[0]!.url).search).toBe("?status=pending");
    // Junk principals are one key, and the showcase never sees the junk header.
    for (const p of ["usr_evil, usr_dana", "x".repeat(40), "vis_123"]) await get("/api/v1/workers", p);
    await get("/api/v1/workers");
    expect(f.worlds.slice(1).map((w) => w.principal)).toEqual([null]);
    // A persona is its own read.
    await get("/api/v1/workers", "usr_sam");
    expect(f.worlds.at(-1)).toMatchObject({ slot: "showcase", principal: "usr_sam" });
    expect(f.worlds).toHaveLength(3);
  });
});

describe("RL_MUTATE", () => {
  it("keys a valid smoke visit apart from its address, and a forged smoke header by the address", async () => {
    const f = fakeFront();
    const ip = "203.0.113.70";
    const hash = await ipHash(f.env.WEFT_SESSION_SECRET!, ip, utcDay());
    const post = (headers: Record<string, string>) => call(f, "/api/v1/notes", { method: "POST", body: "{}", ip, headers: { "content-type": "application/json", origin: "https://weft.test", ...headers } });
    const signed = await post({ "x-weft-smoke": await signSmoke(f.env.WEFT_SMOKE_TOKEN!, { method: "POST", path: "/api/v1/notes" }) });
    expect(signed.status).toBe(200);
    expect(f.worlds.at(-1)!.slot).toBe("slot-smoke");
    // A leased visitor from the same address whose request carries a forged smoke header is that visitor.
    const visitor = "vis_" + "b".repeat(32);
    const nowS = Math.floor(Date.now() / 1000);
    const cookie = `${SESSION_COOKIE}=${await sessionToken(f.env.WEFT_SESSION_SECRET!, { visitor, slot: "slot-1", gen: 1, exp: nowS + 600 })}; ${HUMAN_GRANT_COOKIE}=${await grantToken(f.env.WEFT_SESSION_SECRET!, { visitor, exp: nowS + 600 })}`;
    const forged = await post({ cookie, "x-weft-smoke": `${nowS}.${"0".repeat(64)}` });
    expect(forged.status).toBe(200);
    expect(f.worlds.at(-1)!.slot).toBe("slot-1");
    expect(f.limits.filter((l) => l.binding === "RL_MUTATE").map((l) => l.key)).toEqual(["mut:smoke", `mut:${hash}`]);
  });

  it("lets the smoke's mutations leave the operator's own address its whole allowance", async () => {
    const f = fakeFront();
    const ip = "203.0.113.71";
    for (let i = 0; i < HOSTED_RATE_LIMITS.RL_MUTATE.limit; i++) {
      const r = await call(f, "/api/v1/notes", { method: "POST", body: "{}", ip, headers: { "x-weft-smoke": await signSmoke(f.env.WEFT_SMOKE_TOKEN!, { method: "POST", path: "/api/v1/notes" }) } });
      expect(r.status).toBe(200);
    }
    const visitor = "vis_" + "c".repeat(32);
    const nowS = Math.floor(Date.now() / 1000);
    const cookie = `${SESSION_COOKIE}=${await sessionToken(f.env.WEFT_SESSION_SECRET!, { visitor, slot: "slot-2", gen: 1, exp: nowS + 600 })}; ${HUMAN_GRANT_COOKIE}=${await grantToken(f.env.WEFT_SESSION_SECRET!, { visitor, exp: nowS + 600 })}`;
    const mine = await call(f, "/api/v1/notes", { method: "POST", body: "{}", ip, headers: { cookie, origin: "https://weft.test" } });
    expect(mine.status).toBe(200);
  });
});

describe("GET /api/_session after a hosted reset", () => {
  const visitor = "vis_" + "e".repeat(32);
  const lease = (gen: number) => ({ slot: "slot-1", gen, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), idleExpiresAt: new Date(Date.now() + 1_800_000).toISOString(), resetsLeft: 2 });
  const status = (gen: number | null) => ({ level: 0, pool: { size: 2, free: 1, waitlist: 0 }, lease: gen === null ? null : lease(gen), waitlistPosition: null, worldProvider: null });
  const sessionWith = async (f: FakeFront, gen: number) => {
    const nowS = Math.floor(Date.now() / 1000);
    return call(f, "/api/_session", { headers: { cookie: `${SESSION_COOKIE}=${await sessionToken(f.env.WEFT_SESSION_SECRET!, { visitor, slot: "slot-1", gen, exp: nowS + 600 })}` } });
  };

  it("reissues the session cookie for the lease's newer generation instead of clearing the one the reset set", async () => {
    const asked: unknown[] = [];
    const f = fakeFront({ status: (input) => { asked.push(input); return status(4); } });
    const r = await sessionWith(f, 3);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ world: "slot", lease: { slot: "slot-1", gen: 4 } });
    expect(asked).toEqual([{ visitor, slot: "slot-1", gen: 3 }]);
    const set = r.headers.getSetCookie();
    expect(set).toHaveLength(1);
    expect(set[0]).toMatch(new RegExp(`^${SESSION_COOKIE}=v1\\.`));
    expect(set[0]).not.toContain("Max-Age=0");
    const token = set[0]!.split(";")[0]!.slice(SESSION_COOKIE.length + 1);
    expect(await readSession(f.env.WEFT_SESSION_SECRET!, token)).toMatchObject({ ok: true, claims: { visitor, slot: "slot-1", gen: 4 } });
  });

  it("sets nothing when the cookie is current, and clears both cookies when the Lobby has no lease", async () => {
    expect((await sessionWith(fakeFront({ status: () => status(3) }), 3)).headers.getSetCookie()).toEqual([]);
    const gone = (await sessionWith(fakeFront({ status: () => status(null) }), 3)).headers.getSetCookie();
    expect(gone).toHaveLength(2);
    expect(gone.every((c) => c.includes("Max-Age=0"))).toBe(true);
  });
});
