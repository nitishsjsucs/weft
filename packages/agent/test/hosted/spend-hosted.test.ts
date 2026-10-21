// Hosted caps from KV `weft-config` and the world's ledger adapter (spend-hosted.ts; docs/cloudflare/design.md section
// 0, 5.2, 5.3 and 6.3): caps change without a redeploy, visitor and IP-hash caps follow the day cap, the live cap is
// off by default, and every reservation a world makes (a background routine run included) is charged to its lease's
// visitor and IP hash, with Workers AI reservations also counting their neurons.
import { afterEach, describe, expect, it } from "vitest";
import { HOSTED_CAP_DEFAULTS, USD_PER_1K_NEURONS, WORKERS_AI_MODEL } from "../../../contracts/src/ext/cf-agent";
import { HOSTED_CONFIG_KEYS } from "../../../contracts/src/ext/cf-hosted";
import {
  bindSpendLedger, createHostedSpendLedger, createSqlSpendStore, hostedCapsFromConfig, isWorkersAiModel, kvCapsSource, neuronsForUsdMicros,
  stepCostUsd, stepNeurons, usdToMicros, WORKERS_AI_GPT_OSS,
} from "../../src/index";
import { sqliteStorage, type TestStorage } from "./sqlite-storage";

const storages: TestStorage[] = [];
afterEach(() => { for (const s of storages.splice(0)) s.close(); });
const hostedLedger = (caps = HOSTED_CAP_DEFAULTS) => {
  const st = sqliteStorage();
  storages.push(st);
  return createHostedSpendLedger({ store: createSqlSpendStore(st), caps: () => caps, wallNow: () => new Date("2026-10-26T15:00:00Z") });
};

describe("caps from KV weft-config", () => {
  it("acceptance: the defaults are Nitish's 2026-10-20 settings: run $0.10, day $2.00, no live cap, visitor and IP equal the day cap", () => {
    expect(hostedCapsFromConfig(() => null)).toEqual({ runUsd: 0.1, dayUsd: 2, liveUsd: null, visitorDayUsd: 2, ipDayUsd: 2, neuronsDay: 5000 });
  });

  it("every key overrides its cap; visitor and IP follow a changed day cap unless set on their own; live is off or an amount", () => {
    const kv = (v: Record<string, string>) => (k: string) => v[k] ?? null;
    expect(hostedCapsFromConfig(kv({ [HOSTED_CONFIG_KEYS.capDayUsd]: "3.00" }))).toEqual({ ...HOSTED_CAP_DEFAULTS, dayUsd: 3, visitorDayUsd: 3, ipDayUsd: 3 });
    expect(hostedCapsFromConfig(kv({
      [HOSTED_CONFIG_KEYS.capRunUsd]: "0.25", [HOSTED_CONFIG_KEYS.capDayUsd]: "1.50", [HOSTED_CONFIG_KEYS.capLiveUsd]: "20",
      [HOSTED_CONFIG_KEYS.capVisitorDayUsd]: "0.25", [HOSTED_CONFIG_KEYS.capIpDayUsd]: "0.50", [HOSTED_CONFIG_KEYS.capNeuronsDay]: "4000",
    }))).toEqual({ runUsd: 0.25, dayUsd: 1.5, liveUsd: 20, visitorDayUsd: 0.25, ipDayUsd: 0.5, neuronsDay: 4000 });
    expect(hostedCapsFromConfig(kv({ [HOSTED_CONFIG_KEYS.capLiveUsd]: "OFF" })).liveUsd).toBeNull();
    // Unreadable values keep the default: an operator typo never lifts a cap.
    expect(hostedCapsFromConfig(kv({ [HOSTED_CONFIG_KEYS.capRunUsd]: "-1", [HOSTED_CONFIG_KEYS.capDayUsd]: "lots", [HOSTED_CONFIG_KEYS.capLiveUsd]: "1e9" }))).toEqual(HOSTED_CAP_DEFAULTS);
  });

  it("is read from KV at most once per 60 s per isolate, and a KV error keeps the caps last read", async () => {
    let t = 0;
    let reads = 0;
    let fail = false;
    const values: Record<string, string> = { [HOSTED_CONFIG_KEYS.capDayUsd]: "1.00" };
    const kv = { get: async (k: string) => { reads++; if (fail) throw new Error("kv down"); return values[k] ?? null; } };
    const caps = kvCapsSource(kv, { now: () => t });
    expect((await caps()).dayUsd).toBe(1);
    expect(reads).toBe(6);
    values[HOSTED_CONFIG_KEYS.capDayUsd] = "0.50";
    t = 59_999;
    expect((await caps()).dayUsd).toBe(1);
    expect(reads).toBe(6);
    t = 60_000;
    expect((await caps()).dayUsd).toBe(0.5);
    fail = true;
    t = 200_000;
    expect((await caps()).dayUsd).toBe(0.5);
    const cold = kvCapsSource({ get: async () => { throw new Error("kv down"); } });
    expect(await cold()).toEqual(HOSTED_CAP_DEFAULTS);
  });

  it("a cap changed in KV applies to the next reservation without a redeploy", async () => {
    const values: Record<string, string> = {};
    let t = 0;
    const st = sqliteStorage();
    storages.push(st);
    const ledger = createHostedSpendLedger({ store: createSqlSpendStore(st), caps: kvCapsSource({ get: async (k) => values[k] ?? null }, { now: () => t }), wallNow: () => new Date("2026-10-26T15:00:00Z") });
    expect((await ledger.reserve({ runId: null, usdMicros: 600_000, model: "m", live: true })).ok).toBe(true);
    values[HOSTED_CONFIG_KEYS.capDayUsd] = "0.50";
    t = 61_000;
    expect(await ledger.reserve({ runId: null, usdMicros: 1, model: "m", live: true })).toMatchObject({ ok: false, hostedCap: "day", capMicros: 500_000 });
  });
});

describe("the world's ledger adapter (bindSpendLedger)", () => {
  it("acceptance: background runs are charged to the lease's visitor and IP hash, in the world's generation", async () => {
    const hosted = hostedLedger({ ...HOSTED_CAP_DEFAULTS, visitorDayUsd: 0.05 });
    const lease = { world: "slot-1:gen-4", visitor: "vis_a" as string | null, ipHash: "ip_a" as string | null };
    const bound = bindSpendLedger(hosted, { world: () => lease.world, visitor: () => lease.visitor, ipHash: () => lease.ipHash });
    // A routine run the agent loop reserves for: the frozen reserve input, no visitor in it.
    const a = await bound.reserve({ runId: "run_0007", usdMicros: 30_000, model: "gpt-5.6-luna", live: true });
    if (!a.ok) throw new Error("expected ok");
    await bound.settle(a.reservationId, 30_000);
    expect(await hosted.spent({ day: "2026-10-26", visitor: "vis_a" })).toBe(30_000);
    expect(await hosted.spent({ day: "2026-10-26", ipHash: "ip_a" })).toBe(30_000);
    expect(await bound.spent({ runId: "run_0007" })).toBe(30_000);
    // The same visitor's next run would pass $0.05: refused with the frozen cap the loop reports, and the precise one.
    expect(await bound.reserve({ runId: "run_0008", usdMicros: 30_000, model: "gpt-5.6-luna", live: true })).toMatchObject({ ok: false, cap: "day", hostedCap: "visitor" });
    // A reset (gen 5) with a new lease: run_0007 is another run, charged to the new visitor.
    Object.assign(lease, { world: "slot-1:gen-5", visitor: "vis_b", ipHash: "ip_b" });
    expect(await bound.spent({ runId: "run_0007" })).toBe(0);
    expect((await bound.reserve({ runId: "run_0007", usdMicros: 30_000, model: "gpt-5.6-luna", live: true })).ok).toBe(true);
    expect(await bound.status()).toMatchObject({ spentMicros: { visitor: 30_000, ip: 30_000, day: 60_000 } });
  });

  it("a Workers AI reservation reserves and settles its neurons (USD equivalents at $0.011 per 1,000 neurons)", async () => {
    const hosted = hostedLedger();
    const bound = bindSpendLedger(hosted, { world: () => "slot-2:gen-1", visitor: () => "vis_c", ipHash: () => "ip_c" });
    const usage = { input: 12_000, cached: 0, cacheWrite: 0, output: 300, reasoning: 0 };
    const reserveMicros = usdToMicros(stepCostUsd({ ...usage, output: 8000 }, WORKERS_AI_GPT_OSS));
    const r = await bound.reserve({ runId: "run_0001", usdMicros: reserveMicros, model: WORKERS_AI_MODEL, live: true });
    if (!r.ok) throw new Error("expected ok");
    const open = await bound.status();
    expect(open.neurons.used).toBe(neuronsForUsdMicros(reserveMicros, USD_PER_1K_NEURONS));
    const actual = usdToMicros(stepCostUsd(usage, WORKERS_AI_GPT_OSS));
    await bound.settle(r.reservationId, actual);
    const after = await bound.status();
    // The neurons the step used, as the account's allocation counts them (to the neuron).
    expect(after.neurons.used).toBe(neuronsForUsdMicros(actual, USD_PER_1K_NEURONS));
    expect(Math.abs(after.neurons.used - stepNeurons(usage))).toBeLessThanOrEqual(1);
    expect(after.neurons.byProduct.agent).toBe(after.neurons.used);
    expect(after.spentMicros.day).toBe(actual);
    // A Luna reservation carries no neurons.
    const l = await bound.reserve({ runId: "run_0002", usdMicros: 1000, model: "gpt-5.6-luna", live: true });
    if (!l.ok) throw new Error("expected ok");
    await bound.settle(l.reservationId, 900);
    expect((await bound.status()).neurons.used).toBe(after.neurons.used);
    expect(isWorkersAiModel(WORKERS_AI_MODEL)).toBe(true);
    expect(isWorkersAiModel("gpt-5.6-luna")).toBe(false);
  });

  it("the neuron cap refuses a Workers AI step the agent's share cannot cover", async () => {
    const hosted = hostedLedger({ ...HOSTED_CAP_DEFAULTS, neuronsDay: 500 });
    const bound = bindSpendLedger(hosted, { world: () => "slot-1:gen-1", visitor: () => null, ipHash: () => null });
    const micros = 500 * 11 + 11;   // 501 neurons
    expect(await bound.reserve({ runId: "run_0001", usdMicros: micros, model: WORKERS_AI_MODEL, live: true })).toMatchObject({ ok: false, cap: "day", hostedCap: "neurons", spentMicros: 0, capMicros: 500 });
  });

  it("release frees a Workers AI reservation's neurons", async () => {
    const hosted = hostedLedger();
    const bound = bindSpendLedger(hosted, { world: () => "slot-1:gen-1", visitor: () => null, ipHash: () => null });
    const r = await bound.reserve({ runId: "run_0001", usdMicros: 11_000, model: WORKERS_AI_MODEL, live: true });
    if (!r.ok) throw new Error("expected ok");
    expect((await bound.status()).neurons.used).toBe(1000);
    await bound.release(r.reservationId);
    expect((await bound.status()).neurons.used).toBe(0);
  });
});
