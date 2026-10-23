// SpendDO's ledger on node:sqlite: the file ledger's fold, the frozen run, day and live caps, and the hosted
// visitor, IP-hash and neuron caps, orphans settled at their worst case (design 4.3, 5.2, 6.3, section 0), and the
// persisted day totals that keep every read flat on a ledger that just woke from hibernation (design 5.5).
import { describe, expect, it } from "vitest";
import { HOSTED_CAP_DEFAULTS, ORPHAN_SETTLE_MS, type HostedCaps } from "../../src/shared/contracts";
import { createSqlSpendLedger, fold, migrateSpend, PRUNE_BATCH, rebuildSpendTotals, SPEND_SCHEMA_VERSION, type SpendRow } from "../../src/core/spend/ledger";
import { memorySql, readMeter } from "./sqlite";

const USD = 1e6;

function ledger(caps: Partial<HostedCaps> = {}, start = "2026-10-26T12:00:00.000Z") {
  const s = memorySql();
  migrateSpend(s);
  let now = new Date(start);
  const c: HostedCaps = { ...HOSTED_CAP_DEFAULTS, ...caps };
  const l = createSqlSpendLedger(s, { caps: () => c, wallNow: () => now });
  return { l, s, caps: c, at: (iso: string) => { now = new Date(iso); }, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

const reserve = (l: ReturnType<typeof ledger>["l"], usd: number, o: Partial<Parameters<ReturnType<typeof ledger>["l"]["reserve"]>[0]> = {}) =>
  l.reserve({ runId: "run_0001", usdMicros: usd * USD, model: "gpt-5.6-luna", live: true, world: "slot-1:gen-1", visitor: "vis_a", ipHash: "ip_a", ...o });

describe("SpendDO ledger", () => {
  it("migrates idempotently and refuses a newer schema", () => {
    const s = memorySql();
    migrateSpend(s);
    migrateSpend(s);
    s.sql.exec(`UPDATE spend_meta SET v = '99' WHERE k = 'schema'`);
    expect(() => migrateSpend(s)).toThrow(/newer/);
  });

  it("adds the indexes to a ledger made before them, and creating them again changes nothing", () => {
    const s = memorySql();
    const indexes = () => s.sql.exec<{ name: string; sql: string }>(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`).toArray();
    // The schema as it was before the reservation-time, visitor and IP-hash indexes, with an entry in it.
    legacySchema(s, { indexes: false });
    s.sql.exec(`INSERT INTO spend_entries (at, day, kind, reservation_id, usd_micros, model, live) VALUES ('2026-10-26T11:00:00.000Z', '2026-10-26', 'reserve', 'rsv_old', 7, 'm', 1)`);
    migrateSpend(s);
    const once = indexes();
    expect(once.map((i) => i.name)).toEqual(expect.arrayContaining(["spend_entries_day", "spend_entries_reserve_at", "spend_entries_rsv", "spend_entries_run", "spend_entries_visitor", "spend_entries_ip", "neuron_entries_day"]));
    // The live index only the in-memory totals were built through is gone.
    expect(once.map((i) => i.name)).not.toContain("spend_entries_live");
    migrateSpend(s);
    migrateSpend(s);
    expect(indexes()).toEqual(once);
    expect(s.sql.exec(`SELECT v FROM spend_meta WHERE k = 'schema'`).toArray()).toEqual([{ v: SPEND_SCHEMA_VERSION }]);
    const l = createSqlSpendLedger(s, { caps: () => HOSTED_CAP_DEFAULTS, wallNow: () => new Date("2026-10-26T12:00:00.000Z") });
    expect(l.committed({ day: "2026-10-26" })).toEqual({ settledMicros: 0, openMicros: 7, neurons: 0 });
  });

  it("upgrades a schema 1 ledger once: its day totals are built from the entries it holds, and a later start builds nothing", () => {
    const s = memorySql();
    legacySchema(s, { indexes: true });
    const row = s.db.prepare(`INSERT INTO spend_entries (at, day, world, run_id, kind, reservation_id, usd_micros, model, live, visitor, ip_hash, neurons, product)
      VALUES (?, ?, 'slot-1:gen-1', ?, ?, ?, ?, 'gpt-5.6-luna', ?, ?, 'ip_a', ?, ?)`);
    // Three days of history: settled, released and still open reservations, some live, some with neurons.
    for (let i = 0; i < 3_000; i++) {
      const day = ["2026-10-24", "2026-10-25", "2026-10-26"][i % 3]!;
      const product = i % 7 === 0 ? "ocr" : i % 5 === 0 ? "agent" : null;
      row.run(`${day}T10:00:00.000Z`, day, `run_m${i}`, "reserve", `rsv_m${i}`, 1000, i % 2, `vis_${i % 11}`, product ? 40 : 0, product);
      if (i % 4 === 0) row.run(`${day}T10:01:00.000Z`, day, `run_m${i}`, "settle", `rsv_m${i}`, 700, i % 2, `vis_${i % 11}`, product ? 30 : 0, product);
      else if (i % 4 === 1) row.run(`${day}T10:01:00.000Z`, day, `run_m${i}`, "release", `rsv_m${i}`, 0, i % 2, `vis_${i % 11}`, 0, product);
    }
    const nrow = s.db.prepare(`INSERT INTO neuron_entries (at, day, product, model, neurons) VALUES (?, ?, ?, '@cf/x', 3)`);
    for (let i = 0; i < 300; i++) nrow.run("2026-10-26T09:00:00.000Z", "2026-10-26", ["ocr", "dictation", "embeddings"][i % 3]!);
    // The live totals of entries pruned before the upgrade, carried in spend_meta.
    s.sql.exec(`INSERT INTO spend_meta (k, v) VALUES ('live.carry', ?)`, JSON.stringify({ settledMicros: 5_000, openMicros: 0, neurons: 9 }));
    const caps = { ...HOSTED_CAP_DEFAULTS, dayUsd: 1_000, runUsd: 1_000, visitorDayUsd: 1_000, ipDayUsd: 1_000 };
    // What schema 1 answered (it folded the entries in memory), computed here from the entries.
    const folded = (keep: (r: SpendRow) => boolean) => {
      const t = { settledMicros: 0, openMicros: 0, neurons: 0 };
      for (const f of fold(s.db.prepare(`SELECT * FROM spend_entries ORDER BY seq`).all() as unknown as SpendRow[]).values()) {
        if (!keep(f.r)) continue;
        if (f.open) t.openMicros += f.micros; else t.settledMicros += f.micros;
        t.neurons += f.neurons;
      }
      return t;
    };
    const meter = readMeter(s);
    migrateSpend(s);
    // The upgrade reads each entry once (and each direct neuron entry once, summed by day and product).
    expect(meter.rows).toBeLessThanOrEqual(5_000);
    expect(s.sql.exec(`SELECT v FROM spend_meta WHERE k = 'schema'`).toArray()).toEqual([{ v: "2" }]);
    expect(persistedDays(s)).toEqual(foldedDays(s));
    const l = createSqlSpendLedger(s, { caps: () => caps, wallNow: () => new Date("2026-10-26T12:00:00.000Z") });
    for (const day of ["2026-10-24", "2026-10-25", "2026-10-26"]) {
      expect(l.committed({ day }), day).toEqual(folded((r) => r.day === day));
      expect(l.committed({ day, live: false }), day).toEqual(folded((r) => r.day === day && r.live === 0));
    }
    const live = folded((r) => r.live === 1);
    expect(l.committed({ live: true })).toEqual({ settledMicros: live.settledMicros + 5_000, openMicros: live.openMicros, neurons: live.neurons + 9 });
    const st = l.status({});
    expect(st.neurons.byProduct).toEqual({
      agent: folded((r) => r.day === "2026-10-26" && r.product === "agent").neurons, ocr: folded((r) => r.day === "2026-10-26" && r.product === "ocr").neurons + 300,
      embeddings: 300, dictation: 300,
    });
    expect(st.openReservations).toBe((s.db.prepare(`SELECT COUNT(*) AS n FROM spend_entries r WHERE day = '2026-10-26' AND kind = 'reserve' AND NOT EXISTS (SELECT 1 FROM spend_entries x WHERE x.reservation_id = r.reservation_id AND x.kind != 'reserve')`).get() as { n: number }).n);
    // A later start (every cold start runs the migration) reads the schema row and builds nothing.
    const before = meter.rows;
    migrateSpend(s);
    expect(meter.rows - before).toBe(1);
    expect(persistedDays(s)).toEqual(foldedDays(s));
  });

  it("prunes a backlog of old entries a bounded batch per sweep, never splitting a reservation from its close", () => {
    const { l, s, advance } = ledger({ dayUsd: 1_000, runUsd: 1_000, visitorDayUsd: 1_000, ipDayUsd: 1_000, liveUsd: 1_000 }, "2026-10-26T12:00:00.000Z");
    const n = Math.floor(PRUNE_BATCH * 2.5);
    const row = s.db.prepare(`INSERT INTO spend_entries (at, day, world, run_id, kind, reservation_id, usd_micros, model, live, visitor, ip_hash, neurons, product)
      VALUES (?, ?, 'slot-1:gen-1', ?, ?, ?, ?, 'gpt-5.6-luna', ?, 'vis_a', 'ip_a', 0, NULL)`);
    // Old days, every reservation before any of their closes, so a batch cut by rows would split them.
    const day = (i: number) => (i % 2 ? "2026-10-20" : "2026-10-21");
    for (let i = 0; i < n; i++) row.run(`${day(i)}T10:00:00.000Z`, day(i), `run_p${i}`, "reserve", `rsv_p${i}`, 1000, i % 3 ? 1 : 0);
    // All but the last are settled at 900; the last stays open (counted at its reserved 1,000).
    for (let i = 0; i < n - 1; i++) row.run(`${day(i)}T11:00:00.000Z`, day(i), `run_p${i}`, "settle", `rsv_p${i}`, 900, i % 3 ? 1 : 0);
    // A close whose reservation is long gone, which the fold ignores.
    row.run("2026-10-20T11:00:00.000Z", "2026-10-20", "run_x", "settle", "rsv_gone", 5, 1);
    const nrow = s.db.prepare(`INSERT INTO neuron_entries (at, day, product, model, neurons) VALUES (?, ?, 'ocr', '@cf/x', 1)`);
    for (let i = 0; i < n; i++) nrow.run(`${day(i)}T10:00:00.000Z`, day(i));
    // Written past the ledger: its day totals are built from them, as the schema 1 upgrade builds them.
    rebuildSpendTotals(s);
    const live = Array.from({ length: n }, (_, i) => i).filter((i) => i % 3);
    const expected = live.reduce((t, i) => t + (i === n - 1 ? 1000 : 900), 0);
    expect(l.status({}).spentMicros.live).toBe(expected);
    const count = (t: string) => Number(s.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`).toArray()[0]!.n);
    let spend = count("spend_entries"), neurons = count("neuron_entries"), sweeps = 0;
    const meter = readMeter(s);
    while (spend > 0 || neurons > 0) {
      advance(ORPHAN_SETTLE_MS);
      sweeps += 1;
      const read = meter.rows;
      l.settleOrphans();
      // What a sweep reads is bounded by its batches (spend rows, then direct neuron rows), not by the backlog.
      expect(meter.rows - read).toBeLessThanOrEqual(3 * PRUNE_BATCH + 10);
      // Each batch left its days' rows: what is persisted is the fold of what is left.
      expect(persistedDays(s)).toEqual(foldedDays(s));
      const s2 = count("spend_entries"), n2 = count("neuron_entries");
      expect(spend - s2).toBeLessThanOrEqual(2 * PRUNE_BATCH);
      expect(neurons - n2).toBeLessThanOrEqual(PRUNE_BATCH);
      spend = s2; neurons = n2;
      expect(sweeps).toBeLessThan(10);
    }
    expect(sweeps).toBe(3);
    // Every old day's row went with its last entry.
    expect(s.sql.exec(`SELECT day FROM spend_days`).toArray()).toEqual([]);
    // The pruned live rows' totals carried over whole: each reservation went with its close.
    const fresh = createSqlSpendLedger(s, { caps: () => ({ ...HOSTED_CAP_DEFAULTS, liveUsd: 1_000 }), wallNow: () => new Date("2026-10-26T13:00:00.000Z") });
    expect(fresh.status({}).spentMicros.live).toBe(expected);
    expect(l.status({}).spentMicros.live).toBe(expected);
    expect(fresh.committed({ live: true })).toEqual({ settledMicros: expected - 1000, openMicros: 1000, neurons: 0 });
  });

  it("folds like the file ledger: open counts as spent, settle replaces, release zeroes", () => {
    const { l } = ledger();
    const a = reserve(l, 0.04);
    const b = reserve(l, 0.03, { runId: "run_0002" });
    expect(a.ok && b.ok).toBe(true);
    expect(l.committed({ day: "2026-10-26" })).toMatchObject({ openMicros: 70_000, settledMicros: 0 });
    l.settle(a.ok ? a.reservationId : "", 12_345);
    l.release(b.ok ? b.reservationId : "");
    expect(l.committed({ day: "2026-10-26" })).toMatchObject({ openMicros: 0, settledMicros: 12_345 });
    expect(l.spent({ day: "2026-10-26" })).toBe(12_345);
    // A replayed settle (at-least-once alarms) writes nothing more.
    l.settle(a.ok ? a.reservationId : "", 99_999);
    expect(l.spent({ day: "2026-10-26" })).toBe(12_345);
    expect(l.entries().filter((e) => e.kind !== "reserve")).toHaveLength(2);
  });

  it("keys the run cap by world and run id, scaled by runCapScale", () => {
    const { l } = ledger({ runUsd: 0.1 });
    expect(reserve(l, 0.08).ok).toBe(true);
    const over = reserve(l, 0.03);
    expect(over).toMatchObject({ ok: false, code: "BUDGET_EXCEEDED", cap: "run", hostedCap: "run", spentMicros: 80_000, capMicros: 100_000 });
    // The same run id in the next generation is another run.
    expect(reserve(l, 0.08, { world: "slot-1:gen-2" }).ok).toBe(true);
    expect(reserve(l, 0.03, { runCapScale: 2 }).ok).toBe(true);
  });

  it("holds the day cap across worlds, and the visitor and IP-hash caps follow the day cap unless set", () => {
    const { l } = ledger({ dayUsd: 0.2, runUsd: 1, visitorDayUsd: 0.2, ipDayUsd: 0.2 });
    expect(reserve(l, 0.1, { world: "slot-1:gen-1", runId: "run_0001", visitor: "vis_a", ipHash: "ip_a" }).ok).toBe(true);
    expect(reserve(l, 0.09, { world: "slot-2:gen-1", runId: "run_0001", visitor: "vis_b", ipHash: "ip_b" }).ok).toBe(true);
    expect(reserve(l, 0.02, { world: "slot-2:gen-1", runId: "run_0002", visitor: "vis_c", ipHash: "ip_c" })).toMatchObject({ ok: false, cap: "day", hostedCap: "day" });
  });

  it("refuses past the visitor cap and the IP-hash cap, reporting them as day caps", () => {
    const { l } = ledger({ dayUsd: 2, runUsd: 1, visitorDayUsd: 0.1, ipDayUsd: 0.15 });
    expect(reserve(l, 0.08, { visitor: "vis_a", ipHash: "ip_x" }).ok).toBe(true);
    expect(reserve(l, 0.03, { runId: "run_0002", visitor: "vis_a", ipHash: "ip_x" })).toMatchObject({ ok: false, cap: "day", hostedCap: "visitor" });
    expect(reserve(l, 0.08, { runId: "run_0003", visitor: "vis_b", ipHash: "ip_x" })).toMatchObject({ ok: false, cap: "day", hostedCap: "ip" });
    expect(reserve(l, 0.06, { runId: "run_0004", visitor: "vis_b", ipHash: "ip_y" }).ok).toBe(true);
  });

  it("has no cumulative live cap by default (section 0), and enforces one when set", () => {
    const off = ledger({ dayUsd: 100, runUsd: 100, visitorDayUsd: 100, ipDayUsd: 100 });
    for (let i = 0; i < 6; i++) {
      expect(reserve(off.l, 1, { runId: `run_${i}` }).ok).toBe(true);
      off.advance(86_400_000);
    }
    const on = ledger({ dayUsd: 100, runUsd: 100, visitorDayUsd: 100, ipDayUsd: 100, liveUsd: 0.5 });
    expect(reserve(on.l, 0.4).ok).toBe(true);
    on.advance(86_400_000);
    expect(reserve(on.l, 0.2, { runId: "run_0002" })).toMatchObject({ ok: false, cap: "live", hostedCap: "live" });
    expect(reserve(on.l, 0.2, { runId: "run_0003", live: false }).ok).toBe(true);
  });

  it("enforces the neuron day cap and each product's share (design 5.2)", () => {
    const { l } = ledger({ neuronsDay: 5000 });
    const n = (neurons: number, product: "agent" | "ocr" | "embeddings" | "dictation", runId: string | null = null) =>
      l.reserve({ runId, usdMicros: 0, model: "@cf/openai/gpt-oss-120b", live: true, neurons, product, world: "slot-1:gen-1" });
    expect(n(3900, "agent", "run_0001").ok).toBe(true);
    expect(n(200, "agent", "run_0002")).toMatchObject({ ok: false, hostedCap: "neurons", cap: "day" });
    expect(n(480, "ocr").ok).toBe(true);
    expect(n(30, "ocr")).toMatchObject({ ok: false, hostedCap: "neurons" });
    l.recordNeurons({ product: "dictation", model: "@cf/openai/whisper-large-v3-turbo", neurons: 290 });
    expect(l.neuronsLeft("dictation")).toEqual({ product: 10, day: 5000 - 3900 - 480 - 290 });
    expect(l.status({}).neurons).toEqual({ used: 4670, byProduct: { agent: 3900, ocr: 480, embeddings: 0, dictation: 290 } });
  });

  it("settles a reservation by its actual neurons, or keeps the reserved neurons", () => {
    const { l } = ledger();
    const r = l.reserve({ runId: "run_0001", usdMicros: 1000, model: "@cf/openai/gpt-oss-120b", live: true, neurons: 300, product: "agent", world: "slot-1:gen-1" });
    expect(r.ok).toBe(true);
    l.settle(r.ok ? r.reservationId : "", 500, { neurons: 120 });
    expect(l.status({}).neurons.used).toBe(120);
  });

  it("settles orphaned reservations at their worst case after 15 minutes, once", () => {
    const { l, advance } = ledger();
    expect(reserve(l, 0.05).ok).toBe(true);
    advance(ORPHAN_SETTLE_MS - 1000);
    expect(l.settleOrphans()).toBe(0);
    advance(2000);
    expect(l.settleOrphans()).toBe(1);
    expect(l.settleOrphans()).toBe(0);
    expect(l.spent({ day: "2026-10-26" })).toBe(50_000);
  });

  it("keeps a settle in its reservation's day across midnight", () => {
    const { l, at } = ledger({}, "2026-10-26T23:59:30.000Z");
    const r = reserve(l, 0.05);
    at("2026-10-27T00:00:30.000Z");
    l.settle(r.ok ? r.reservationId : "", 20_000);
    expect(l.spent({ day: "2026-10-26" })).toBe(20_000);
    expect(l.spent({ day: "2026-10-27" })).toBe(0);
  });

  it("prunes entries older than three days in the orphan sweep, and the live cap still counts the pruned ones", () => {
    const { l, s, advance, caps } = ledger({ dayUsd: 100, runUsd: 100, visitorDayUsd: 100, ipDayUsd: 100, liveUsd: 0.5 });
    const r = reserve(l, 0.3);
    if (r.ok) l.settle(r.reservationId, 300_000);
    // An orphan that is never closed counts at its reserved amount, before and after it is pruned.
    expect(reserve(l, 0.1, { runId: "run_0002" }).ok).toBe(true);
    l.recordNeurons({ product: "ocr", model: "@cf/x", neurons: 10 });
    advance(86_400_000);
    expect(l.settleOrphans()).toBe(1);
    expect(l.entries("2026-10-26")).toHaveLength(4);
    advance(2 * 86_400_000);
    l.settleOrphans();
    expect(l.entries("2026-10-26")).toEqual([]);
    expect(s.sql.exec(`SELECT COUNT(*) AS n FROM spend_entries`).toArray()[0]!.n).toBe(0);
    expect(s.sql.exec(`SELECT COUNT(*) AS n FROM neuron_entries`).toArray()[0]!.n).toBe(0);
    expect(l.status({}).spentMicros.live).toBe(400_000);
    expect(reserve(l, 0.2, { runId: "run_0003" })).toMatchObject({ ok: false, hostedCap: "live", spentMicros: 400_000 });
    // A restarted object (a fresh ledger over the same storage) reads the carried totals back.
    const again = createSqlSpendLedger(s, { caps: () => caps, wallNow: () => new Date("2026-10-29T12:00:00.000Z") });
    expect(again.status({}).spentMicros.live).toBe(400_000);
    expect(again.reserve({ runId: "run_0004", usdMicros: 0.2 * USD, model: "gpt-5.6-luna", live: true, world: "slot-1:gen-1" })).toMatchObject({ ok: false, hostedCap: "live" });
    expect(again.reserve({ runId: "run_0005", usdMicros: 0.05 * USD, model: "gpt-5.6-luna", live: true, world: "slot-1:gen-1" }).ok).toBe(true);
  });

  it("keeps today's totals in step with every write, as a fresh read of the day would fold them", () => {
    const { l, s, caps, advance } = ledger({ neuronsDay: 5000 });
    const a = reserve(l, 0.02, { visitor: "vis_a", ipHash: "ip_a" });
    const b = l.reserve({ runId: "run_0002", usdMicros: 1000, model: "@cf/openai/gpt-oss-120b", live: true, neurons: 300, product: "agent", world: "slot-1:gen-1", visitor: "vis_b", ipHash: "ip_a" });
    reserve(l, 0.01, { runId: "run_0003", visitor: "vis_b", ipHash: "ip_b" });
    l.recordNeurons({ product: "dictation", model: "@cf/w", neurons: 20 });
    if (a.ok) l.settle(a.reservationId, 5_000);
    if (b.ok) l.release(b.reservationId);
    advance(ORPHAN_SETTLE_MS + 1000);
    l.settleOrphans();
    const fresh = createSqlSpendLedger(s, { caps: () => caps, wallNow: () => new Date("2026-10-26T12:16:01.000Z") });
    for (const scope of [{}, { visitor: "vis_a", ipHash: "ip_a" }, { visitor: "vis_b", ipHash: "ip_b" }]) expect(l.status(scope)).toEqual(fresh.status(scope));
    expect(l.committed({ day: "2026-10-26", visitor: "vis_b" })).toEqual(fresh.committed({ day: "2026-10-26", visitor: "vis_b" }));
    expect(l.status({}).spentMicros).toMatchObject({ day: 15_000, live: 15_000 });
  });

  it("reports today's status per visitor and IP hash", () => {
    const { l } = ledger();
    reserve(l, 0.01, { visitor: "vis_a", ipHash: "ip_a" });
    reserve(l, 0.02, { runId: "run_0002", visitor: "vis_b", ipHash: "ip_a" });
    const st = l.status({ visitor: "vis_a", ipHash: "ip_a" });
    expect(st).toMatchObject({ day: "2026-10-26", spentMicros: { day: 30_000, visitor: 10_000, ip: 30_000, live: 30_000 }, openReservations: 2 });
    expect(l.status({}).spentMicros.visitor).toBeNull();
  });

  it("fold ignores a settle without its reservation", () => {
    const rows: SpendRow[] = [{ at: "x", day: "d", world: null, run_id: null, kind: "settle", reservation_id: "rsv_x", usd_micros: 5, model: "m", live: 1, visitor: null, ip_hash: null, neurons: 0, product: null }];
    expect(fold(rows).size).toBe(0);
  });
});


/** The ledger's tables as schema "1" made them (no spend_days); `indexes` adds the indexes it had by then. */
function legacySchema(s: ReturnType<typeof memorySql>, o: { indexes: boolean }): void {
  s.sql.exec(`CREATE TABLE spend_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
  s.sql.exec(`INSERT INTO spend_meta (k, v) VALUES ('schema', '1')`);
  s.sql.exec(`CREATE TABLE spend_entries (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, day TEXT NOT NULL, world TEXT, run_id TEXT,
    kind TEXT NOT NULL, reservation_id TEXT NOT NULL, usd_micros INTEGER NOT NULL, model TEXT NOT NULL, live INTEGER NOT NULL, visitor TEXT,
    ip_hash TEXT, neurons INTEGER NOT NULL DEFAULT 0, product TEXT)`);
  s.sql.exec(`CREATE INDEX spend_entries_day ON spend_entries(day)`);
  if (!o.indexes) return;
  s.sql.exec(`CREATE INDEX spend_entries_rsv ON spend_entries(reservation_id)`);
  s.sql.exec(`CREATE INDEX spend_entries_run ON spend_entries(world, run_id) WHERE run_id IS NOT NULL`);
  s.sql.exec(`CREATE INDEX spend_entries_live ON spend_entries(seq) WHERE live = 1`);
  s.sql.exec(`CREATE INDEX spend_entries_reserve_at ON spend_entries(at) WHERE kind = 'reserve'`);
  s.sql.exec(`CREATE TABLE neuron_entries (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, day TEXT NOT NULL, product TEXT NOT NULL, model TEXT NOT NULL, neurons INTEGER NOT NULL)`);
  s.sql.exec(`CREATE INDEX neuron_entries_day ON neuron_entries(day)`);
}

type DayRow = Record<string, number | string>;
const DAY_KEYS = ["settled_micros", "open_micros", "open_count", "neurons", "agent_neurons", "ocr_neurons", "embeddings_neurons", "dictation_neurons", "live_settled_micros", "live_open_micros", "live_neurons"];
const nonZero = (r: DayRow) => DAY_KEYS.some((k) => Number(r[k]) !== 0);

/** spend_days as persisted, without rows that are all zeros (a day whose reservations were all released). */
function persistedDays(s: ReturnType<typeof memorySql>): DayRow[] {
  return s.db.prepare(`SELECT * FROM spend_days ORDER BY day`).all().map((r) => ({ ...(r as DayRow) })).filter(nonZero);
}

/** spend_days as a full fold of every entry left (and every direct neuron entry) would make it, computed here. */
function foldedDays(s: ReturnType<typeof memorySql>): DayRow[] {
  const days = new Map<string, DayRow>();
  const at = (day: string) => { let r = days.get(day); if (!r) { r = { day, ...Object.fromEntries(DAY_KEYS.map((k) => [k, 0])) }; days.set(day, r); } return r; };
  const add = (r: DayRow, k: string, n: number) => { r[k] = Number(r[k]) + n; };
  const rows = s.db.prepare(`SELECT * FROM spend_entries ORDER BY seq`).all() as unknown as SpendRow[];
  for (const f of fold(rows).values()) {
    const r = at(f.r.day);
    const settled = f.open ? 0 : f.micros, open = f.open ? f.micros : 0;
    add(r, "settled_micros", settled); add(r, "open_micros", open); add(r, "open_count", f.open ? 1 : 0); add(r, "neurons", f.neurons);
    const p = f.r.product ?? "agent";
    if (["agent", "ocr", "embeddings", "dictation"].includes(p)) add(r, `${p}_neurons`, f.neurons);
    if (f.r.live === 1) { add(r, "live_settled_micros", settled); add(r, "live_open_micros", open); add(r, "live_neurons", f.neurons); }
  }
  for (const d of s.db.prepare(`SELECT day, product, neurons FROM neuron_entries`).all() as { day: string; product: string; neurons: number }[]) {
    if (["agent", "ocr", "embeddings", "dictation"].includes(d.product)) add(at(d.day), `${d.product}_neurons`, d.neurons);
  }
  return [...days.values()].filter(nonZero).sort((a, b) => String(a.day).localeCompare(String(b.day)));
}

/** The live totals as a full fold of the live entries left plus the carry of the pruned ones. */
function foldedLive(s: ReturnType<typeof memorySql>) {
  const carry = s.db.prepare(`SELECT v FROM spend_meta WHERE k = 'live.carry'`).get() as { v: string } | undefined;
  const t = { settledMicros: 0, openMicros: 0, neurons: 0, ...(carry ? JSON.parse(carry.v) as object : {}) };
  for (const f of fold(s.db.prepare(`SELECT * FROM spend_entries ORDER BY seq`).all() as unknown as SpendRow[]).values()) {
    if (f.r.live !== 1) continue;
    if (f.open) t.openMicros += f.micros; else t.settledMicros += f.micros;
    t.neurons += f.neurons;
  }
  return t;
}

describe("SpendDO ledger reads, cold", () => {
  const CAPS: HostedCaps = { ...HOSTED_CAP_DEFAULTS, dayUsd: 1_000, runUsd: 1_000, visitorDayUsd: 1_000, ipDayUsd: 1_000 };
  /**
   * A ledger with `history` rows on yesterday (half of them live) and `today` reservations today, each settled, all of
   * other visitors and addresses than the ones measured. Then the object hibernates: what is measured is a FRESH
   * ledger over the same storage, built after the writes, with nothing in memory.
   */
  function seeded(o: { history: number; today: number; liveUsd?: number | null }) {
    const caps: HostedCaps = { ...CAPS, liveUsd: o.liveUsd ?? null };
    const s = memorySql();
    migrateSpend(s);
    let now = new Date("2026-10-26T12:00:00.000Z");
    const insert = s.db.prepare(`INSERT INTO spend_entries (at, day, world, run_id, kind, reservation_id, usd_micros, model, live, visitor, ip_hash, neurons, product)
      VALUES (?, ?, 'slot-1:gen-1', ?, ?, ?, 1000, 'gpt-5.6-luna', ?, ?, ?, 0, NULL)`);
    for (let i = 0; i < o.history; i += 2) {
      const at = new Date(now.getTime() - 86_400_000 - i * 1000).toISOString();
      insert.run(at, at.slice(0, 10), `run_h${i}`, "reserve", `rsv_h${i}`, i % 4 === 0 ? 1 : 0, `vis_h${i % 13}`, `ip_h${i % 5}`);
      insert.run(at, at.slice(0, 10), `run_h${i}`, "settle", `rsv_h${i}`, i % 4 === 0 ? 1 : 0, `vis_h${i % 13}`, `ip_h${i % 5}`);
    }
    // Written past the ledger: their day totals are built once, as the schema 1 upgrade builds them.
    rebuildSpendTotals(s);
    const writer = createSqlSpendLedger(s, { caps: () => caps, wallNow: () => now });
    for (let i = 0; i < o.today; i++) {
      const r = writer.reserve({ runId: `run_t${i}`, usdMicros: 1000, model: "gpt-5.6-luna", live: true, world: "slot-1:gen-1", visitor: `vis_t${i % 7}`, ipHash: `ip_t${i % 3}` });
      if (r.ok) writer.settle(r.reservationId, 900);
    }
    now = new Date(now.getTime() + 1000);
    const meter = readMeter(s);
    const fresh = () => createSqlSpendLedger(s, { caps: () => caps, wallNow: () => now });
    return { s, meter, fresh, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
  }

  /** Rows read by `fn` on a fresh (just woken) ledger, the tables it read and its index searches of the entries. */
  const cold = (x: ReturnType<typeof seeded>, fn: (l: SqlSpendLedgerT) => unknown) => {
    const l = x.fresh();
    const rows = x.meter.rows, n = x.meter.searches.length;
    x.meter.tables.clear();
    fn(l);
    return { rows: x.meter.rows - rows, tables: [...x.meter.tables].sort(), searches: x.meter.searches.slice(n).filter((d) => /^SEARCH spend_entries\b/.test(d)) };
  };

  const perCall = (o: { history: number; today: number; liveUsd?: number | null }) => {
    const x = seeded(o);
    const status = cold(x, (l) => l.status({})).rows;
    const visitorStatus = cold(x, (l) => l.status({ visitor: "vis_new", ipHash: "ip_new" })).rows;
    let id = "";
    const reserve = cold(x, (l) => {
      const r = l.reserve({ runId: "run_new", usdMicros: 1000, model: "gpt-5.6-luna", live: true, world: "slot-1:gen-1", visitor: "vis_new", ipHash: "ip_new" });
      expect(r.ok).toBe(true);
      if (r.ok) id = r.reservationId;
    }).rows;
    const settle = cold(x, (l) => l.settle(id, 500)).rows;
    // The cron's orphan sweep, 15 minutes on: the first one after a start looks back two days, the next ones only at
    // what crossed the orphan age since.
    x.advance(ORPHAN_SETTLE_MS + 1000);
    cold(x, (l) => l.settleOrphans());
    x.advance(ORPHAN_SETTLE_MS);
    const sweep = cold(x, (l) => l.settleOrphans()).rows;
    return { status, visitorStatus, reserve, settle, sweep };
  };

  it("do not grow with the table, with today's steps or with other visitors' rows, with the live cap off (section 0)", () => {
    const small = perCall({ history: 10, today: 5 });
    const large = perCall({ history: 4_000, today: 1_000 });
    expect(large).toEqual(small);
    // A status reads today's row, the day rows' live parts (yesterday and today here) and the live carry.
    expect(small.status).toBeLessThanOrEqual(4);
    expect(small.visitorStatus).toBeLessThanOrEqual(4);
    // The run cap reads the run's own rows; the day cap today's row; the reservation and its close are found by id.
    expect(small.reserve).toBeLessThanOrEqual(2);
    expect(small.settle).toBeLessThanOrEqual(4);
    expect(small.sweep).toBeLessThanOrEqual(3);
  });

  it("do not grow with the table with the live cap on either", () => {
    const small = perCall({ history: 10, today: 5, liveUsd: 1_000 });
    const large = perCall({ history: 4_000, today: 1_000, liveUsd: 1_000 });
    expect(large).toEqual(small);
    expect(small.reserve).toBeLessThanOrEqual(5);
  });

  it("answer status({}), GET /v1/agent/costs?day=<yesterday> and the live totals from the day rows: a few rows each, never an entry", () => {
    // 4,000 entries on yesterday (2026-10-25), 2,000 today, and every request reaches a ledger that just woke up.
    const x = seeded({ history: 4_000, today: 1_000 });
    const yesterday = "2026-10-25";
    for (let i = 0; i < 20; i++) {
      const st = cold(x, (l) => expect(l.status({})).toMatchObject({ day: "2026-10-26", spentMicros: { day: 900_000, live: 900_000 + 1_000 * 1_000 }, openReservations: 0 }));
      expect(st.rows).toBeLessThanOrEqual(4);
      expect(st.tables).toEqual(["spend_days", "spend_meta"]);
      // The costs route's two calls.
      const day = cold(x, (l) => expect(l.spent({ day: yesterday })).toBe(2_000 * 1000));
      expect(day.rows).toBe(1);
      expect(day.tables).toEqual(["spend_days"]);
      const live = cold(x, (l) => expect(l.spent({ live: true })).toBe(900_000 + 1_000 * 1_000));
      expect(live.rows).toBeLessThanOrEqual(3);
      expect(live.tables).toEqual(["spend_days", "spend_meta"]);
    }
    // A day outside the retained three (older, or not yet begun) answers nothing and reads nothing, every time.
    for (const day of ["2026-10-23", "2026-10-01", "2026-10-27", "2099-01-01"]) {
      expect(cold(x, (l) => expect(l.committed({ day })).toEqual({ settledMicros: 0, openMicros: 0, neurons: 0 })).rows).toBe(0);
    }
  });

  it("read a visitor's and an address's caps through their own indexes, never the whole day", () => {
    const x = seeded({ history: 2_000, today: 700 });
    // vis_t0 holds a seventh of today's reservations, ip_t0 a third: each reads only its own.
    const v = cold(x, (l) => expect(l.status({ visitor: "vis_t0", ipHash: "ip_t0" }).spentMicros).toMatchObject({ visitor: 100 * 900, ip: 234 * 900 }));
    expect(v.rows).toBeLessThanOrEqual(4 + 2 * 100 + 2 * 234);
    expect(v.searches.every((d) => /USING INDEX spend_entries_(visitor|ip) /.test(d))).toBe(true);
    const r = cold(x, (l) => expect(l.reserve({ runId: "run_v", usdMicros: 1000, model: "gpt-5.6-luna", live: true, world: "slot-1:gen-1", visitor: "vis_t0", ipHash: "ip_t0" }).ok).toBe(true));
    expect(r.searches.length).toBeGreaterThan(0);
    expect(r.searches.every((d) => /USING INDEX spend_entries_(run|visitor|ip) /.test(d))).toBe(true);
  });

  it("keep another day's totals in step with the writes that land on it, and with pruning, as a fresh read folds them", () => {
    const { l, s, caps, at } = ledger({ neuronsDay: 5000 }, "2026-10-25T23:00:00.000Z");
    const a = reserve(l, 0.02, { visitor: "vis_a", ipHash: "ip_a" });
    const b = l.reserve({ runId: "run_0002", usdMicros: 1000, model: "@cf/openai/gpt-oss-120b", live: true, neurons: 300, product: "agent", world: "slot-1:gen-1", visitor: "vis_b", ipHash: "ip_a" });
    const c = reserve(l, 0.01, { runId: "run_0003", visitor: "vis_b", ipHash: "ip_b", live: false });
    at("2026-10-26T01:00:00.000Z");
    const meter = readMeter(s);
    const days = ["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"];
    const scopes = [{}, { visitor: "vis_a" }, { visitor: "vis_b", ipHash: "ip_a" }, { live: false }, { live: true, visitor: "vis_b" }];
    const fresh = (now: string) => createSqlSpendLedger(s, { caps: () => caps, wallNow: () => new Date(now) });
    /** The day's rows read now and folded, as the file ledger folds them. */
    const read = (day: string) => {
      const t = { settledMicros: 0, openMicros: 0, neurons: 0 };
      for (const f of fold(l.entries(day)).values()) { if (f.open) t.openMicros += f.micros; else t.settledMicros += f.micros; t.neurons += f.neurons; }
      return t;
    };
    const same = (now: string) => {
      const f = fresh(now);
      const retained = new Set([0, 1, 2].map((i) => new Date(Date.parse(now) - i * 86_400_000).toISOString().slice(0, 10)));
      for (const day of days) {
        for (const scope of scopes) expect(l.committed({ ...scope, day }), `${day} ${JSON.stringify(scope)}`).toEqual(f.committed({ ...scope, day }));
        if (retained.has(day)) expect(l.committed({ day }), day).toEqual(read(day));
      }
      for (const scope of scopes) expect(l.committed(scope)).toEqual(f.committed(scope));
      expect(l.status({ visitor: "vis_b", ipHash: "ip_a" })).toEqual(f.status({ visitor: "vis_b", ipHash: "ip_a" }));
      expect(persistedDays(s)).toEqual(foldedDays(s));
      expect(f.committed({ live: true })).toEqual(foldedLive(s));
    };
    l.spent({ day: "2026-10-25" });
    // Closed after midnight: the settle and release rows land on the reservations' day, and so do their totals.
    if (a.ok) l.settle(a.reservationId, 5_000);
    if (b.ok) l.release(b.reservationId);
    const rows = meter.rows;
    expect(l.committed({ day: "2026-10-25" })).toEqual({ settledMicros: 5_000, openMicros: 10_000, neurons: 0 });
    expect(meter.rows - rows).toBe(1);
    same("2026-10-26T01:00:00.000Z");
    // The orphan settles at its reserved worst case, on its own day.
    at("2026-10-26T01:00:00.000Z");
    expect(c.ok).toBe(true);
    expect(l.settleOrphans()).toBe(1);
    expect(l.committed({ day: "2026-10-25", live: false })).toEqual({ settledMicros: 10_000, openMicros: 0, neurons: 0 });
    same("2026-10-26T01:00:00.000Z");
    // Three days on, 2026-10-25 has left the retained days and the sweep pruned it.
    at("2026-10-28T01:00:00.000Z");
    l.settleOrphans();
    expect(l.entries("2026-10-25")).toEqual([]);
    const before = meter.rows;
    expect(l.spent({ day: "2026-10-25" })).toBe(0);
    expect(meter.rows - before).toBe(0);
    same("2026-10-28T01:00:00.000Z");
  });
});

describe("SpendDO ledger's persisted totals", () => {
  /** A small deterministic generator (mulberry32), so a failure replays. */
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it("always equal a full fold of the entries, across reserves, settles and releases of earlier days' reservations, direct neurons, orphan sweeps and pruning", () => {
    const { l, s, caps, advance } = ledger({ dayUsd: 1_000, runUsd: 1_000, visitorDayUsd: 1_000, ipDayUsd: 1_000, neuronsDay: 1e9 }, "2026-10-20T08:00:00.000Z");
    const r = rng(20261026);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
    const open: string[] = [];
    let wrote = 0;
    const check = (what: string) => {
      expect(persistedDays(s), what).toEqual(foldedDays(s));
      // A fresh object (after a hibernation) answers the live totals from the day rows and the carry.
      const f = createSqlSpendLedger(s, { caps: () => caps });
      expect(f.committed({ live: true }), what).toEqual(foldedLive(s));
    };
    for (let step = 0; step < 1_200; step++) {
      const op = r();
      if (op < 0.4) {
        const neurons = r() < 0.3 ? Math.ceil(r() * 50) : 0;
        const x = l.reserve({
          runId: r() < 0.9 ? `run_${Math.floor(r() * 40)}` : null, usdMicros: Math.ceil(r() * 3000), model: "m", live: r() < 0.6, world: pick(["slot-1:gen-1", "slot-2:gen-4"]),
          visitor: pick(["vis_a", "vis_b", null]), ipHash: pick(["ip_a", "ip_b", null]), ...(neurons ? { neurons, product: pick(["agent", "ocr", "embeddings", "dictation"] as const) } : {}),
        });
        if (x.ok) { open.push(x.reservationId); wrote += 1; }
      } else if (op < 0.65 && open.length) {
        // Any open reservation, often one made on an earlier day.
        const id = open.splice(Math.floor(r() * open.length), 1)[0]!;
        if (r() < 0.7) l.settle(id, Math.floor(r() * 4000), r() < 0.5 ? { neurons: Math.floor(r() * 60) } : undefined);
        else l.release(id);
        // A replayed close changes nothing.
        if (r() < 0.1) l.settle(id, 99_999);
      } else if (op < 0.75) {
        l.recordNeurons({ product: pick(["agent", "ocr", "embeddings", "dictation"] as const), model: "@cf/x", neurons: Math.ceil(r() * 20) });
      } else if (op < 0.85) {
        l.settleOrphans();
      } else {
        // Time moves on: minutes, or across midnight, or days (so pruning starts).
        advance(pick([60_000, 20 * 60_000, 5 * 3_600_000, 26 * 3_600_000]));
      }
      if (step % 25 === 0) check(`step ${step}`);
    }
    check("end");
    expect(wrote).toBeGreaterThan(300);
    // Days on, everything is pruned: no day row is left, and the carry holds every live reservation ever made.
    advance(5 * 86_400_000);
    for (let i = 0; i < 10; i++) l.settleOrphans();
    expect(s.sql.exec(`SELECT COUNT(*) AS n FROM spend_entries`).toArray()[0]!.n).toBe(0);
    expect(s.sql.exec(`SELECT COUNT(*) AS n FROM spend_days`).toArray()[0]!.n).toBe(0);
    check("pruned");
  });

  it("are written in the same transaction as the entry: a write that throws leaves neither", () => {
    const { l, s } = ledger();
    const r = reserve(l, 0.01);
    expect(r.ok).toBe(true);
    const days = persistedDays(s);
    // The day row's upsert fails (a storage error), so the settle's entry rolls back with it.
    const exec = s.sql.exec.bind(s.sql);
    s.sql.exec = ((q: string, ...b: unknown[]) => { if (/INSERT INTO spend_days/.test(q)) throw new Error("storage busy"); return exec(q, ...b); }) as typeof s.sql.exec;
    expect(() => l.settle(r.ok ? r.reservationId : "", 5_000)).toThrow(/storage busy/);
    expect(() => reserve(l, 0.01, { runId: "run_0002" })).toThrow(/storage busy/);
    expect(() => l.recordNeurons({ product: "ocr", model: "@cf/x", neurons: 3 })).toThrow(/storage busy/);
    s.sql.exec = exec;
    expect(persistedDays(s)).toEqual(days);
    expect(l.entries()).toHaveLength(1);
    expect(s.sql.exec(`SELECT COUNT(*) AS n FROM neuron_entries`).toArray()[0]!.n).toBe(0);
    expect(persistedDays(s)).toEqual(foldedDays(s));
  });
});

type SqlSpendLedgerT = ReturnType<typeof createSqlSpendLedger>;
