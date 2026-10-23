// Design 9.2, 6.3, 6.4, 3.5 and 4.6: the admin routes need the HMAC signature; provisioning is idempotent and the
// conformance route runs on its scratch object and wipes it; /mcp routes by the key prefix and dies with the lease
// generation and stops the moment its lease ends, agent_ask at most 5 per key per day; the [id] shell fallback;
// ReseedWorkflow's restore steps are idempotent; and the Rate Limiting bindings answer 429, except to a valid smoke.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DO_NAMES, HOSTED_RATE_LIMITS, MCP_AGENT_ASK_PER_KEY_DAY } from "../../src/shared/contracts";
import { signAdmin } from "../../src/shared/tokens";
import { FAKE_SNAPSHOT_VERSION } from "../support/fake-engine";
import { Harness } from "../support/harness";

let h: Harness;
beforeAll(async () => {
  h = await Harness.start({ poolSize: 6, runWorkerFirst: ["/app/people/*"] });
  await h.provision();
});
afterAll(async () => { await h?.close(); });

describe("admin routes", () => {
  it("refuse a missing, wrong, stale or replayed-on-another-path signature", async () => {
    expect((await h.fetch("/api/_admin/ops", {}, { origin: null })).status).toBe(401);
    const wrong = await signAdmin({ token: "w".repeat(64), method: "GET", path: "/api/_admin/ops" });
    expect((await h.fetch("/api/_admin/ops", { headers: { "x-weft-admin": wrong } })).status).toBe(401);
    const stale = await signAdmin({ token: h.secrets.admin, method: "GET", path: "/api/_admin/ops", nowS: Math.floor(Date.now() / 1000) - 600 });
    expect((await h.fetch("/api/_admin/ops", { headers: { "x-weft-admin": stale } })).status).toBe(401);
    const other = await signAdmin({ token: h.secrets.admin, method: "GET", path: "/api/_admin/ops" });
    expect((await h.fetch("/api/_admin/sweep", { method: "POST", headers: { "x-weft-admin": other } }, { origin: null })).status).toBe(401);
    expect((await h.admin("GET", "/api/_admin/ops")).status).toBe(200);
  });

  it("takes each signature once, and refuses one dated more than 30 s ahead", async () => {
    const sig = await signAdmin({ token: h.secrets.admin, method: "GET", path: "/api/_admin/ops" });
    expect((await h.fetch("/api/_admin/ops", { headers: { "x-weft-admin": sig } })).status).toBe(200);
    const replay = await h.fetch("/api/_admin/ops", { headers: { "x-weft-admin": sig } });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ code: "ADMIN_SIGNATURE" });
    const body = JSON.stringify({ slots: ["slot-1"] });
    const post = await signAdmin({ token: h.secrets.admin, method: "POST", path: "/api/_admin/provision", body });
    const send = () => h.fetch("/api/_admin/provision", { method: "POST", body, headers: { "x-weft-admin": post, "content-type": "application/json" } }, { origin: null });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(401);
    // The operator release too: a captured release signature cannot end a second lease of that name.
    const rel = JSON.stringify({ name: "replay-check" });
    const relSig = await signAdmin({ token: h.secrets.admin, method: "POST", path: "/api/_admin/release", body: rel });
    const release = () => h.fetch("/api/_admin/release", { method: "POST", body: rel, headers: { "x-weft-admin": relSig, "content-type": "application/json" } }, { origin: null });
    expect((await release()).status).toBe(200);
    expect((await release()).status).toBe(401);
    const ahead = await signAdmin({ token: h.secrets.admin, method: "GET", path: "/api/_admin/ops", nowS: Math.floor(Date.now() / 1000) + 120 });
    expect((await h.fetch("/api/_admin/ops", { headers: { "x-weft-admin": ahead } })).status).toBe(401);
  });

  it("provisions idempotently: ready worlds are left alone, restored from the bundled snapshot", async () => {
    const r = await h.admin("POST", "/api/_admin/provision", {});
    const body = await r.json() as { steps: { slot: string; action: string }[] };
    expect(body.steps.every((s) => s.action === "ready")).toBe(true);
    const slots = (await h.ops()).lobby.slots;
    expect(slots.every((s) => s.snapshot === FAKE_SNAPSHOT_VERSION)).toBe(true);
    expect(slots.find((s) => s.name === DO_NAMES.showcase)!.gen).toBe(1);
  });

  it("forces a full restore of one world through ReseedWorkflow, a new generation", async () => {
    const before = (await h.ops()).lobby.slots.find((s) => s.name === "slot-3")!;
    const r = await h.admin("POST", "/api/_admin/provision", { slots: ["slot-3"], force: true });
    expect((await r.json() as { steps: { action: string }[] }).steps).toEqual([{ slot: "slot-3", action: "restore" }]);
    const after = (await h.waitReady(60_000, ["slot-3"])).find((s) => s.name === "slot-3")!;
    expect(after.gen).toBe(before.gen + 1);
  });

  it("runs the conformance cases on the scratch object, which wipes itself", async () => {
    const r = await h.admin("POST", "/api/_admin/conformance", {});
    expect(await r.json()).toMatchObject({ passed: 1, failed: 0 });
    const sql = await h.core.getDurableObjectStorage("CompanyDO", { name: DO_NAMES.conformance });
    const tables = await sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'") as { name: string }[];
    expect(tables).toEqual([]);
  });

  it("runs the seed memory index only with the signature, and says why it cannot run without Workers AI and Vectorize", async () => {
    expect((await h.fetch("/api/_admin/seed-index", { method: "POST", body: "{}" }, { origin: null })).status).toBe(401);
    // The fake engine has no extras bindings, as a deployment without AI or MEMVEC: the showcase refuses the step.
    const r = await h.admin("POST", "/api/_admin/seed-index", {});
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: "SEED_INDEX_FAILED", message: expect.stringMatching(/SEED_INDEX_DISABLED/) });
  });

  it("keeps visitor ids and IP hashes out of the ops readout", async () => {
    const v = h.visitor("198.51.100.250");
    await v.lease();
    const text = await (await h.admin("GET", "/api/_admin/ops")).text();
    expect(text).not.toMatch(/vis_[0-9a-f]{32}/);
    expect(text).not.toContain("198.51.100.250");
    const ops = JSON.parse(text) as { lobby: { leases: Record<string, unknown>[] } };
    for (const l of ops.lobby.leases) expect(Object.keys(l).sort()).toEqual(["gen", "lastSeen", "resets", "slot", "startedAt"]);
  });
});

describe("remote MCP routing", () => {
  it("routes by the key prefix, refuses other keys, and limits agent_ask to 5 per key per day", async () => {
    const v = h.visitor("198.51.100.240");
    const l = await v.lease();
    const { key } = await (await v.fetch("/api/_hosted/mcp-key", { method: "POST" })).json() as { key: string };
    const call = (k: string | null, method = "tools/list") => h.fetch("/mcp", { method: "POST", body: JSON.stringify({ method }), headers: k ? { authorization: `Bearer ${k}` } : {} }, { origin: null });
    const ok = await call(key);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ mcp: true, world: { slot: l.slot, gen: l.gen } });
    const viaHeader = await h.fetch("/mcp", { method: "POST", body: "{}", headers: { "x-api-key": key } }, { origin: null });
    expect(viaHeader.status).toBe(200);
    expect((await call(null)).status).toBe(401);
    expect((await call("weft_sk_" + "0".repeat(48))).status).toBe(401);
    expect((await call(`wk_mcp_showcase_1_${"a".repeat(20)}`)).status).toBe(401);
    const asks: number[] = [];
    for (let i = 0; i < MCP_AGENT_ASK_PER_KEY_DAY + 1; i++) asks.push((await call(key, "agent_ask")).status);
    expect(asks.filter((s) => s === 200)).toHaveLength(MCP_AGENT_ASK_PER_KEY_DAY);
    expect(asks.at(-1)).toBe(429);
  });

  it("stops the key the moment its lease ends, before the world is reset", async () => {
    const env = await h.coreEnv();
    const v = h.visitor("198.51.100.242");
    const l = await v.lease();
    const { key } = await (await v.fetch("/api/_hosted/mcp-key", { method: "POST" })).json() as { key: string };
    const call = () => h.fetch("/mcp", { method: "POST", body: "{}", headers: { authorization: `Bearer ${key}` } }, { origin: null });
    expect((await call()).status).toBe(200);
    // The slot's own end of the lease (the Lobby's release calls it before the reset): same generation, no visitor.
    await env.COMPANY.get(env.COMPANY.idFromName(l.slot!)).endLease({ gen: l.gen!, reason: "test" });
    expect((await h.ops()).lobby.slots.find((s) => s.name === l.slot)!.gen).toBe(l.gen);
    const r = await call();
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: "LEASE_ENDED" });
    await env.LOBBY.get(env.LOBBY.idFromName(DO_NAMES.lobby)).release({ slot: l.slot!, reason: "test" });
    expect((await call()).status).toBe(409);
  });

  it("kills the key with its lease generation", async () => {
    const v = h.visitor("198.51.100.241");
    await v.lease();
    const { key } = await (await v.fetch("/api/_hosted/mcp-key", { method: "POST" })).json() as { key: string };
    await v.fetch("/api/v1/sim/reset", { method: "POST", body: "{}" });
    const r = await h.fetch("/mcp", { method: "POST", body: "{}", headers: { authorization: `Bearer ${key}` } }, { origin: null });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: "LEASE_ENDED" });
  });
});

describe("assets", () => {
  it("serves [id] pages from the section's shell when the fallback is on", async () => {
    const r = await h.fetch("/app/people/wrk_0026/");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("people shell");
    expect(await (await h.fetch("/app/people/wrk_0026/index.txt")).text()).toBe("people rsc");
    expect(await (await h.fetch("/")).text()).toContain("home");
  });
});

describe("Browser Run locally", () => {
  it("refuses a browser session at once with the reason, so a local PDF render fails fast instead of on a reply that is not JSON", async () => {
    const env = await h.coreEnv() as unknown as { BROWSER: unknown };
    const { puppeteerLauncher } = await import("@weft/cf-extras");
    await expect(puppeteerLauncher(env.BROWSER)()).rejects.toThrow(/code: 501[\s\S]*not emulated locally/);
  });
});

describe("restore steps", () => {
  it("skip chunks a retried step already applied", async () => {
    const env = await h.coreEnv();
    const co = env.COMPANY.get(env.COMPANY.idFromName("slot-6"));
    await co.restoreBegin({ slot: "slot-6", gen: 50, mode: "slot" });
    await co.restoreMigrate();
    const n = await co.restoreChunkCount();
    expect(n).toBe(3);
    expect(await co.restoreChunks({ from: 0, to: 2 })).toEqual({ next: 2, rowsWritten: 2 });
    expect(await co.restoreChunks({ from: 0, to: 3 })).toEqual({ next: 3, rowsWritten: 3 });
    expect(await co.restoreArm()).toEqual({ ok: true, mismatches: [] });
    expect(await co.restoreVerify()).toMatchObject({ ok: true, rows: 3 });
    const done = await co.restoreFinish({ bookmark: null });
    // Three chunk rows plus what arming wrote (the fake's two).
    expect(done).toMatchObject({ slot: "slot-6", gen: 50, snapshot: FAKE_SNAPSHOT_VERSION, rowsWritten: 5 });
    const hb = await co.heartbeat();
    expect(hb).toMatchObject({ stamped: { slot: "slot-6", gen: 50, mode: "slot" }, clean: true, snapshot: FAKE_SNAPSHOT_VERSION });
  });

  it("answers 503 while a world is rebuilt", async () => {
    const env = await h.coreEnv();
    const co = env.COMPANY.get(env.COMPANY.idFromName("slot-5"));
    await co.restoreBegin({ slot: "slot-5", gen: 60, mode: "slot" });
    const { signCtx } = await import("../../src/shared/tokens");
    const ctx = await signCtx(h.secrets.ctx, { slot: "slot-5", gen: 60, visitor: null, ipHash: null, human: true, smoke: false, iat: Math.floor(Date.now() / 1000) });
    const r = await co.fetch(new Request("http://weft.test/v1/notes", { headers: { "x-weft-ctx": ctx } }));
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: "WORLD_REBUILDING" });
  });
});

describe("rate limits", () => {
  const limit = HOSTED_RATE_LIMITS.RL_API.limit;
  const burst = async (n: number, ip: string, headers: Record<string, string> = {}) =>
    Promise.all(Array.from({ length: n }, () => h.fetch("/api/_no_such_route", { headers }, { ip }).then((r) => r.status)));

  it(`answers 429 past RL_API (${limit} per 60 s per IP hash)`, async () => {
    const statuses = await burst(limit + 100, "203.0.113.200");
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses.filter((s) => s !== 429).length).toBeLessThanOrEqual(limit);
  });

  it("lets a valid smoke visit past RL_API, and an unsigned one from the same address still counts", async () => {
    const smoke = await h.smokeHeaders("/api/_no_such_route");
    const statuses = await burst(limit + 100, "203.0.113.201", smoke);
    expect(statuses.filter((s) => s === 429)).toEqual([]);
    expect(new Set(statuses)).toEqual(new Set([404]));
    // The smoke burst used none of the address's allowance; a forged smoke header is an ordinary visit.
    expect((await burst(1, "203.0.113.201"))[0]).toBe(404);
    const forged = await burst(limit + 100, "203.0.113.202", { "x-weft-smoke": `${Math.floor(Date.now() / 1000)}.${"0".repeat(64)}` });
    expect(forged.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});

describe("RL_MUTATE and the smoke", () => {
  it("keys valid smoke mutations apart, so they leave the address's visitor allowance alone", async () => {
    const ip = "203.0.113.210";
    const limit = HOSTED_RATE_LIMITS.RL_MUTATE.limit;
    const statuses = await Promise.all(Array.from({ length: limit }, async () =>
      (await h.fetch("/api/v1/notes", { method: "POST", body: JSON.stringify({ text: "smoke" }), headers: await h.smokeHeaders("/api/v1/notes", "POST") }, { ip, origin: null })).status));
    expect(statuses.filter((s) => s === 429)).toEqual([]);
    // A visitor leasing from the same address still has its whole allowance.
    const v = h.visitor(ip);
    expect((await v.lease()).status).toBe("leased");
    expect((await v.fetch("/api/v1/notes", { method: "POST", body: JSON.stringify({ text: "mine" }) })).status).toBe(201);
  });
});

describe("world upkeep in the cron sweep", () => {
  it("verifies clean idle worlds weekly and restores idle worlds of another snapshot", async () => {
    const env = await h.coreEnv();
    const lobby = env.LOBBY.get(env.LOBBY.idFromName(DO_NAMES.lobby));
    const week = await lobby.sweep({ now: Date.now() + 8 * 86_400_000 });
    expect(week.restores.filter((s) => s.action === "restore")).toEqual([]);
    await env.CONFIG.put("snapshot.version", "another-snapshot");
    try {
      await new Promise((r) => setTimeout(r, 400));
      const stale = await lobby.sweep();
      expect(stale.restores.filter((s) => s.action === "restore").length).toBeGreaterThan(0);
    } finally {
      await env.CONFIG.delete("snapshot.version");
    }
    await new Promise((r) => setTimeout(r, 400));
    const slots = await h.waitReady(60_000);
    expect(slots.every((s) => s.snapshot === FAKE_SNAPSHOT_VERSION)).toBe(true);
  });
});
