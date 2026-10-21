// SpendDO's ledger on node:sqlite: the file ledger's fold, the frozen run, day and live caps, and the hosted
// visitor, IP-hash and neuron caps, orphans settled at their worst case (design 4.3, 5.2, 6.3, section 0).
import { describe, expect, it } from "vitest";
import { HOSTED_CAP_DEFAULTS, ORPHAN_SETTLE_MS, type HostedCaps } from "../../src/shared/contracts";
import { createSqlSpendLedger, fold, migrateSpend, type SpendRow } from "../../src/core/spend/ledger";
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
