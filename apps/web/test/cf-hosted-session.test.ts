// The hosted visitor session (track cf5-web; docs/cloudflare/design.md 6.2): the showcase and slot worlds, the feed
// started for a lease, the lease-ended screen, lease attempts that do not lease, and the human grant waiters. The
// fetch, the WebSocket and the window are fakes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LeaseResult, SessionStatus } from "../../../packages/contracts/src/ext/cf-hosted";
import { PollScheduler, setScheduler, type Timers } from "../src/lib/api/poll";
import { readLeaseHint } from "../src/lib/hosted/hint";
import {
  bootSession, dismissEnded, ensureHumanGrant, fmtLeft, grantFailed, hostedStore, leaseDeadline, markEnded, refreshSession, requestStart, resetHostedSession, startLease, verifyGrant,
} from "../src/lib/hosted/session";

const timers: Timers = { now: () => Date.now(), set: () => 0, clear: () => {} };
const lease = { slot: "slot-1", gen: 3, expiresAt: new Date(Date.now() + 3 * 3600_000).toISOString(), idleExpiresAt: new Date(Date.now() + 1800_000).toISOString(), resetsLeft: 3 };
const status = (p: Partial<SessionStatus> = {}): SessionStatus => ({
  world: "showcase", lease: null, grantExpiresAt: null, level: 0, pool: { size: 2, free: 1, waitlist: 0 }, provider: { id: "openai", reason: "default" }, agentEnabled: true, ...p,
});

let answers: Record<string, (body: unknown) => { status: number; body: unknown }> = {};
const calls: { method: string; path: string; body: unknown }[] = [];
const sockets: { url: string; closed: boolean }[] = [];
const storage = new Map<string, string>();
let sch: PollScheduler;

beforeEach(() => {
  calls.length = 0; sockets.length = 0; storage.clear(); answers = {};
  sch = new PollScheduler({}, timers);
  setScheduler(sch);
  const g = globalThis as Record<string, unknown>;
  g.window = { location: { protocol: "https:", host: "weft.example" }, localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) } };
  g.WebSocket = class { readyState = 0; onopen = null; onmessage = null; onclose = null; onerror = null; rec: { url: string; closed: boolean }; constructor(url: string) { this.rec = { url, closed: false }; sockets.push(this.rec); } send() {} close() { this.rec.closed = true; } };
  g.fetch = async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const a = answers[`${method} ${path}`];
    const r = a ? a(body) : { status: 404, body: { code: "NOPE", message: "no answer" } };
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
});
afterEach(() => {
  resetHostedSession();
  setScheduler(null);
  const g = globalThis as Record<string, unknown>;
  delete g.window; delete g.WebSocket; delete g.fetch;
});

describe("refreshSession", () => {
  it("on the showcase: no feed, the scheduler treats the world as immutable", async () => {
    answers["GET /api/_session"] = () => ({ status: 200, body: status({ level: 1 }) });
    await refreshSession();
    expect(hostedStore.get().status?.world).toBe("showcase");
    expect(sch.env.feed).toBe("showcase");
    expect(sch.env.level).toBe(1);
    expect(sockets).toHaveLength(0);
    expect(readLeaseHint()).toBeNull();
  });

  it("with a lease: opens the change feed to /api/_live and keeps the lease hint", async () => {
    answers["GET /api/_session"] = () => ({ status: 200, body: status({ world: "slot", lease }) });
    await refreshSession();
    expect(sockets.map((s) => s.url)).toEqual(["wss://weft.example/api/_live"]);
    expect(sch.env.feed).toBe("connecting");
    expect(readLeaseHint()).toMatchObject({ slot: "slot-1", gen: 3 });
  });

  it("shows the lease-ended screen when a held lease is gone", async () => {
    let s = status({ world: "slot", lease });
    answers["GET /api/_session"] = () => ({ status: 200, body: s });
    await refreshSession();
    s = status();
    await refreshSession();
    expect(hostedStore.get().ended).toBe("expired");
    expect(sockets[0]!.closed).toBe(true);
    expect(readLeaseHint()).toBeNull();
  });

  it("coalesces concurrent reads and records a failure", async () => {
    answers["GET /api/_session"] = () => ({ status: 503, body: { code: "AGENT_PAUSED", message: "down" } });
    await Promise.all([refreshSession(), refreshSession(), refreshSession()]);
    expect(calls).toHaveLength(1);
    expect(hostedStore.get()).toMatchObject({ loaded: true, error: "down", errorStatus: 503, errorCode: "AGENT_PAUSED" });
  });

  it("bootSession reads once and joins the scheduler without following commits", async () => {
    answers["GET /api/_session"] = () => ({ status: 200, body: status() });
    bootSession(); bootSession();
    await Promise.resolve();
    expect(calls.filter((c) => c.path === "/api/_session")).toHaveLength(1);
    expect(sch.size).toBe(1);
  });
});

describe("leases", () => {
  it("a leased answer switches the tab to the visitor's world", async () => {
    answers["POST /api/_session/lease"] = (b) => ({ status: 200, body: { status: "leased", ...lease, token: (b as { token: string }).token } });
    answers["GET /api/_session"] = () => ({ status: 200, body: status({ world: "slot", lease }) });
    requestStart("mutation");
    expect(hostedStore.get().startReason).toBe("mutation");
    const r = await startLease("tok-1");
    expect(r.status).toBe("leased");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/_session/lease", "GET /api/_session"]);
    expect(calls[0]!.body).toEqual({ token: "tok-1" });
    expect(hostedStore.get()).toMatchObject({ startReason: null, blocked: null, ended: null });
    expect(hostedStore.get().status?.world).toBe("slot");
  });

  it("keeps a refusal to show (waitlist, budget, IP limit, closed)", async () => {
    const results: LeaseResult[] = [
      { status: "waitlist", position: 2, poolSize: 2, etaMinutes: 12 },
      { status: "budget", reopensAt: "2026-10-27T00:00:00.000Z" },
      { status: "ip_limit", reopensAt: "2026-10-27T00:00:00.000Z" },
      { status: "closed", level: 3 },
    ];
    for (const res of results) {
      answers["POST /api/_session/lease"] = () => ({ status: 200, body: res });
      await startLease("tok");
      expect(hostedStore.get().blocked).toEqual(res);
    }
  });

  it("throws the gate code when the check fails", async () => {
    answers["POST /api/_session/lease"] = () => ({ status: 403, body: { _tag: "Forbidden", code: "TURNSTILE_FAILED", message: "nope" } });
    await expect(startLease("bad")).rejects.toMatchObject({ status: 403, code: "TURNSTILE_FAILED" });
  });

  it("markEnded and dismissEnded", async () => {
    answers["GET /api/_session"] = () => ({ status: 200, body: status() });
    markEnded("server");
    expect(hostedStore.get().ended).toBe("server");
    expect(sch.env.feed).toBe("showcase");
    dismissEnded();
    expect(hostedStore.get().ended).toBeNull();
  });
});

describe("the human grant", () => {
  it("one check serves every waiting mutation", async () => {
    answers["POST /api/_session/verify"] = () => ({ status: 200, body: { ok: true, grantExpiresAt: "2026-10-26T16:00:00.000Z" } });
    const a = ensureHumanGrant();
    const b = ensureHumanGrant();
    const ask = hostedStore.get().grantAsk;
    expect(ask).not.toBeNull();
    await verifyGrant("tok");
    await Promise.all([a, b]);
    expect(hostedStore.get().grantAsk).toBeNull();
    expect(calls).toEqual([{ method: "POST", path: "/api/_session/verify", body: { token: "tok" } }]);
  });

  it("a cancelled check rejects the waiters", async () => {
    const a = ensureHumanGrant();
    grantFailed("cancelled");
    await expect(a).rejects.toThrow("cancelled");
    expect(hostedStore.get().grantAsk).toBeNull();
  });
});

describe("countdown helpers", () => {
  it("the lease ends at the earlier deadline", () => {
    expect(leaseDeadline({ expiresAt: "2026-10-26T18:00:00.000Z", idleExpiresAt: "2026-10-26T16:00:00.000Z" })).toBe(Date.parse("2026-10-26T16:00:00.000Z"));
  });
  it("reads minutes and hours", () => {
    expect(fmtLeft(30_000)).toBe("under a minute left");
    expect(fmtLeft(42 * 60_000 + 5_000)).toBe("42 min left");
    expect(fmtLeft(65 * 60_000)).toBe("1 h 5 min left");
    expect(fmtLeft(180 * 60_000)).toBe("3 h left");
  });
});
