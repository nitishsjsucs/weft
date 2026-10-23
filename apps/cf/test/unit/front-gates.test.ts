// The front Worker's gates on Node over a fake env (design 3.4, 6.2 and 6.3): what reaches a world, what is refused
// before anything is read, and which keys the Rate Limiting bindings are asked about. The Miniflare suite runs the
// same Worker in workerd; these cases need control the bindings there do not give (a body that never ends).
import { describe, expect, it } from "vitest";
import front, { showcaseMemo } from "../../src/front/index";
import { ADMIN_MAX_BODY_BYTES } from "../../src/shared/http";
import type { FrontEnv } from "../../src/shared/env";
import { signAdmin } from "../../src/shared/tokens";
import { formatHostedMcpKey, HOSTED_RATE_LIMITS } from "../../src/shared/contracts";

export interface FakeFront {
  env: FrontEnv;
  /** Requests that reached a world: the object name, the URL and the principal header it got. */
  worlds: { slot: string; url: string; principal: string | null }[];
  /** Every Rate Limiting call: the binding and the key. */
  limits: { binding: string; key: string }[];
  takes: { key: string; limit: number }[];
}

export function fakeFront(o: { pool?: number; worldBody?: (url: URL) => unknown; worldHeaders?: Record<string, string> } = {}): FakeFront {
  const out: FakeFront = { env: null as never, worlds: [], limits: [], takes: [] };
  const rl = (binding: string, max: number) => {
    const seen = new Map<string, number>();
    return { limit: async ({ key }: { key: string }) => { out.limits.push({ binding, key }); const n = (seen.get(key) ?? 0) + 1; seen.set(key, n); return { success: n <= max }; } };
  };
  const taken = new Map<string, number>();
  out.env = {
    WEFT_SESSION_SECRET: "s".repeat(64), WEFT_CTX_SECRET: "c".repeat(64), WEFT_PROXY_SECRET: "p".repeat(64), WEFT_ADMIN_TOKEN: "a".repeat(64),
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
