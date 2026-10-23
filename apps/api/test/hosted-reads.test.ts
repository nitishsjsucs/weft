// Reads that write nothing (docs/cloudflare/design.md 4.4; track cf2-platform acceptance):
// - with ephemeral read ids, a sweep of every GET route writes 0 rows (the design counted 67 GET routes when it was
//   measured; the route table holds more now, and the sweep covers all of them but the event streams). It runs on the
//   rich world, the hosted profile, where every swept route answers 200 but the one SWEEP_NOT_FOUND names, so the
//   claim covers each route's whole read path;
// - reads outside a run return res_e_ ids, run reads keep counter ids, and no table holds a res_e_ id after the
//   scenario flows (deliver, routine run, approve, Undo, chat, MCP-style tool reads);
// - a cold start on the restored snapshot and its first tick write 0 rows, and so do a second boot and its first tick;
// - the read-only showcase: a cold start plus a GET sweep writes 0 rows, and every mutation is refused.
// Rows are counted at the emulated storage, so writes outside the drizzle facade (small state, migrations) count too.
// Node keeps counter ids unless WEFT_EPHEMERAL_READ_IDS=1.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { EPHEMERAL_READ_ID } from "@weft/executor";
import { createTestWeft } from "../src/testing";
import { buildSeededWorld, openDurableWorld, type DurableTestWorld, type SeededWorld } from "./support/durable-world";
import { addSweepArtifact, getSweep, getSweepPaths, SWEEP_NOT_FOUND, SWEPT_GET_ROUTES } from "./support/sweep";

let seed: SeededWorld;
let rich: SeededWorld;
beforeAll(async () => { seed = await buildSeededWorld(); rich = await buildSeededWorld("rich"); }, 180_000);
afterAll(() => { seed?.dispose(); rich?.dispose(); });

/** Rows written at the storage, by anyone, while `fn` runs. */
async function storageWrites(w: Pick<DurableTestWorld, "storage">, fn: () => Promise<unknown>): Promise<number> {
  const before = w.storage.stats().rowsWritten;
  await fn();
  return w.storage.stats().rowsWritten - before;
}


const json = async (res: Response) => JSON.parse(await res.text()) as any;
const req = (w: DurableTestWorld, method: string, path: string, body?: unknown, who = "usr_dana") =>
  w.weft.app.request(path, { method, headers: { ...w.headers(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const settle = async (w: DurableTestWorld) => {
  await (w.weft.agent as unknown as { idle(): Promise<void> }).idle();
  await (w.weft.routines as unknown as { drain(ms?: number): Promise<boolean> }).drain(10_000);
  await (w.weft.agent as unknown as { idle(): Promise<void> }).idle();
};

/** Every text cell of every table that holds an ephemeral read id. */
function ephemeralIdsInTables(w: DurableTestWorld): string[] {
  const hits: string[] = [];
  const tables = w.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").toArray().map((r) => r.name);
  for (const t of tables) {
    const cols = w.storage.sql.exec<{ name: string; type: string }>(`SELECT name, type FROM pragma_table_info('${t}')`).toArray().filter((c) => !/blob/i.test(c.type));
    for (const c of cols) {
      const n = Number(w.storage.sql.exec(`SELECT count(*) AS n FROM "${t}" WHERE CAST("${c.name}" AS TEXT) LIKE '%res\\_e\\_%' ESCAPE '\\'`).one().n);
      if (n) hits.push(`${t}.${c.name}: ${n}`);
    }
  }
  return hits;
}

describe("the GET sweep on the rich world", () => {
  let r: DurableTestWorld;
  beforeAll(async () => { r = await openDurableWorld(rich, { copy: true }); await addSweepArtifact(r); }, 120_000);
  afterAll(async () => { await r?.close(); });

  it("every swept route answers 200 (but the listed not-found), and the whole sweep writes 0 rows", async () => {
    const sweep = await getSweep(r);
    expect(SWEPT_GET_ROUTES.length).toBeGreaterThanOrEqual(67);
    expect(sweep.map((x) => x.route)).toEqual(SWEPT_GET_ROUTES.map((x) => x.path));
    r.meter.reset();
    const statuses: Record<string, number> = {};
    const written = await storageWrites(r, async () => {
      for (const x of sweep) statuses[x.route] = (await req(r, "GET", x.path, undefined, x.who)).status;
    });
    const expected = Object.fromEntries(sweep.map((x) => [x.route, SWEEP_NOT_FOUND[x.route] ? 404 : 200]));
    expect(statuses).toEqual(expected);
    expect(Object.keys(SWEEP_NOT_FOUND).every((route) => route in statuses)).toBe(true);
    const t = r.meter.totals();
    expect(t.statements).toBeGreaterThan(sweep.length);
    expect({ rowsWritten: t.rowsWritten, tablesWritten: t.tablesWritten, storageRowsWritten: written }).toEqual({ rowsWritten: 0, tablesWritten: [], storageRowsWritten: 0 });
  });
});

describe("reads on the durable platform", () => {
  let w: DurableTestWorld;
  beforeAll(async () => { w = await openDurableWorld(seed, { copy: true }); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it("names the query parameters each GET's route read in x-weft-query, so a parameter it ignores cannot vary the showcase memo's key", async () => {
    const workers = await req(w, "GET", "/v1/workers?status=active&q=zzz&cb=1&order=x");
    expect(workers.status).toBe(200);
    expect(workers.headers.get("x-weft-query")).toBe("afterId,beforeId,limit,state,status,type");
    const search = await req(w, "GET", "/v1/memory/search?q=payroll&limit=3&status=x");
    expect(search.headers.get("x-weft-query")).toBe("at,folders,limit,q");
    // Only what the route read: never the client's other parameters, and none for a route that reads none.
    expect((await req(w, "GET", "/v1/tax/rates?limit=3")).headers.get("x-weft-query")).toBe("jurisdiction");
    const stats = await req(w, "GET", "/v1/stats?limit=3&q=1");
    expect(stats.status).toBe(200);
    expect(stats.headers.get("x-weft-query")).toBe("");
    // Node's app has no hosted layer and no such header.
    const node = await createTestWeft();
    try {
      expect((await node.app.request("/v1/health", { headers: node.uiHeaders("usr_dana") })).headers.get("x-weft-query")).toBeNull();
    } finally { await node.close(); }
  });

  it("a read outside a run returns a res_e_ id and mints nothing; run reads keep counter ids", async () => {
    const counter = () => Number(w.storage.sql.exec("SELECT next FROM id_counters WHERE prefix = 'res_'").toArray()[0]?.next ?? 0);
    const before = counter();
    const out = await json(await req(w, "POST", "/v1/tools/people.search", {}));
    expect(out.resultId ?? out.data?.resultId ?? JSON.stringify(out)).toMatch(EPHEMERAL_READ_ID);
    expect(counter()).toBe(before);
    const run = await json(await req(w, "POST", "/v1/agent/runs", { text: "How many people work here?" }));
    await settle(w);
    const calls = w.storage.sql.exec<{ outcome_json: string }>("SELECT outcome_json FROM exec_calls WHERE run_id = ?", run.runId).toArray();
    for (const c of calls) {
      const o = JSON.parse(c.outcome_json) as { ok: boolean; status?: string; resultId?: string };
      if (o.ok && o.status === "done") expect(o.resultId).toMatch(/^res_\d{4,}$/);
    }
  });

  it("no table holds a res_e_ id after the scenario flows", async () => {
    expect((await req(w, "POST", "/v1/sim/notices/deliver", { scenario: "ca_de2088_rate_change" })).status).toBe(200);
    await w.weft.scheduler.tick();
    await settle(w);
    const pending = (await json(await req(w, "GET", "/v1/proposals?status=pending&limit=100"))).data as { id: string; command: string | null }[];
    expect(pending.length).toBeGreaterThan(0);
    for (const p of pending) expect((await req(w, "POST", `/v1/proposals/${p.id}/approve`, {})).status).toBeLessThan(500);
    await settle(w);
    const rate = w.storage.sql.exec<{ seq: number }>("SELECT seq FROM actions WHERE command = 'tax.update_rate' ORDER BY seq DESC LIMIT 1").toArray()[0];
    if (rate) expect((await req(w, "POST", `/v1/actions/${rate.seq}/rollback`, {})).status).toBeLessThan(500);
    for (const text of ["Show payroll cost by month", "Who is out next week?"]) await req(w, "POST", "/v1/agent/runs", { text });
    await settle(w);
    for (const tool of ["people.search", "payroll.list_runs", "notices.list", "time_off.list_requests", "expenses.list"]) await req(w, "POST", `/v1/tools/${tool}`, {});
    for (const p of await getSweepPaths(w)) await req(w, "GET", p);
    expect((await json(await req(w, "GET", "/v1/actions/verify"))).ok).toBe(true);
    expect(ephemeralIdsInTables(w)).toEqual([]);
  });
});

describe("cold starts", () => {
  it("a cold start on the restored snapshot and its first tick write 0 rows, and so do a second boot and its first tick", async () => {
    // The first boot of the seeded file is the first cold start of a slot restored from the snapshot.
    const first = await openDurableWorld(rich, { copy: true });
    let second: DurableTestWorld | null = null;
    try {
      expect(first.storage.stats().rowsWritten).toBe(0);
      expect(await storageWrites(first, () => first.weft.scheduler.tick())).toBe(0);
      let t = { statements: 0, rowsWritten: 0, tablesWritten: [] as string[], tablesRead: [] as string[] };
      const written = await storageWrites(first, async () => {
        second = await first.reboot();
        second.meter.reset();
        await second.weft.scheduler.tick();
        t = second.meter.totals();
      });
      expect(t.statements).toBeGreaterThan(0);
      expect({ rowsWritten: t.rowsWritten, tablesWritten: t.tablesWritten, storageRowsWritten: written }).toEqual({ rowsWritten: 0, tablesWritten: [], storageRowsWritten: 0 });
      // The prebuilt hash gate skipped the comparison: the routine rows were never loaded to compare.
      expect(t.tablesRead).toContain("kv_state");
    } finally { await ((second as DurableTestWorld | null) ?? first).close(); }
  });

  it("the read-only showcase: a cold start and a GET sweep write 0 rows, and every mutation is refused", async () => {
    const show = await openDurableWorld(rich, { copy: true, world: { slot: "showcase", gen: 1, mode: "showcase" } });
    let again: DurableTestWorld | null = null;
    try {
      expect(show.storage.stats().rowsWritten).toBe(0);
      // Nothing is reset between the cold start and the sweep: the boot's own writes are counted.
      const written = await storageWrites(show, async () => {
        again = await show.reboot();
        for (const x of await getSweep(again)) await req(again, "GET", x.path, undefined, x.who);
      });
      expect(written).toBe(0);
      const w2 = again as unknown as DurableTestWorld;
      expect(w2.meter.totals().rowsWritten).toBe(0);
      const refused = await storageWrites(w2, async () => {
        const res = await req(w2, "POST", "/v1/sim/clock/advance", { by: "PT1H" });
        expect(res.status).toBe(409);
        expect(await json(res)).toMatchObject({ code: "WORLD_READ_ONLY" });
      });
      expect(refused).toBe(0);
    } finally { await ((again as DurableTestWorld | null) ?? show).close().catch(() => undefined); }
  });
});

describe("Node", () => {
  it("with counter ids (the Node default) the same sweep mints a res_ id per read command, the rows the durable platform saves", async () => {
    const d = await openDurableWorld(seed, { copy: true });
    const paths = await getSweepPaths(d);
    await d.close();
    const prev = process.env.WEFT_EPHEMERAL_READ_IDS;
    delete process.env.WEFT_EPHEMERAL_READ_IDS;
    const n = await createTestWeft();
    try {
      const counter = async () => Number((await n.db.all<{ next: number }>(sql`SELECT next FROM id_counters WHERE prefix = 'res_'`))[0]?.next ?? 0);
      const before = await counter();
      for (const p of paths) await n.app.request(p, { headers: n.uiHeaders("usr_dana") });
      expect(await counter() - before).toBeGreaterThanOrEqual(9);
    } finally {
      await n.close();
      if (prev !== undefined) process.env.WEFT_EPHEMERAL_READ_IDS = prev;
    }
  });

  it("keeps counter ids for reads by default, and ephemeral ids with WEFT_EPHEMERAL_READ_IDS=1", async () => {
    const prev = process.env.WEFT_EPHEMERAL_READ_IDS;
    try {
      delete process.env.WEFT_EPHEMERAL_READ_IDS;
      const a = await createTestWeft();
      try {
        const out = await json(await a.app.request("/v1/tools/people.search", { method: "POST", headers: { ...a.uiHeaders("usr_dana"), "content-type": "application/json" }, body: JSON.stringify({}) }));
        expect(out.resultId).toMatch(/^res_\d{4,}$/);
      } finally { await a.close(); }
      process.env.WEFT_EPHEMERAL_READ_IDS = "1";
      const b = await createTestWeft();
      try {
        const n = async () => Number((await b.db.all<{ next: number }>(sql`SELECT next FROM id_counters WHERE prefix = 'res_'`))[0]?.next ?? 0);
        const before = await n();
        const out = await json(await b.app.request("/v1/tools/people.search", { method: "POST", headers: { ...b.uiHeaders("usr_dana"), "content-type": "application/json" }, body: JSON.stringify({}) }));
        expect(out.resultId).toMatch(EPHEMERAL_READ_ID);
        expect(await n()).toBe(before);
      } finally { await b.close(); }
    } finally {
      if (prev === undefined) delete process.env.WEFT_EPHEMERAL_READ_IDS; else process.env.WEFT_EPHEMERAL_READ_IDS = prev;
    }
  });
});
