// Design 11.4: lease assign, expiry and reset; 20 concurrent starts get unique slots; the per-IP lease cap, also
// under concurrent starts; the operator lease under the same pool, cap and expiry; isolation (a write in one slot is
// invisible in another; an old cookie generation gets 409); showcase mutations get 409 at the edge and in the Durable
// Object.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DO_NAMES, HOSTED_SETTINGS, SESSION_COOKIE, TRUST_HEADERS } from "../../src/shared/contracts";
import { utcDay } from "../../src/shared/http";
import { ipHash, signCtx } from "../../src/shared/tokens";
import { Harness, ORIGIN, type Visitor } from "../support/harness";

let h: Harness;
const POOL = 4;
beforeAll(async () => {
  h = await Harness.start({ poolSize: POOL });
  await h.provision();
});
afterAll(async () => { await h?.close(); });

const lobby = async () => (await h.coreEnv()).LOBBY.get((await h.coreEnv()).LOBBY.idFromName(DO_NAMES.lobby));
async function releaseAll(): Promise<void> {
  const l = await lobby();
  for (const x of (await h.ops()).lobby.leases) await l.release({ slot: x.slot, reason: "test" });
}
const note = (v: Visitor, text: string) => v.fetch("/api/v1/notes", { method: "POST", body: JSON.stringify({ text }) });
const notes = async (v: Visitor) => (await v.json<{ text: string }[]>("/api/v1/notes")).body.map((n) => n.text);

describe("leases", () => {
  it("gives 20 concurrent starts unique slots and a waitlist for the rest", async () => {
    await releaseAll();
    const visitors = Array.from({ length: 20 }, (_, i) => h.visitor(`198.51.100.${i + 1}`));
    const results = await Promise.all(visitors.map((v) => v.lease()));
    const leased = results.filter((r) => r.status === "leased");
    expect(leased).toHaveLength(POOL);
    expect(new Set(leased.map((r) => r.slot)).size).toBe(POOL);
    const waiting = results.filter((r) => r.status === "waitlist");
    expect(waiting).toHaveLength(20 - POOL);
    expect(new Set(waiting.map((r) => r.position)).size).toBe(20 - POOL);
    expect((await h.ops()).lobby.leases).toHaveLength(POOL);
  });

  it("isolates worlds: a write in one slot is invisible in another", async () => {
    await releaseAll();
    const a = h.visitor("198.51.100.101");
    const b = h.visitor("198.51.100.102");
    const la = await a.lease();
    const lb = await b.lease();
    expect(la.slot).not.toBe(lb.slot);
    expect((await note(a, "only in a")).status).toBe(201);
    expect(await notes(a)).toContain("only in a");
    expect(await notes(b)).not.toContain("only in a");
    // The showcase is untouched too.
    expect(await notes(h.visitor())).not.toContain("only in a");
  });

  it("resets a visitor's world through the Lobby: new generation cookie, old one 409, at most 3", async () => {
    await releaseAll();
    const v = h.visitor("198.51.100.103");
    const l = await v.lease();
    await note(v, "before reset");
    const oldCookie = v.jar.cookies.get(SESSION_COOKIE)!;
    const r = await v.fetch("/api/v1/sim/reset", { method: "POST", body: JSON.stringify({ profile: "rich" }) });
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; gen: number; resetsLeft: number; profile: string };
    expect(body).toMatchObject({ ok: true, gen: l.gen! + 1, resetsLeft: 2, profile: "rich" });
    expect(v.jar.cookies.get(SESSION_COOKIE)).not.toBe(oldCookie);
    expect(await notes(v)).not.toContain("before reset");

    const stale = h.visitor("198.51.100.103");
    stale.jar.cookies.set(SESSION_COOKIE, oldCookie);
    const old = await stale.fetch("/api/v1/notes");
    expect(old.status).toBe(409);
    expect(await old.json()).toMatchObject({ code: "LEASE_ENDED" });
    expect(stale.jar.cookies.has(SESSION_COOKIE)).toBe(false);

    const base = await v.fetch("/api/v1/sim/reset", { method: "POST", body: JSON.stringify({ profile: "base" }) });
    expect(base.status).toBe(400);
    expect(await base.json()).toMatchObject({ code: "HOSTED_RESET_PROFILE" });
    for (let i = 0; i < 2; i++) expect((await v.fetch("/api/v1/sim/reset", { method: "POST", body: "{}" })).status).toBe(200);
    const limit = await v.fetch("/api/v1/sim/reset", { method: "POST", body: "{}" });
    expect(limit.status).toBe(429);
    expect(await limit.json()).toMatchObject({ code: "RESET_LIMIT" });
  });

  it("ends idle leases at the sweep and resets the slot, so the next visitor gets a clean world", async () => {
    await releaseAll();
    const v = h.visitor("198.51.100.104");
    const l = await v.lease();
    await note(v, "left behind");
    const out = await (await lobby()).sweep({ now: Date.now() + (HOSTED_SETTINGS.leaseIdleMinutes + 1) * 60_000 });
    expect(out.released).toBeGreaterThanOrEqual(1);
    const ended = await v.fetch("/api/v1/notes");
    expect(ended.status).toBe(409);
    expect(await ended.json()).toMatchObject({ code: "LEASE_ENDED" });
    const slots = (await h.ops()).lobby.slots;
    expect(slots.find((s) => s.name === l.slot)!.gen).toBe(l.gen! + 1);
    // Whoever gets that slot next sees the seed only.
    const next = h.visitor("198.51.100.105");
    await next.lease();
    expect(await notes(next)).not.toContain("left behind");
  });

  it("ends leases at their 3 hour total even when active, and keeps active leases within it", async () => {
    await releaseAll();
    const v = h.visitor("198.51.100.106");
    await v.lease();
    const l = await lobby();
    expect((await l.sweep({ now: Date.now() + 20 * 60_000 })).released).toBe(0);
    await v.fetch("/api/v1/notes");
    expect((await l.sweep({ now: Date.now() + (HOSTED_SETTINGS.leaseTotalMinutes + 1) * 60_000 })).released).toBe(1);
  });

  it("gives a clean slot a new generation without a reset", async () => {
    await releaseAll();
    const v = h.visitor("198.51.100.107");
    const l = await v.lease();
    await v.fetch("/api/v1/notes");
    await (await lobby()).release({ slot: l.slot!, reason: "test" });
    const s = (await h.ops()).lobby.slots.find((x) => x.name === l.slot)!;
    expect(s.gen).toBe(l.gen! + 1);
    expect((await v.fetch("/api/v1/notes")).status).toBe(409);
  });

  it("caps leases at 20 per IP hash per UTC day", async () => {
    await releaseAll();
    const ip = "192.0.2.77";
    const l = await lobby();
    for (let i = 0; i < HOSTED_SETTINGS.leasesPerIpHashPerDay; i++) {
      const r = await h.visitor(ip).lease();
      expect(r.status).toBe("leased");
      await l.release({ slot: r.slot!, reason: "test" });
    }
    const over = await h.visitor(ip).lease();
    expect(over).toMatchObject({ status: "ip_limit" });
    expect((await h.visitor("192.0.2.78").lease()).status).toBe("leased");
  });

  it("holds the per-IP cap when starts from one address arrive together", async () => {
    await releaseAll();
    // End to end, with a full pool of leases past their total time, so the starts reclaim them first. The interleaving
    // itself (every start past its first look at the cap before one takes a slot) is pinned in the unit suite
    // (test/unit/lobby-assign.test.ts): workerd here happens to deliver these starts one after another.
    for (let i = 0; i < POOL; i++) expect((await h.visitor(`198.51.100.${170 + i}`).lease()).status).toBe("leased");
    const sql = await h.core.getDurableObjectStorage("LobbyDO", { name: DO_NAMES.lobby });
    const back = (HOSTED_SETTINGS.leaseTotalMinutes + 1) * 60_000;
    await sql.exec(`UPDATE leases SET started_at = started_at - ?, last_seen = last_seen - ?`, back, back);
    const ip = "192.0.2.79";
    await (await lobby()).extrasCounterAdd(`ip:${await ipHash(h.secrets.session, ip, utcDay())}`, HOSTED_SETTINGS.leasesPerIpHashPerDay - 1);
    const results = await Promise.all(Array.from({ length: POOL }, () => h.visitor(ip).lease()));
    expect(results.filter((r) => r.status === "leased")).toHaveLength(1);
    expect(results.filter((r) => r.status === "ip_limit")).toHaveLength(POOL - 1);
    expect((await h.ops()).lobby.leases).toHaveLength(1);
  });
});

describe("the operator lease", () => {
  it("waits for the pool like any visitor", async () => {
    await releaseAll();
    for (let i = 0; i < POOL; i++) expect((await h.visitor(`198.51.100.${150 + i}`).lease()).status).toBe("leased");
    const op = h.visitor("198.51.100.160");
    expect(await op.operatorLease("op-pool")).toMatchObject({ status: "waitlist", operator: "op-pool" });
    expect(op.jar.cookies.size).toBe(0);
    await releaseAll();
    expect((await op.operatorLease("op-pool")).status).toBe("leased");
  });

  it("counts against its address's daily lease cap", async () => {
    await releaseAll();
    const ip = "192.0.2.80";
    await (await lobby()).extrasCounterAdd(`ip:${await ipHash(h.secrets.session, ip, utcDay())}`, HOSTED_SETTINGS.leasesPerIpHashPerDay);
    const op = h.visitor(ip);
    expect(await op.operatorLease("op-cap")).toMatchObject({ status: "ip_limit" });
    expect(op.jar.cookies.size).toBe(0);
  });

  it("ends at the lease's total time like any other", async () => {
    await releaseAll();
    const op = h.visitor("198.51.100.161");
    const l = await op.operatorLease("op-expiry");
    expect(l.status).toBe("leased");
    expect((await (await lobby()).sweep({ now: Date.now() + (HOSTED_SETTINGS.leaseTotalMinutes + 1) * 60_000 })).released).toBeGreaterThanOrEqual(1);
    expect(await op.json("/api/v1/notes")).toMatchObject({ status: 409, body: { code: "LEASE_ENDED" } });
  });

  it("is released by POST /api/_admin/release { name }, which frees its slot for the next lease at once", async () => {
    await releaseAll();
    const ops = Array.from({ length: POOL }, (_, i) => h.visitor(`198.51.100.${170 + i}`));
    for (const [i, op] of ops.entries()) expect((await op.operatorLease(`op-rel-${i}`)).status).toBe("leased");
    const waiting = h.visitor("198.51.100.178");
    expect((await waiting.lease()).status).toBe("waitlist");
    await note(ops[0]!, "left by op-rel-0");
    // Released with that lease's own cookie: the cookies are cleared too.
    const r = await h.admin("POST", "/api/_admin/release", { name: "op-rel-0" }, { ip: ops[0]!.ip, jar: ops[0]!.jar });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, operator: "op-rel-0", released: true, slot: expect.stringMatching(/^slot-\d+$/) });
    expect(ops[0]!.jar.cookies.has(SESSION_COOKIE)).toBe(false);
    const next = await waiting.lease();
    expect(next.status).toBe("leased");
    // The slot was reset before it went back to the pool.
    expect(await notes(waiting)).not.toContain("left by op-rel-0");
    // A name that holds no lease is answered, not refused; a bad name is 400.
    expect(await (await h.admin("POST", "/api/_admin/release", { name: "op-rel-0" })).json()).toMatchObject({ ok: true, released: false, slot: null });
    expect((await h.admin("POST", "/api/_admin/release", { name: "Not A Name" })).status).toBe(400);
    expect((await h.fetch("/api/_admin/release", { method: "POST", body: JSON.stringify({ name: "op-rel-1" }) }, { origin: null })).status).toBe(401);
    expect((await h.ops()).lobby.leases).toHaveLength(POOL);
  });
});

describe("the showcase", () => {
  it("refuses mutations at the edge with 409 LEASE_REQUIRED and serves reads", async () => {
    const v = h.visitor();
    const r = await note(v, "nope");
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: "LEASE_REQUIRED", _tag: "Conflict" });
    expect((await v.fetch("/api/v1/notes")).status).toBe(200);
  });

  it("refuses mutations inside the Durable Object too (409 WORLD_READ_ONLY)", async () => {
    const env = await h.coreEnv();
    const ctx = await signCtx(h.secrets.ctx, { slot: DO_NAMES.showcase, gen: 0, visitor: null, ipHash: null, human: true, smoke: false, iat: Math.floor(Date.now() / 1000) });
    const stub = env.COMPANY.get(env.COMPANY.idFromName(DO_NAMES.showcase));
    const res = await stub.fetch(new Request(`${ORIGIN}/v1/notes`, { method: "POST", headers: { [TRUST_HEADERS.ctx]: ctx, "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "WORLD_READ_ONLY" });
  });

  it("refuses a request without the front's x-weft-ctx (401) and one naming another slot (409)", async () => {
    const env = await h.coreEnv();
    const stub = env.COMPANY.get(env.COMPANY.idFromName("slot-1"));
    expect((await stub.fetch(new Request(`${ORIGIN}/v1/notes`))).status).toBe(401);
    const forged = await signCtx("f".repeat(64), { slot: "slot-1", gen: 1, visitor: null, ipHash: null, human: true, smoke: false, iat: Math.floor(Date.now() / 1000) });
    expect((await stub.fetch(new Request(`${ORIGIN}/v1/notes`, { headers: { [TRUST_HEADERS.ctx]: forged } }))).status).toBe(401);
    const other = await signCtx(h.secrets.ctx, { slot: "slot-2", gen: 1, visitor: null, ipHash: null, human: true, smoke: false, iat: Math.floor(Date.now() / 1000) });
    expect((await stub.fetch(new Request(`${ORIGIN}/v1/notes`, { headers: { [TRUST_HEADERS.ctx]: other } }))).status).toBe(409);
  });
});
