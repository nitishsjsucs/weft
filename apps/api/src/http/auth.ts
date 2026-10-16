// Initial auth (scaffold; t3-governance owns it from here). SPEC 10 and harness 6.6:
// Host allowlist, Origin check on mutations, x-api-key lookup (sha256), dev auth via x-weft-principal + x-weft-proxy,
// route auth flags from the contracts route table, and fixed-window rate limits.
import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { Forbidden, RateLimitExceeded, ROUTES, Unauthorized, type HumanSession, type RouteDef } from "@weft/contracts";
import { apiKeys, principals } from "@weft/db";
import { executorInternals } from "@weft/executor";
import type { WeftEnv } from "./context";

export function allowedHosts(ports: { api: number; web: number }, testMode: boolean): Set<string> {
  const s = new Set<string>();
  for (const h of ["127.0.0.1", "localhost"]) for (const p of [ports.api, ports.web]) s.add(`${h}:${p}`);
  if (testMode) s.add("localhost");
  return s;
}

const compiled = ROUTES.map((r) => ({ def: r as RouteDef, re: new RegExp(`^${r.path.replace(/:[A-Za-z]+/g, "[^/]+")}$`) }));
export function matchRoute(method: string, path: string): RouteDef | null {
  return compiled.find((x) => x.def.method === method && x.re.test(path))?.def ?? null;
}

export function hashApiKey(plaintext: string): string { return createHash("sha256").update(plaintext).digest("hex"); }

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

class Window {
  private hits = new Map<string, { start: number; n: number }>();
  constructor(private readonly limit: number, private readonly ms = 60_000) {}
  take(key: string, now = Date.now()): boolean {
    const w = this.hits.get(key);
    if (!w || now - w.start >= this.ms) { this.hits.set(key, { start: now, n: 1 }); return true; }
    w.n += 1;
    return w.n <= this.limit;
  }
}

export function auth(): MiddlewareHandler<WeftEnv> {
  const keyLimit = new Window(60);
  const uiLimit = new Window(1200);
  const primed = new WeakSet<object>();
  return async (c, next) => {
    const weft = c.var.weft;
    // The redactor learns the proxy secret once per executor, and every API key plaintext it sees (harness 6.4).
    const internals = (() => { try { return executorInternals(weft.executor); } catch { return null; } })();
    if (internals && !primed.has(weft.executor)) { internals.addSecret(weft.proxySecret); primed.add(weft.executor); }
    const url = new URL(c.req.url);
    const host = c.req.header("host") ?? url.host;
    const hosts = allowedHosts(weft.ports, weft.testMode);
    if (!hosts.has(host)) throw new Forbidden("Host not allowed");
    // The web proxy rewrites Host to the API's own address; the browser's Host arrives as x-forwarded-host and must
    // pass the same allowlist, or a DNS-rebound page could read the API through the proxy (SPEC 10).
    const forwarded = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
    if (forwarded && !hosts.has(forwarded)) throw new Forbidden("Forwarded host not allowed");
    const method = c.req.method;
    const mutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    const origin = c.req.header("origin");
    if (mutating && origin) {
      let oh = "";
      try { oh = new URL(origin).host; } catch { /* invalid origin */ }
      if (!hosts.has(oh)) throw new Forbidden("Origin not allowed");
    }

    const route = matchRoute(method, url.pathname);
    let session: HumanSession | null = null;
    const apiKey = c.req.header("x-api-key");
    if (apiKey) {
      const [row] = await weft.db.select().from(apiKeys).where(and(eq(apiKeys.hash, hashApiKey(apiKey)), isNull(apiKeys.revokedAt))).limit(1);
      if (!row) throw new Unauthorized("Unknown or revoked API key");
      internals?.addSecret(apiKey);
      if (!keyLimit.take(row.id)) throw new RateLimitExceeded();
      session = { principalId: row.principalId, companyId: row.companyId, via: "api_key", keyScope: row.scope as HumanSession["keyScope"] };
    } else {
      const principalId = c.req.header("x-weft-principal");
      const proxy = c.req.header("x-weft-proxy");
      const devAuth = process.env.WEFT_DEV_AUTH === "1" || weft.testMode;
      if (principalId && devAuth) {
        if (!proxy || !safeEqual(proxy, weft.proxySecret)) throw new Unauthorized("x-weft-principal requires a valid x-weft-proxy");
        const [p] = await weft.db.select().from(principals).where(eq(principals.id, principalId)).limit(1);
        if (!p || p.kind !== "human") throw new Unauthorized("Unknown human principal");
        if (!uiLimit.take(p.id)) throw new RateLimitExceeded();
        session = { principalId: p.id, companyId: p.companyId, via: "ui", keyScope: null };
        // w2-onboarding: the new hire persona (role employee) signs in only to its own portal.
        if (p.role === "employee" && !url.pathname.startsWith("/v1/portal/")) throw new Forbidden("The new hire persona can use only the portal", { code: "PORTAL_ONLY" });
      }
    }

    if (route && route.auth !== "public") {
      if (!session) throw new Unauthorized();
      if (route.auth === "ui_only" && session.via !== "ui") throw new Forbidden("UI_SESSION_REQUIRED", { code: "UI_SESSION_REQUIRED" });
      if (route.auth === "not_mcp" && session.keyScope === "mcp") throw new Forbidden("mcp-scope keys cannot use this route");
    }
    c.set("session", session);
    await next();
  };
}
