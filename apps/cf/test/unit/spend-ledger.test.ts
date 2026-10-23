// SpendDO's ledger on node:sqlite: the file ledger's fold, the frozen run, day and live caps, and the hosted
// visitor, IP-hash and neuron caps, orphans settled at their worst case (design 4.3, 5.2, 6.3, section 0).
import { describe, expect, it } from "vitest";
import { HOSTED_CAP_DEFAULTS, ORPHAN_SETTLE_MS, type HostedCaps } from "../../src/shared/contracts";
import { createSqlSpendLedger, fold, migrateSpend, PRUNE_BATCH, type SpendRow } from "../../src/core/spend/ledger";
import { memorySql } from "./sqlite";

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

  it("adds the partial indexes to a ledger made before them, and creating them again changes nothing", () => {
    const s = memorySql();
    const indexes = () => s.sql.exec<{ name: string; sql: string }>(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`).toArray();
    // The schema as it was before the live and reservation-time indexes, with an entry in it.
    s.sql.exec(`CREATE TABLE spend_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    s.sql.exec(`INSERT INTO spend_meta (k, v) VALUES ('schema', '1')`);
    s.sql.exec(`CREATE TABLE spend_entries (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, day TEXT NOT NULL, world TEXT, run_id TEXT,
      kind TEXT NOT NULL, reservation_id TEXT NOT NULL, usd_micros INTEGER NOT NULL, model TEXT NOT NULL, live INTEGER NOT NULL, visitor TEXT,
      ip_hash TEXT, neurons INTEGER NOT NULL DEFAULT 0, product TEXT)`);
    s.sql.exec(`CREATE INDEX spend_entries_day ON spend_entries(day)`);
    s.sql.exec(`INSERT INTO spend_entries (at, day, kind, reservation_id, usd_micros, model, live) VALUES ('2026-10-26T11:00:00.000Z', '2026-10-26', 'reserve', 'rsv_old', 7, 'm', 1)`);
    migrateSpend(s);
    const once = indexes();
    expect(once.map((i) => i.name)).toEqual(expect.arrayContaining(["spend_entries_day", "spend_entries_live", "spend_entries_reserve_at", "spend_entries_rsv", "spend_entries_run", "neuron_entries_day"]));
    migrateSpend(s);
    migrateSpend(s);
    expect(indexes()).toEqual(once);
    const l = createSqlSpendLedger(s, { caps: () => HOSTED_CAP_DEFAULTS, wallNow: () => new Date("2026-10-26T12:00:00.000Z") });
    expect(l.committed({ day: "2026-10-26" })).toEqual({ settledMicros: 0, openMicros: 7, neurons: 0 });
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
      // What a sweep reads is bounded by its batch, not by the backlog (no statement scans a table).
      expect(meter.rows - read).toBeLessThanOrEqual(2 * PRUNE_BATCH + 2);
      const s2 = count("spend_entries"), n2 = count("neuron_entries");
      expect(spend - s2).toBeLessThanOrEqual(2 * PRUNE_BATCH);
      expect(neurons - n2).toBeLessThanOrEqual(PRUNE_BATCH);
      spend = s2; neurons = n2;
      expect(sweeps).toBeLessThan(10);
    }
    expect(sweeps).toBe(3);
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

/**
 * Rows read, as workerd bills them, cannot be asked of node:sqlite, so each statement here is charged by its query
 * plan: a scan of a table (through an index or not) costs the table's rows, an index search costs the rows it returns
 * (index rows and the correlated subqueries' lookups are left out, as they are bounded by what the search returns).
 * Statements that write read nothing here. Enough to tell a read that grows with the table from one that does not.
 */
function readMeter(s: ReturnType<typeof memorySql>) {
  const meter = { rows: 0, statements: 0 };
  const exec = s.sql.exec.bind(s.sql);
  s.sql.exec = ((query: string, ...b: unknown[]) => {
    const cur = exec(query, ...b);
    if (/^\s*(select|with)/i.test(query)) {
      meter.statements += 1;
      const plan = s.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...(b as never[])) as { detail: string }[];
      let scanned = 0;
      for (const p of plan) {
        const m = /^SCAN (\w+)\b/.exec(p.detail);
        if (m) scanned += Number((s.db.prepare(`SELECT COUNT(*) AS n FROM ${m[1]}`).get() as { n: number }).n);
      }
      meter.rows += scanned || cur.toArray().length;
    }
    return cur;
  }) as typeof s.sql.exec;
  return meter;
}

describe("SpendDO ledger reads", () => {
  /** A ledger with `history` rows on earlier days (half of them live) and `today` reservations today. */
  function seeded(o: { history: number; today: number; liveUsd?: number | null }) {
    const caps: HostedCaps = { ...HOSTED_CAP_DEFAULTS, dayUsd: 1_000, runUsd: 1_000, visitorDayUsd: 1_000, ipDayUsd: 1_000, liveUsd: o.liveUsd ?? null };
    const s = memorySql();
    migrateSpend(s);
    let now = new Date("2026-10-26T12:00:00.000Z");
    const insert = s.db.prepare(`INSERT INTO spend_entries (at, day, world, run_id, kind, reservation_id, usd_micros, model, live, visitor, ip_hash, neurons, product)
      VALUES (?, ?, 'slot-1:gen-1', ?, ?, ?, 1000, 'gpt-5.6-luna', ?, 'vis_a', 'ip_a', 0, NULL)`);
    for (let i = 0; i < o.history; i += 2) {
      const at = new Date(now.getTime() - 86_400_000 - i * 1000).toISOString();
      insert.run(at, at.slice(0, 10), `run_h${i}`, "reserve", `rsv_h${i}`, i % 4 === 0 ? 1 : 0);
      insert.run(at, at.slice(0, 10), `run_h${i}`, "settle", `rsv_h${i}`, i % 4 === 0 ? 1 : 0);
    }
    const l = createSqlSpendLedger(s, { caps: () => caps, wallNow: () => now });
    for (let i = 0; i < o.today; i++) {
      const r = l.reserve({ runId: `run_t${i}`, usdMicros: 1000, model: "gpt-5.6-luna", live: true, world: "slot-1:gen-1", visitor: "vis_a", ipHash: "ip_a" });
      if (r.ok) l.settle(r.reservationId, 900);
    }
    now = new Date(now.getTime() + 1000);
    // The object has been up: whatever it rebuilds once is behind it.
    l.status({});
    const meter = readMeter(s);
    return { l, meter, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
  }

  const perCall = (o: { history: number; today: number; liveUsd?: number | null }) => {
    const { l, meter, advance } = seeded(o);
    l.status({ visitor: "vis_a", ipHash: "ip_a" });
    const status = meter.rows;
    const r = l.reserve({ runId: "run_new", usdMicros: 1000, model: "gpt-5.6-luna", live: true, world: "slot-1:gen-1", visitor: "vis_a", ipHash: "ip_a" });
    expect(r.ok).toBe(true);
    const reserve = meter.rows - status;
    if (r.ok) l.settle(r.reservationId, 500);
    const settle = meter.rows - status - reserve;
    // The cron's orphan sweep, 15 minutes on: the first one after a start looks back two days, the next ones only at
    // what crossed the orphan age since.
    advance(ORPHAN_SETTLE_MS + 1000);
    l.settleOrphans();
    advance(ORPHAN_SETTLE_MS);
    const before = meter.rows;
    l.settleOrphans();
    return { status, reserve, settle, sweep: meter.rows - before };
  };

  it("do not grow with the table or with today's steps, with the live cap off (section 0)", () => {
    const small = perCall({ history: 10, today: 5 });
    const large = perCall({ history: 4_000, today: 1_000 });
    expect(large).toEqual(small);
    expect(small.status).toBe(0);
    // The run cap reads the run's own rows; the reservation and its close are found by id.
    expect(small.reserve).toBeLessThanOrEqual(2);
    expect(small.settle).toBeLessThanOrEqual(4);
    expect(small.sweep).toBeLessThanOrEqual(2);
  });

  it("do not grow with the table with the live cap on either", () => {
    const small = perCall({ history: 10, today: 5, liveUsd: 1_000 });
    const large = perCall({ history: 4_000, today: 1_000, liveUsd: 1_000 });
    expect(large).toEqual(small);
    expect(small.status).toBe(0);
  });

  it("answer GET /v1/agent/costs?day=<yesterday> from memory: after the day's one build, spent({ day }) reads no row", () => {
    // 2,000 entries on yesterday (2026-10-25), the costs route's two calls per request, many requests.
    const { l, meter } = seeded({ history: 2_000, today: 5 });
    const yesterday = "2026-10-25";
    const total = l.spent({ day: yesterday });
    expect(total).toBe(2_000 / 2 * 1000);
    const warm = meter.rows;
    for (let i = 0; i < 100; i++) {
      expect(l.spent({ day: yesterday })).toBe(total);
      l.spent({ live: true });
    }
    expect(meter.rows - warm).toBe(0);
    // A day outside the retained three (older, or not yet begun) answers nothing and reads nothing, every time.
    for (const day of ["2026-10-23", "2026-10-01", "2026-10-27", "2099-01-01"]) expect(l.committed({ day })).toEqual({ settledMicros: 0, openMicros: 0, neurons: 0 });
    expect(meter.rows - warm).toBe(0);
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
    };
    l.spent({ day: "2026-10-25" });
    // Closed after midnight: the settle and release rows land on the reservations' day, and memory follows them.
    if (a.ok) l.settle(a.reservationId, 5_000);
    if (b.ok) l.release(b.reservationId);
    const rows = meter.rows;
    expect(l.committed({ day: "2026-10-25" })).toEqual({ settledMicros: 5_000, openMicros: 10_000, neurons: 0 });
    expect(meter.rows - rows).toBe(0);
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
