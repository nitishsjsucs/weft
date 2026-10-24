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

  it("resets a visitor's world through the Lobby: new generation cookie, old one 409, at most resetsPerLease", async () => {
    await releaseAll();
    const v = h.visitor("198.51.100.103");
    const l = await v.lease();
    await note(v, "before reset");
    const oldCookie = v.jar.cookies.get(SESSION_COOKIE)!;
    const r = await v.fetch("/api/v1/sim/reset", { method: "POST", body: JSON.stringify({ profile: "rich" }) });
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; gen: number; resetsLeft: number; profile: string };
    expect(body).toMatchObject({ ok: true, gen: l.gen! + 1, resetsLeft: HOSTED_SETTINGS.resetsPerLease - 1, profile: "rich" });
    expect(v.jar.cookies.get(SESSION_COOKIE)).not.toBe(oldCookie);
    expect(await notes(v)).not.toContain("before reset");

    // A request that left with the cookie from before the reset of this same lease: 409 LEASE_ENDED, but the lease
    // lives on, so the cookies stay and the next session read reissues them for the new generation.
    const stale = h.visitor("198.51.100.103");
    stale.jar.cookies.set(SESSION_COOKIE, oldCookie);
    const old = await stale.fetch("/api/v1/notes");
    expect(old.status).toBe(409);
    expect(await old.json()).toMatchObject({ code: "LEASE_ENDED" });
    expect(old.headers.getSetCookie()).toEqual([]);
    expect(stale.jar.cookies.get(SESSION_COOKIE)).toBe(oldCookie);
    const reissued = await stale.json<{ world: string; lease: { slot: string; gen: number } | null }>("/api/_session");
    expect(reissued.body).toMatchObject({ world: "slot", lease: { slot: l.slot, gen: l.gen! + 1 } });
    expect(stale.jar.cookies.get(SESSION_COOKIE)).not.toBe(oldCookie);
    expect((await stale.json("/api/v1/notes")).status).toBe(200);

    // The session read the app sends right after its reset may still carry the old cookie: it gets the lease as it is
    // now and a cookie for the new generation, never a logout.
    const late = h.visitor("198.51.100.103");
    late.jar.cookies.set(SESSION_COOKIE, oldCookie);
    const st = await late.json<{ world: string; lease: { slot: string; gen: number } | null }>("/api/_session");
    expect(st.body).toMatchObject({ world: "slot", lease: { slot: l.slot, gen: l.gen! + 1 } });
    expect(late.jar.cookies.get(SESSION_COOKIE)).not.toBe(oldCookie);
    expect(await notes(late)).not.toContain("before reset");
    expect((await late.json("/api/v1/notes")).status).toBe(200);

    const base = await v.fetch("/api/v1/sim/reset", { method: "POST", body: JSON.stringify({ profile: "base" }) });
    expect(base.status).toBe(400);
    expect(await base.json()).toMatchObject({ code: "HOSTED_RESET_PROFILE" });
    // The cap is high (Nitish, 2026-10-23), so the lease's count moves to one short of it instead of that many resets.
    const lobbySql = await h.core.getDurableObjectStorage("LobbyDO", { name: DO_NAMES.lobby });
    await lobbySql.exec(`UPDATE leases SET resets = ? WHERE slot = ?`, HOSTED_SETTINGS.resetsPerLease - 1, l.slot!);
    const last = await v.fetch("/api/v1/sim/reset", { method: "POST", body: "{}" });
    expect(last.status).toBe(200);
    expect(await last.json()).toMatchObject({ ok: true, resetsLeft: 0 });
    const limit = await v.fetch("/api/v1/sim/reset", { method: "POST", body: "{}" });
    expect(limit.status).toBe(429);
    expect(await limit.json()).toMatchObject({ code: "RESET_LIMIT" });
  });

  it("never moves a cookie of the visitor's earlier, ended lease onto a later lease of the same slot", async () => {
    await releaseAll();
    const v = h.visitor("198.51.100.108");
    const first = await v.lease();
    const firstCookie = v.jar.cookies.get(SESSION_COOKIE)!;
    await (await lobby()).release({ slot: first.slot!, reason: "test" });
    // The same visitor (the jar still holds its id, as an operator name always gives the same one) leases again and
    // gets the same slot, one generation on.
    const second = await v.lease();
    expect(second).toMatchObject({ status: "leased", slot: first.slot, gen: first.gen! + 1 });
    const secondCookie = v.jar.cookies.get(SESSION_COOKIE)!;
    expect(secondCookie).not.toBe(firstCookie);

    // The first lease's cookie (unexpired, authentic, same visitor and slot, an older generation): 409 and cleared.
    const thief = h.visitor("198.51.100.109");
    thief.jar.cookies.set(SESSION_COOKIE, firstCookie);
    const r = await thief.fetch("/api/v1/notes");
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: "LEASE_ENDED" });
    expect(thief.jar.cookies.has(SESSION_COOKIE)).toBe(false);
    // Nor does a session read upgrade it: no lease, the showcase, and the cookies cleared.
    thief.jar.cookies.set(SESSION_COOKIE, firstCookie);
    const st = await thief.json<{ world: string; lease: unknown }>("/api/_session");
    expect(st.body).toMatchObject({ world: "showcase", lease: null });
    expect(thief.jar.cookies.has(SESSION_COOKIE)).toBe(false);
    // The second lease is untouched.
    expect((await v.json("/api/v1/notes")).status).toBe(200);
    expect(v.jar.cookies.get(SESSION_COOKIE)).toBe(secondCookie);
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

  it("ends leases at their total time even when active, and keeps active leases within it", async () => {
    await releaseAll();
    const v = h.visitor("198.51.100.106");
    await v.lease();
    const l = await lobby();
    expect((await l.sweep({ now: Date.now() + 20 * 60_000 })).released).toBe(0);
    await v.fetch("/api/v1/notes");
    // The total is 30 days (Nitish, 2026-10-23): the lease's start moves to 10 minutes short of it, so the sweep 20
    // minutes on finds it far inside its idle time and past its total.
    const sql = await h.core.getDurableObjectStorage("LobbyDO", { name: DO_NAMES.lobby });
    await sql.exec(`UPDATE leases SET started_at = started_at - ?`, (HOSTED_SETTINGS.leaseTotalMinutes - 10) * 60_000);
    expect((await l.sweep({ now: Date.now() + 20 * 60_000 })).released).toBe(1);
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

  it("caps leases at leasesPerIpHashPerDay per IP hash per UTC day", async () => {
    await releaseAll();
    const ip = "192.0.2.77";
    const l = await lobby();
    // The cap is high (Nitish, 2026-10-23): the address's count starts two short of it, and two real leases reach it.
    await l.extrasCounterAdd(`ip:${await ipHash(h.secrets.session, ip, utcDay())}`, HOSTED_SETTINGS.leasesPerIpHashPerDay - 2);
    for (let i = 0; i < 2; i++) {
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
