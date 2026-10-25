// The shared ledger (spend-core.ts; docs/cloudflare/design.md 4.3 and 6.3; tracks.md cf3-agent): the same scripted
// sequence of reservations, settles, releases and sweeps runs on the Node file store (JSONL) and on the SQL store
// SpendDO runs, and every cap gives identical results on both: run, day, live, visitor, IP hash and neurons, plus
// orphan settle at the reserved worst case after 15 minutes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOSTED_CAP_DEFAULTS, ORPHAN_SETTLE_MS, type HostedCaps, type HostedReserveInput } from "../../../contracts/src/ext/cf-agent";
import { createFileSpendStore, createHostedSpendLedger, createSqlSpendStore, type SpendStore } from "../../src/index";
import { sqliteStorage, type TestStorage } from "./sqlite-storage";

const dirs: string[] = [];
const storages: TestStorage[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const s of storages.splice(0)) s.close();
});

type StoreKind = "file" | "sqlite";
/** A store and a way to open a second one on the same data (a restart of the process or of SpendDO). */
function storeOf(kind: StoreKind): { store: SpendStore; reopen(): SpendStore } {
  if (kind === "file") {
    const dir = join(mkdtempSync(join(tmpdir(), "weft-spend-shared-")), "spend");
    dirs.push(dir.slice(0, -"/spend".length));
    return { store: createFileSpendStore({ dir }), reopen: () => createFileSpendStore({ dir }) };
  }
  const st = sqliteStorage();
  storages.push(st);
  return { store: createSqlSpendStore(st), reopen: () => createSqlSpendStore(st) };
}

/** A ledger whose wall clock the sequence moves. */
function ledgerOn(store: SpendStore, caps: Partial<HostedCaps>, clock: { now: Date }) {
  return createHostedSpendLedger({ store, caps: () => ({ ...HOSTED_CAP_DEFAULTS, ...caps }), wallNow: () => clock.now });
}

const base: Omit<HostedReserveInput, "usdMicros"> = { runId: "run_0001", model: "gpt-5.6-luna", live: true, world: "slot-1:gen-1", visitor: "vis_a", ipHash: "ip_a" };

/**
 * One sequence touching every cap. It returns a transcript (every result, with reservation ids replaced by their
 * order), so the two stores can be compared value for value.
 */
async function transcript(kind: StoreKind): Promise<unknown[]> {
  const { store, reopen } = storeOf(kind);
  const clock = { now: new Date("2026-10-26T15:00:00.000Z") };
  const caps: Partial<HostedCaps> = { runUsd: 0.1, dayUsd: 0.5, liveUsd: 0.4, visitorDayUsd: 0.2, ipDayUsd: 0.3, neuronsDay: 1000 };
  let ledger = ledgerOn(store, caps, clock);
  const ids: string[] = [];
  const out: unknown[] = [];
  const name = (id: string) => { if (!ids.includes(id)) ids.push(id); return `r${ids.indexOf(id) + 1}`; };
  const reserve = async (label: string, input: Partial<HostedReserveInput> & { usdMicros: number }) => {
    const r = await ledger.reserve({ ...base, ...input });
    out.push([label, r.ok ? { ok: true, id: name(r.reservationId) } : r]);
    return r.ok ? r.reservationId : null;
  };
  const snap = async (label: string) => out.push([label, {
    run: await ledger.spent({ runId: "run_0001", world: "slot-1:gen-1" }),
    day: await ledger.spent({ day: "2026-10-26" }),
    live: await ledger.spent({ live: true }),
    visitorA: await ledger.spent({ day: "2026-10-26", visitor: "vis_a" }),
    status: await ledger.status({ visitor: "vis_a", ipHash: "ip_a" }),
  }]);

  // Run cap: $0.10 per run in its world; another world's run_0001 is another run.
  const a = await reserve("run a", { usdMicros: 80_000 });
  await reserve("run cap", { usdMicros: 30_000 });
  await reserve("other world", { usdMicros: 30_000, world: "slot-1:gen-2", visitor: "vis_b", ipHash: "ip_b" });
  await reserve("scaled run cap", { usdMicros: 30_000, runCapScale: 6 });
  await ledger.settle(a!, 50_000);
  await ledger.settle(a!, 1);   // a reservation closes once
  await snap("after settle");
  // Visitor cap ($0.20 a day for vis_a), IP cap ($0.30 for ip_a, shared with other visitors).
  await reserve("visitor ok", { runId: "run_0002", usdMicros: 60_000 });
  await reserve("visitor cap", { runId: "run_0003", usdMicros: 70_000 });
  await reserve("ip ok", { runId: "run_0004", usdMicros: 90_000, visitor: "vis_c" });
  await reserve("ip cap", { runId: "run_0005", usdMicros: 80_000, visitor: "vis_d" });
  // Day cap ($0.50, every world, every visitor; a reservation with no run has no run cap).
  await reserve("day cap", { runId: null, usdMicros: 250_000, visitor: "vis_e", ipHash: "ip_e" });
  // Live cap ($0.40 cumulative): spend that is not live never counts against it.
  await reserve("not live", { runId: "run_0008", usdMicros: 10_000, visitor: "vis_f", ipHash: "ip_f", live: false, model: "scripted" });
  await reserve("live cap", { runId: null, usdMicros: 150_000, visitor: "vis_f", ipHash: "ip_f" });
  await reserve("not live big", { runId: null, usdMicros: 150_000, visitor: "vis_f", ipHash: "ip_f", live: false, model: "scripted" });
  // Neurons: 1,000 a day here, and each product's share (OCR 500 of Weft's 5,000).
  const wai = { usdMicros: 0, live: false, visitor: null, ipHash: null } as const;
  const ocr = await reserve("neurons ocr", { ...wai, runId: null, neurons: 450, product: "ocr", model: "@cf/mistralai/mistral-small-3.1-24b-instruct" });
  await reserve("ocr share", { ...wai, runId: null, neurons: 100, product: "ocr", model: "@cf/mistralai/mistral-small-3.1-24b-instruct" });
  await ledger.settle(ocr!, 0, { neurons: 120 });
  await reserve("ocr share after settle", { ...wai, runId: null, neurons: 100, product: "ocr", model: "@cf/mistralai/mistral-small-3.1-24b-instruct" });
  await reserve("neurons agent", { ...wai, runId: "run_0009", neurons: 600, product: "agent", model: "@cf/openai/gpt-oss-120b" });
  await reserve("neuron cap", { ...wai, runId: "run_0010", neurons: 500, product: "agent", model: "@cf/openai/gpt-oss-120b" });
  await snap("before sweep");

  // A restart: a second store on the same data sees the same ledger.
  ledger = ledgerOn(reopen(), caps, clock);
  await snap("after reopen");

  // Orphans: open reservations settle at their reserved amount once 15 minutes old.
  clock.now = new Date(clock.now.getTime() + ORPHAN_SETTLE_MS - 1000);
  out.push(["sweep early", await ledger.settleOrphans()]);
  clock.now = new Date(clock.now.getTime() + 2000);
  out.push(["sweep", await ledger.settleOrphans()]);
  out.push(["sweep again", await ledger.settleOrphans()]);
  await snap("after sweep");

  // A reservation made before midnight settles into its own day after midnight.
  clock.now = new Date("2026-10-26T23:59:59.000Z");
  const late = await reserve("late", { runId: "run_0011", usdMicros: 1_000, visitor: "vis_g", ipHash: "ip_g", world: "slot-2:gen-1" });
  clock.now = new Date("2026-10-27T00:00:30.000Z");
  await ledger.settle(late!, 700);
  out.push(["days", await ledger.spent({ day: "2026-10-26" }), await ledger.spent({ day: "2026-10-27" })]);
  const rel = await reserve("release me", { runId: "run_0012", usdMicros: 5_000, visitor: "vis_g", ipHash: "ip_g", world: "slot-2:gen-1" });
  await ledger.release(rel!);
  out.push(["committed", await ledger.core.committed({ runId: "run_0012", world: "slot-2:gen-1" })]);
  out.push(["status next day", await ledger.status({ visitor: "vis_g", ipHash: "ip_g" })]);
  return out;
}

describe("the shared ledger on the file and SQL stores", () => {
  it("acceptance: identical results on both stores for every cap", async () => {
    const file = await transcript("file");
    const sql = await transcript("sqlite");
    expect(sql).toEqual(file);
    // And the results are the ones the caps call for (checked in order: run, day, live, visitor, IP hash, neurons).
    const byLabel = new Map(file.map((x) => [(x as unknown[])[0] as string, (x as unknown[])[1]]));
    const refused = (hostedCap: string, cap: string, spentMicros: number, capMicros: number) => ({ ok: false, code: "BUDGET_EXCEEDED", cap, hostedCap, spentMicros, capMicros });
    expect(byLabel.get("run a")).toEqual({ ok: true, id: "r1" });
    expect(byLabel.get("run cap")).toEqual(refused("run", "run", 80_000, 100_000));
    expect(byLabel.get("other world")).toEqual({ ok: true, id: "r2" });
    expect(byLabel.get("scaled run cap")).toEqual({ ok: true, id: "r3" });
    expect(byLabel.get("visitor ok")).toEqual({ ok: true, id: "r4" });
    // vis_a: r1 settled at 50k, r3 30k and r4 60k open: 140k, and 70k more passes the 200k visitor cap.
    expect(byLabel.get("visitor cap")).toEqual(refused("visitor", "day", 140_000, 200_000));
    expect(byLabel.get("ip ok")).toEqual({ ok: true, id: "r5" });
    // ip_a: 140k plus r5's 90k is 230k; 80k more passes the 300k IP cap although vis_d has spent nothing.
    expect(byLabel.get("ip cap")).toEqual(refused("ip", "day", 230_000, 300_000));
    expect(byLabel.get("day cap")).toEqual(refused("day", "day", 260_000, 500_000));
    expect(byLabel.get("not live")).toEqual({ ok: true, id: "r6" });
    expect(byLabel.get("live cap")).toEqual(refused("live", "live", 260_000, 400_000));
    expect(byLabel.get("not live big")).toEqual({ ok: true, id: "r7" });
    expect(byLabel.get("neurons ocr")).toEqual({ ok: true, id: "r8" });
    // The neuron caps count neurons: spentMicros and capMicros carry neurons.
    expect(byLabel.get("ocr share")).toEqual(refused("neurons", "day", 450, 500));
    expect(byLabel.get("ocr share after settle")).toEqual({ ok: true, id: "r9" });
    expect(byLabel.get("neurons agent")).toEqual({ ok: true, id: "r10" });
    expect(byLabel.get("neuron cap")).toEqual(refused("neurons", "day", 820, 1000));
    expect(byLabel.get("after reopen")).toEqual(byLabel.get("before sweep"));
    expect(byLabel.get("before sweep")).toMatchObject({
      run: 50_000, day: 50_000, live: 50_000, visitorA: 50_000,
      status: { spentMicros: { day: 420_000, visitor: 140_000, ip: 230_000, live: 260_000 }, neurons: { used: 820, byProduct: { agent: 600, ocr: 220, embeddings: 0, dictation: 0, speech: 0 } }, openReservations: 8 },
    });
    expect(byLabel.get("sweep early")).toBe(0);
    expect(byLabel.get("sweep")).toBe(8);
    expect(byLabel.get("sweep again")).toBe(0);
    // Swept reservations settled at their reserved worst case: nothing is open and nothing moved.
    expect(byLabel.get("after sweep")).toMatchObject({
      run: 80_000, day: 420_000, live: 260_000, visitorA: 140_000,
      status: { spentMicros: { day: 420_000, visitor: 140_000, ip: 230_000, live: 260_000 }, neurons: { used: 820 }, openReservations: 0 },
    });
    expect(file.find((x) => (x as unknown[])[0] === "days")).toEqual(["days", 420_700, 0]);
    expect(byLabel.get("committed")).toEqual({ settledMicros: 0, openMicros: 0, neurons: 0 });
    expect(byLabel.get("status next day")).toMatchObject({ day: "2026-10-27", spentMicros: { day: 0, visitor: 0, ip: 0, live: 260_700 }, openReservations: 0 });
  });

  it("the run cap is per run and world; the day, visitor and IP totals add up the same on both stores", async () => {
    for (const kind of ["file", "sqlite"] as const) {
      const { store } = storeOf(kind);
      const clock = { now: new Date("2026-10-26T15:00:00.000Z") };
      const ledger = ledgerOn(store, { runUsd: 0.1, dayUsd: 2 }, clock);
      const r = await ledger.reserve({ ...base, usdMicros: 40_000 });
      if (!r.ok) throw new Error("expected ok");
      await ledger.settle(r.reservationId, 30_000);
      const status = await ledger.status({ visitor: "vis_a", ipHash: "ip_a" });
      expect(status, kind).toMatchObject({ day: "2026-10-26", spentMicros: { day: 30_000, visitor: 30_000, ip: 30_000, live: 0 }, openReservations: 0 });
      expect(status.caps).toEqual({ ...HOSTED_CAP_DEFAULTS, runUsd: 0.1, dayUsd: 2 });
      expect(await ledger.spent({ runId: "run_0001", world: "slot-1:gen-2" }), kind).toBe(0);
      expect(await ledger.spent({ runId: "run_0001", world: "slot-1:gen-1" }), kind).toBe(30_000);
    }
  });

  it("the hosted default has no live cap: cumulative live spend is never a refusal", async () => {
    for (const kind of ["file", "sqlite"] as const) {
      const { store } = storeOf(kind);
      const clock = { now: new Date("2026-10-26T15:00:00.000Z") };
      const ledger = ledgerOn(store, {}, clock);
      expect(HOSTED_CAP_DEFAULTS.liveUsd).toBeNull();
      // $1.90 of earlier days' live spend is not today's.
      clock.now = new Date("2026-10-25T15:00:00.000Z");
      for (let i = 0; i < 19; i++) {
        const r = await ledger.reserve({ ...base, runId: `run_${i}`, usdMicros: 100_000 });
        expect(r.ok, `${kind} ${i}`).toBe(true);
      }
      clock.now = new Date("2026-10-26T15:00:00.000Z");
      expect((await ledger.reserve({ ...base, runId: "run_x", usdMicros: 100_000, visitor: "vis_z", ipHash: "ip_z" })).ok, kind).toBe(true);
    }
  });
});
