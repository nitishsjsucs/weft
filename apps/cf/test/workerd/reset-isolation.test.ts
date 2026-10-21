// Design 6.2 steps 4 and 5, 6.4 and 4.6: a visitor's world never reaches the next visitor. With a pool of one, the
// next visitor can only get the same slot, so each case checks that whatever the reset path (a stale snapshot, a
// delta reset mismatch, a lease that ends, a write still in flight when it ends, a reset the Lobby lost), the slot
// is back at the seed or out of the pool before anyone else leases it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DO_NAMES, SESSION_COOKIE } from "../../src/shared/contracts";
import { FAKE_FORCE_MISMATCH, FAKE_SNAPSHOT_VERSION } from "../support/fake-engine";
import { Harness, type Visitor } from "../support/harness";

let h: Harness;
beforeAll(async () => {
  h = await Harness.start({ poolSize: 1 });
  await h.provision();
});
afterAll(async () => { await h?.close(); });

const SLOT = "slot-1";
const lobby = async () => { const e = await h.coreEnv(); return e.LOBBY.get(e.LOBBY.idFromName(DO_NAMES.lobby)); };
const note = (v: Visitor, text: string, extra: Record<string, unknown> = {}) => v.fetch("/api/v1/notes", { method: "POST", body: JSON.stringify({ text, ...extra }) });
const notes = async (v: Visitor) => (await v.json<{ text: string }[]>("/api/v1/notes")).body.map((n) => n.text);
const slotRow = async () => (await h.ops()).lobby.slots.find((s) => s.name === SLOT)!;
/** The slot is out of the pool, or already rebuilt at a later generation (the fake restore takes milliseconds). */
async function notHandedOutAsIs(gen: number): Promise<void> {
  const s = await slotRow();
  if (s.state === "ready") expect(s.gen).toBeGreaterThan(gen);
  else expect(["restoring", "failed"]).toContain(s.state);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The visitor id of the slot's lease, from the Lobby's own table (the cookie that carries it is signed). */
const leaseVisitor = async (): Promise<string> => {
  const sql = await h.core.getDurableObjectStorage("LobbyDO", { name: DO_NAMES.lobby });
  const [row] = await sql.exec(`SELECT visitor FROM leases WHERE slot = ?`, SLOT) as { visitor: string }[];
  return row!.visitor;
};
let ip = 10;
const visitor = () => h.visitor(`198.51.100.${ip++}`);

/** The next visitor to lease the pool's only slot, once it is ready again: never with the previous world. */
async function nextVisitorSeesSeed(gone: string[], genAbove: number): Promise<void> {
  const waiting = visitor();
  const first = await waiting.lease();
  if (first.status === "leased") {
    expect(first.gen).toBeGreaterThan(genAbove);
  } else {
    expect(first.status).toBe("waitlist");
    await h.waitReady(60_000, [SLOT]);
  }
  const b = first.status === "leased" ? waiting : visitor();
  const l = first.status === "leased" ? first : await b.lease();
  expect(l).toMatchObject({ status: "leased", slot: SLOT });
  expect(l.gen).toBeGreaterThan(genAbove);
  const seen = await notes(b);
  for (const t of gone) expect(seen).not.toContain(t);
  await (await lobby()).release({ slot: SLOT, reason: "test" });
  await h.waitReady(60_000, [SLOT]);
}

describe("a reset that cannot run in place", () => {
  it("ends the lease and rebuilds a world of another snapshot before anyone else gets it", async () => {
    const env = await h.coreEnv();
    const a = visitor();
    const la = await a.lease();
    expect(la).toMatchObject({ status: "leased", slot: SLOT });
    expect((await note(a, "A private note")).status).toBe(201);
    const oldCookie = a.jar.cookies.get(SESSION_COOKIE)!;
    await env.CONFIG.put("snapshot.version", "another-snapshot");   // as a deploy does
    try {
      await sleep(400);
      const r = await a.fetch("/api/v1/sim/reset", { method: "POST", body: JSON.stringify({ profile: "rich" }) });
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ code: "LEASE_ENDED" });
      expect((await h.ops()).lobby.leases).toEqual([]);
      await notHandedOutAsIs(la.gen!);
      // The front cleared the visitor's cookies, and the old cookie no longer reaches the world.
      expect(a.jar.cookies.has(SESSION_COOKIE)).toBe(false);
      const stale = h.visitor(a.ip);
      stale.jar.cookies.set(SESSION_COOKIE, oldCookie);
      expect([409, 503]).toContain((await stale.fetch("/api/v1/notes")).status);
      await nextVisitorSeesSeed(["A private note"], la.gen!);
    } finally {
      await env.CONFIG.delete("snapshot.version");
      await sleep(400);
    }
  });

  it("ends the lease and rebuilds the world after a delta reset mismatch", async () => {
    const a = visitor();
    const la = await a.lease();
    expect((await note(a, "A private note 2")).status).toBe(201);
    expect((await note(a, FAKE_FORCE_MISMATCH)).status).toBe(201);
    const r = await a.fetch("/api/v1/sim/reset", { method: "POST", body: "{}" });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: "LEASE_ENDED" });
    expect((await h.ops()).lobby.leases).toEqual([]);
    await notHandedOutAsIs(la.gen!);
    await nextVisitorSeesSeed(["A private note 2", FAKE_FORCE_MISMATCH], la.gen!);
  });

  it("rebuilds the world when a lease ends and the delta reset mismatches", async () => {
    const a = visitor();
    const la = await a.lease();
    await note(a, "left behind");
    await note(a, FAKE_FORCE_MISMATCH);
    await (await lobby()).release({ slot: SLOT, reason: "test" });
    await notHandedOutAsIs(la.gen!);
    await nextVisitorSeesSeed(["left behind", FAKE_FORCE_MISMATCH], la.gen!);
  });

  it("keeps the lease when a second reset of the same generation arrives: it is refused, the lease goes on", async () => {
    const a = visitor();
    const la = await a.lease();
    await note(a, "before");
    const ops = await h.ops();
    const leaseGen = ops.lobby.leases.find((l) => l.slot === SLOT)!.gen;
    const l = await lobby();
    // The same lease and generation twice at once (a double click): the first resets; the second finds the slot
    // resetting (RATE_LIMITED) or, if it arrives after, an older generation (LEASE_ENDED for that request only).
    const visitorId = await leaseVisitor();
    const both = await Promise.all([0, 1].map(() => l.reset({ visitor: visitorId, slot: SLOT, gen: leaseGen })));
    const ok = both.filter((r) => "ok" in r);
    expect(ok).toHaveLength(1);
    const refused = both.find((r) => "error" in r) as { error: string };
    expect(["RATE_LIMITED", "LEASE_ENDED"]).toContain(refused.error);
    const after = await h.ops();
    expect(after.lobby.leases).toEqual([expect.objectContaining({ slot: SLOT, gen: (ok[0] as { gen: number }).gen })]);
    expect(after.lobby.slots.find((s) => s.name === SLOT)).toMatchObject({ state: "ready", gen: la.gen! + 1 });
    await l.release({ slot: SLOT, reason: "test" });
    await h.waitReady(60_000, [SLOT]);
  });
});

describe("a write in flight when the lease ends", () => {
  it("is seen by the reset (or refused), never carried into the next generation", async () => {
    const a = visitor();
    const la = await a.lease();
    await a.fetch("/api/v1/notes");   // a read: the world is still clean
    const slow = note(a, "in flight at the end", { delayMs: 800 });
    await sleep(150);   // the write is past the slot's gate and waiting
    await (await lobby()).release({ slot: SLOT, reason: "test" });
    const res = await slow;
    expect([201, 409, 503]).toContain(res.status);
    const s = await slotRow();
    expect(s.state).toBe("ready");
    expect(s.gen).toBeGreaterThan(la.gen!);
    await nextVisitorSeesSeed(["in flight at the end"], la.gen!);
  });
});

describe("a reset the Lobby lost", () => {
  it("sends a slot left resetting to a full restore at the sweep, never back to the pool", async () => {
    const lobbySql = await h.core.getDurableObjectStorage("LobbyDO", { name: DO_NAMES.lobby });
    await lobbySql.exec(`UPDATE slots SET state = 'resetting' WHERE name = ?`, SLOT);
    expect((await visitor().lease()).status).toBe("waitlist");
    const out = await (await lobby()).sweep();
    expect(out.restores).toContainEqual({ slot: SLOT, action: "restore" });
    const ready = await h.waitReady(60_000, [SLOT]);
    expect(ready.find((s) => s.name === SLOT)!.snapshot).toBe(FAKE_SNAPSHOT_VERSION);
    expect((await visitor().lease()).status).toBe("leased");
    await (await lobby()).release({ slot: SLOT, reason: "test" });
  });
});
