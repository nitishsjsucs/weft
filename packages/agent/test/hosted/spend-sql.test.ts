// The SQL spend store SpendDO runs (spend-sql.ts; docs/cloudflare/design.md 4.1 and 8.2): its schema and version row,
// rows it reads per reservation once a day is memoized, the settled neuron record, and a restart that reads the
// ledger back. Runs on node:sqlite through the same structural storage type workerd's ctx.storage satisfies.
import { afterEach, describe, expect, it } from "vitest";
import { HOSTED_CAP_DEFAULTS } from "../../../contracts/src/ext/cf-agent";
import { createHostedSpendLedger, createSqlSpendStore, SPEND_SCHEMA_VERSION } from "../../src/index";
import { sqliteStorage, type TestStorage } from "./sqlite-storage";

const storages: TestStorage[] = [];
const storage = () => { const s = sqliteStorage(); storages.push(s); return s; };
afterEach(() => { for (const s of storages.splice(0)) s.close(); });

const input = { runId: "run_0001", usdMicros: 10_000, model: "gpt-5.6-luna", live: true, world: "slot-1:gen-1", visitor: "vis_a", ipHash: "ip_a" };

describe("the SQL spend store", () => {
  it("creates its tables, indexes and version row once; a second store on the same storage writes nothing", () => {
    const st = storage();
    createSqlSpendStore(st);
    const names = st.db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as { type: string; name: string }[];
    expect(names).toEqual([
      { type: "table", name: "neuron_entries" }, { type: "index", name: "neuron_entries_day" },
      { type: "table", name: "spend_entries" }, { type: "index", name: "spend_entries_day" }, { type: "index", name: "spend_entries_reservation" }, { type: "index", name: "spend_entries_run" },
      { type: "table", name: "spend_meta" },
    ]);
    expect(st.db.prepare("SELECT value FROM spend_meta WHERE key = 'schema'").get()).toEqual({ value: SPEND_SCHEMA_VERSION });
    const before = st.db.prepare("SELECT total_changes() AS n").get() as { n: number };
    createSqlSpendStore(st);
    expect(st.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  });

  it("refuses a storage whose schema version is not this one", () => {
    const st = storage();
    createSqlSpendStore(st);
    st.db.prepare("UPDATE spend_meta SET value = '0' WHERE key = 'schema'").run();
    expect(() => createSqlSpendStore(st)).toThrow(/spend schema version 0 is not 1/);
  });

  it("after the first reservation of a day, a reservation reads no ledger rows (memo kept current by every append)", async () => {
    const st = storage();
    const ledger = createHostedSpendLedger({ store: createSqlSpendStore(st), wallNow: () => new Date("2026-10-26T15:00:00Z") });
    const first = await ledger.reserve(input);
    if (!first.ok) throw new Error("expected ok");
    await ledger.settle(first.reservationId, 4_000);
    const selects = () => st.log.filter((q) => /^SELECT .* FROM spend_entries WHERE (day|run_id)/.test(q)).length;
    const seen = selects();
    for (let i = 0; i < 5; i++) {
      const r = await ledger.reserve(input);
      if (!r.ok) throw new Error("expected ok");
    }
    // Only the settle's lookup by reservation id reads rows; the run, day, visitor and IP checks come from memory.
    expect(selects()).toBe(seen);
    expect(await ledger.spent({ day: "2026-10-26" })).toBe(4_000);
    expect((await ledger.status({ visitor: "vis_a", ipHash: "ip_a" })).spentMicros).toEqual({ day: 54_000, visitor: 54_000, ip: 54_000, live: 0 });
  });

  it("a restarted SpendDO (a new store on the same storage) reads the same ledger and keeps every cap", async () => {
    const st = storage();
    const caps = () => ({ ...HOSTED_CAP_DEFAULTS, visitorDayUsd: 0.05 });
    const now = () => new Date("2026-10-26T15:00:00Z");
    const a = createHostedSpendLedger({ store: createSqlSpendStore(st), caps, wallNow: now });
    for (let i = 0; i < 4; i++) expect((await a.reserve({ ...input, runId: `run_${i}` })).ok).toBe(true);
    const b = createHostedSpendLedger({ store: createSqlSpendStore(st), caps, wallNow: now });
    expect(await b.reserve({ ...input, runId: "run_9", usdMicros: 20_000 })).toMatchObject({ ok: false, hostedCap: "visitor", spentMicros: 40_000, capMicros: 50_000 });
    expect((await b.status({ visitor: "vis_a" })).openReservations).toBe(4);
  });

  it("records the neurons a Workers AI reservation settled at in neuron_entries", async () => {
    const st = storage();
    const store = createSqlSpendStore(st);
    const ledger = createHostedSpendLedger({ store, wallNow: () => new Date("2026-10-26T15:00:00Z") });
    const r = await ledger.reserve({ ...input, model: "@cf/openai/gpt-oss-120b", neurons: 800, product: "agent" });
    if (!r.ok) throw new Error("expected ok");
    await ledger.settle(r.reservationId, 4_400, { neurons: 400 });
    expect(store.neuronsSettled("2026-10-26")).toEqual({ agent: 400 });
    expect(st.db.prepare("SELECT day, product, model, neurons FROM neuron_entries").all()).toEqual([{ day: "2026-10-26", product: "agent", model: "@cf/openai/gpt-oss-120b", neurons: 400 }]);
    expect((await ledger.status({})).neurons).toEqual({ used: 400, byProduct: { agent: 400, ocr: 0, embeddings: 0, dictation: 0, speech: 0 } });
  });

  it("stores the entries the file store writes, field for field", async () => {
    const st = storage();
    const store = createSqlSpendStore(st);
    store.append({ at: "2026-10-26T15:00:00.000Z", runId: null, kind: "reserve", reservationId: "rsv_1", usdMicros: 5, model: "m", live: false });
    store.append({ at: "2026-10-26T15:00:00.000Z", runId: "run_1", kind: "settle", reservationId: "rsv_1", usdMicros: 3, model: "m", live: true, world: "w", visitor: "v", ipHash: "i", neurons: 2, product: "ocr" });
    expect(store.entries({ reservationId: "rsv_1" })).toEqual([
      { at: "2026-10-26T15:00:00.000Z", runId: null, kind: "reserve", reservationId: "rsv_1", usdMicros: 5, model: "m", live: false },
      { at: "2026-10-26T15:00:00.000Z", runId: "run_1", kind: "settle", reservationId: "rsv_1", usdMicros: 3, model: "m", live: true, world: "w", visitor: "v", ipHash: "i", neurons: 2, product: "ocr" },
    ]);
    expect(store.newReservationId()).toMatch(/^rsv_[0-9a-f]{16}$/);
  });
});
