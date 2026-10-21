// ETag/304 and x-weft-tables on the durable platform (docs/cloudflare/design.md 4.5; track cf2-platform acceptance):
// an unchanged poll returns 304 with 0 rows read, a commit that wrote a table the poll read invalidates it, and the
// identity, the clock and the world generation are part of the key. Node's app is unchanged.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { TABLES_HEADER } from "../../../packages/contracts/src/ext/cf-hosted";
import { hostedApp, isPolledRoute, markUncachable, POLLED_GET_ROUTES } from "../src/http/hosted";
import type { WeftEnv } from "../src/http/context";
import { createTestWeft } from "../src/testing";
import { buildSeededWorld, openDurableWorld, type DurableTestWorld, type SeededWorld } from "./support/durable-world";

let seed: SeededWorld;
let w: DurableTestWorld;
beforeAll(async () => { seed = await buildSeededWorld(); w = await openDurableWorld(seed); }, 180_000);
afterAll(async () => { await w?.close(); seed?.dispose(); });

const get = (path: string, opts: { who?: string; etag?: string | null; headers?: Record<string, string> } = {}) =>
  w.weft.app.request(path, { headers: { ...w.headers(opts.who ?? "usr_dana"), ...(opts.etag ? { "if-none-match": opts.etag } : {}), ...opts.headers } });
const post = (path: string, body: unknown, who = "usr_dana") => w.weft.app.request(path, { method: "POST", headers: { ...w.headers(who), "content-type": "application/json" }, body: JSON.stringify(body) });
/** Statements and rows the facade meter saw while `fn` ran. */
async function cost<T>(fn: () => T | Promise<T>): Promise<{ value: T; statements: number; rowsRead: number }> {
  const a = w.meter.totals();
  const value = await fn();
  const b = w.meter.totals();
  return { value, statements: b.statements - a.statements, rowsRead: b.rowsRead - a.rowsRead };
}

describe("ETag/304 on the polled GET routes", () => {
  it("an unchanged poll returns 304 with 0 rows read: no statement runs, auth included", async () => {
    const first = await get("/v1/proposals?status=pending&limit=100");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"1\.[0-9a-f]{32}"$/);
    expect(first.headers.get(TABLES_HEADER)!.split(",")).toEqual(expect.arrayContaining(["principals", "proposals"]));
    const body = await first.text();
    const again = await cost(() => get("/v1/proposals?status=pending&limit=100", { etag }));
    expect(again.value.status).toBe(304);
    expect(await again.value.text()).toBe("");
    expect(again.value.headers.get("etag")).toBe(etag);
    expect(again.value.headers.get(TABLES_HEADER)).toBe(first.headers.get(TABLES_HEADER));
    expect([again.statements, again.rowsRead]).toEqual([0, 0]);
    // The same query in another order is the same poll; without If-None-Match it is computed and answers the same body.
    expect((await get("/v1/proposals?limit=100&status=pending", { etag })).status).toBe(304);
    const plain = await cost(() => get("/v1/proposals?status=pending&limit=100"));
    expect(plain.value.status).toBe(200);
    expect(await plain.value.text()).toBe(body);
    expect(plain.statements).toBeGreaterThan(0);
  });

  it("a commit that writes a table the poll read invalidates it; a commit that writes other tables does not", async () => {
    const first = await get("/v1/time-off/requests?limit=100");
    const etag = first.headers.get("etag")!;
    const tables = first.headers.get(TABLES_HEADER)!.split(",");
    expect(tables).toEqual(expect.arrayContaining(["time_off_requests", "time_off_ledger", "workers"]));
    expect(tables).not.toContain("sim_faults");
    expect((await post("/v1/sim/faults", { target: "bank.submitBatch", kind: "error", mode: "once" })).status).toBe(200);
    expect((await get("/v1/time-off/requests?limit=100", { etag })).status).toBe(304);
    const submitted = await post("/v1/time-off/requests?workerId=wrk_0025", { policyId: "top_vac_us", startDate: "2026-12-14", endDate: "2026-12-15", partialDayMinutes: null, reason: "Family visit" });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    const after = await get("/v1/time-off/requests?limit=100", { etag });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    expect(await after.text()).toContain("Family visit");
  });

  it("keys on the identity: another principal, or a bad proxy secret, never gets the remembered 304", async () => {
    const dana = await get("/v1/workers?limit=100");
    const etag = dana.headers.get("etag")!;
    const sam = await get("/v1/workers?limit=100", { who: "usr_sam", etag });
    expect(sam.status).toBe(200);
    expect(sam.headers.get("etag")).not.toBe(etag);
    const forged = await w.weft.app.request("/v1/workers?limit=100", { headers: { "x-weft-principal": "usr_dana", "x-weft-proxy": "0".repeat(64), "if-none-match": etag } });
    expect(forged.status).toBe(401);
    const wrongHost = await w.weft.app.request("http://evil.example/v1/workers?limit=100", { headers: { ...w.headers("usr_dana"), host: "evil.example", "if-none-match": etag } });
    expect(wrongHost.status).toBe(403);
  });

  it("keys on the clock: moving the sim clock changes the ETag of a poll that reports it", async () => {
    const first = await get("/v1/sim/state");
    const etag = first.headers.get("etag")!;
    expect((await get("/v1/sim/state", { etag })).status).toBe(304);
    expect((await post("/v1/sim/clock/advance", { by: "PT5M" })).status).toBe(200);
    const moved = await get("/v1/sim/state", { etag });
    expect(moved.status).toBe(200);
    expect(JSON.parse(await moved.text()).clock.now).toBe("2026-10-26T15:35:00.000Z");
  });

  it("every GET lists the tables it read; routes the web does not poll get no ETag", async () => {
    const company = await get("/v1/company");
    expect(company.status).toBe(200);
    expect(company.headers.get("etag")).toBeNull();
    expect(company.headers.get(TABLES_HEADER)).toContain("companies");
    expect(isPolledRoute("/v1/workers/wrk_0001")).toBe(true);
    expect(isPolledRoute("/v1/agent/costs")).toBe(false);
    expect(POLLED_GET_ROUTES).toContain("/v1/time-off/requests");
    // The long poll waits; it is never remembered.
    const run = (w.storage.sql.exec<{ id: string }>("SELECT id FROM agent_runs ORDER BY id LIMIT 1").toArray()[0])?.id;
    if (run) expect((await get(`/v1/agent/runs/${run}?wait=1`)).headers.get("etag")).toBeNull();
  });

  it("never answers 304 to an ETag from an earlier boot: table versions restart at 0 on every cold start", async () => {
    // The reviewer's case: a poll's ETag, then a write the poll would show, then a cold start (a DO eviction, a
    // hibernation, a deploy). The new boot's versions are back at 0, so only a per-boot epoch tells the two apart.
    const path = "/v1/time-off/requests?limit=100";
    w = await w.reboot();   // fresh versions, as on any cold start, so the first poll hashes versions of 0
    const before = await get(path);
    expect(before.status).toBe(200);
    const old = before.headers.get("etag")!;
    expect(old).toMatch(/^W\/"1\.[0-9a-f]{32}"$/);
    const submitted = await post("/v1/time-off/requests?workerId=wrk_0026", { policyId: "top_vac_us", startDate: "2026-12-21", endDate: "2026-12-22", partialDayMinutes: null, reason: "Dentist visit" });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    w = await w.reboot();
    const stale = await cost(() => get(path, { etag: old }));
    expect(stale.value.status).toBe(200);
    expect(stale.statements).toBeGreaterThan(0);
    const fresh = stale.value.headers.get("etag")!;
    expect(fresh).toMatch(/^W\/"1\.[0-9a-f]{32}"$/);
    expect(fresh).not.toBe(old);
    expect(await stale.value.text()).toContain("Dentist visit");
    // Within the new boot the new ETag is remembered as usual: 304, 0 rows read.
    const again = await cost(() => get(path, { etag: fresh }));
    expect([again.value.status, again.statements, again.rowsRead]).toEqual([304, 0, 0]);
    // An unchanged world across a second cold start: the old boot's ETag is still computed, never trusted.
    w = await w.reboot();
    const quiet = await cost(() => get(path, { etag: fresh }));
    expect(quiet.value.status).toBe(200);
    expect(quiet.statements).toBeGreaterThan(0);
    expect(quiet.value.headers.get("etag")).not.toBe(fresh);
  });

  it("never remembers a response that read outside the company SQL, read no table, wrote rows, or overlapped a commit", async () => {
    const inner = new Hono<WeftEnv>();
    inner.get("/v1/workers", async (c) => { markUncachable("SpendDO.spent"); await w.weft.db.all(sql`SELECT id FROM workers LIMIT 1`); return c.json({ ok: 1 }); });
    inner.get("/v1/offers", async (c) => { await w.weft.db.run(sql`INSERT INTO kv_state (key, value) VALUES ('test.etag', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`); return c.json({ ok: 2 }); });
    inner.get("/v1/notices", async (c) => {
      await w.weft.db.all(sql`SELECT id FROM notices LIMIT 1`);
      await w.weft.db.transaction(async (tx) => { await tx.run(sql`INSERT INTO kv_state (key, value) VALUES ('test.etag2', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`); });
      return c.json({ ok: 3 });
    });
    inner.get("/v1/expenses", async (c) => { await w.weft.db.all(sql`SELECT id FROM expenses LIMIT 1`); return c.json({ ok: 4 }); });
    inner.get("/v1/routines", (c) => c.json({ fromMemoryOnly: true }));
    const app = hostedApp(inner, w.weft, w.meter);
    const h = { host: "localhost" };
    for (const p of ["/v1/workers", "/v1/offers", "/v1/notices", "/v1/routines"]) {
      const res = await app.request(p, { headers: h });
      expect(res.status, p).toBe(200);
      expect(res.headers.get("etag"), p).toBeNull();
    }
    const clean = await app.request("/v1/expenses", { headers: h });
    expect(clean.headers.get("etag")).toMatch(/^W\//);
    expect(clean.headers.get(TABLES_HEADER)).toBe("expenses");
    expect(app.hostedStats.remembered).toBe(1);
  });
});

describe("Node", () => {
  it("keeps the app without the hosted layer: no ETag, no x-weft-tables, no 304", async () => {
    const t = await createTestWeft();
    try {
      const res = await t.app.request("/v1/proposals?limit=100", { headers: t.uiHeaders("usr_dana") });
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toBeNull();
      expect(res.headers.get(TABLES_HEADER)).toBeNull();
      expect((await t.app.request("/v1/proposals?limit=100", { headers: { ...t.uiHeaders("usr_dana"), "if-none-match": "*" } })).status).toBe(200);
    } finally { await t.close(); }
  });
});
