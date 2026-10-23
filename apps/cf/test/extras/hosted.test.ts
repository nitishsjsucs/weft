// HostedExtras' logic and its wiring from weft-core's bindings (design 3.1, 6.3 and 10): Help search at 30 a day,
// dictation inside its neuron share, the Platform readout, the model comparison and run catalog writes, and export
// downloads that stay inside their world and generation. The bindings are fakes shaped like the real ones: the
// Lobby counters run over DO SQLite semantics, SpendDO's ledger over the neuron budget.
import { describe, expect, it } from "vitest";
import { createHelpSearch, createRunCatalog, DICTATION_MODEL, memoryDailyCounters, memoryNeuronBudget, refreshComparison, type LobbyReadout } from "@weft/cf-extras";
import type { HostedSpendStatus } from "../../../../packages/contracts/src/ext/cf-agent";
import { HOSTED_SETTINGS } from "../../../../packages/contracts/src/ext/cf-hosted";
import { createHostedExtras } from "../../src/extras/hosted";
import { flagsFor, hostedDepsFromEnv, jobDepsFromEnv, type ExtrasEnv } from "../../src/extras/env";
import { exportObjectKey } from "../../src/extras/queues";
import { captureMetrics, d1Shim, fakeAi, fakeAiSearch, fakeSlot, memoryKv, memoryR2 } from "./helpers";

const chunks = [{ id: "c1", score: 0.8, text: "The guided tour walks through the eight scenarios.", item: { key: "help/tour.md" } }];
const wav = (seconds: number) => {
  const data = Math.round(seconds * 32_000), b = new Uint8Array(44 + data), dv = new DataView(b.buffer);
  const put = (o: number, s: string) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  put(0, "RIFF"); dv.setUint32(4, 36 + data, true); put(8, "WAVE"); put(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 16_000, true); dv.setUint32(28, 32_000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); put(36, "data"); dv.setUint32(40, data, true);
  return b;
};
const status: HostedSpendStatus = { day: "2026-10-26", caps: { runUsd: 0.1, dayUsd: 2, liveUsd: null, visitorDayUsd: 2, ipDayUsd: 2, neuronsDay: 5000 }, spentMicros: { day: 12_000, visitor: null, ip: null, live: 0 }, neurons: { used: 40, byProduct: { agent: 0, ocr: 22, embeddings: 0, dictation: 18 } }, openReservations: 0 };
const readout: LobbyReadout = { day: "2026-10-26", level: 0, restoresLeft: 3, leases: { active: 1, pool: 2, waitlist: 0 }, lastSweepAt: "2026-10-26T15:15:00.000Z", shares: {} };

function deps(o: Partial<Parameters<typeof createHostedExtras>[0]> = {}) {
  const counters = memoryDailyCounters();
  const db = d1Shim();
  const metrics = captureMetrics();
  return {
    db, metrics, counters,
    api: createHostedExtras({
      help: createHelpSearch({ search: fakeAiSearch(chunks), counters, enabled: () => true }),
      ai: fakeAi({ [DICTATION_MODEL]: () => ({ text: "Show payroll cost by month", transcription_info: { duration: 2.5 } }) }),
      neurons: memoryNeuronBudget(), dictationEnabled: async () => true, catalog: createRunCatalog(db),
      platform: async () => ({ day: "2026-10-26", level: 0, dollars: { spentUsd: 0, dayCapUsd: 2, runCapUsd: 0.1 }, neurons: { used: 0, cap: 5000 }, restoresLeft: 3, leases: readout.leases, deadLetters: 0, lastSweepAt: null, shares: {} }),
      files: memoryR2(), metrics, gatewayFor: () => null, ...o,
    }),
  };
}

describe("HostedExtras", () => {
  it("answers Help 30 times a day, then refuses until the next UTC day", async () => {
    const { api } = deps();
    const results = [];
    for (let i = 0; i < HOSTED_SETTINGS.helpQueriesPerDay + 1; i++) results.push(await api.help(`tour ${i}`));
    expect(results.filter((r) => r.ok)).toHaveLength(30);
    expect(results.at(-1)).toMatchObject({ ok: false, code: "HELP_DAILY_CAP" });
    expect(results[0]).toMatchObject({ ok: true, hits: [{ title: "Guided tour", path: "help/tour.md" }], leftToday: 29 });
  });

  it("transcribes a clip into text for the composer, inside the dictation share", async () => {
    const { api, metrics } = deps();
    const r = await api.dictate({ audio: wav(2.5).buffer, contentType: "audio/wav", slot: "slot-1", gen: 3, visitor: "v_1", ipHash: "ip_1" });
    expect(r).toEqual({ ok: true, text: "Show payroll cost by month", seconds: 2.5, neurons: 2 });
    expect(metrics.points).toEqual([{ name: "job.done", value: 2.5, slot: "slot-1", tags: { kind: "dictation" } }]);
    const off = deps({ dictationEnabled: async () => false }).api;
    expect(await off.dictate({ audio: wav(1), contentType: "audio/wav", slot: null, gen: null, visitor: null, ipHash: null })).toMatchObject({ ok: false, code: "DICTATION_DISABLED" });
    expect(await deps({ ai: null }).api.dictate({ audio: wav(1), contentType: "audio/wav", slot: null, gen: null, visitor: null, ipHash: null })).toMatchObject({ ok: false, code: "DICTATION_DISABLED" });
  });

  it("refuses a compressed clip before any model call, since its length cannot be checked first", async () => {
    const ai = fakeAi({ [DICTATION_MODEL]: () => ({ text: "four minutes of speech", transcription_info: { duration: 240 } }) });
    const neurons = memoryNeuronBudget();
    const { api } = deps({ ai, neurons });
    const webm = new Uint8Array(1_000_000); webm.set([0x1a, 0x45, 0xdf, 0xa3]);
    expect(await api.dictate({ audio: webm, contentType: "audio/webm", slot: "slot-1", gen: 3, visitor: "v_1", ipHash: "ip_1" })).toMatchObject({ ok: false, code: "DICTATION_UNREADABLE" });
    expect(ai.calls).toHaveLength(0);
    expect(neurons.used("dictation") + neurons.open()).toBe(0);
  });

  it("records run outcomes and compares models from D1", async () => {
    const { api, db, metrics } = deps();
    await api.recordRun({ runId: "run_0001", slot: "slot-1", gen: 3, provider: "openai", model: "gpt-5.6-luna", trigger: "chat", steps: 3, grounded: true, costUsdMicros: 3100, neurons: 0, latencyMs: 4100, status: "done", terminalReason: "DONE", endedAt: new Date().toISOString() });
    expect(db.rows("run_catalog")).toHaveLength(1);
    // The comparison is the cron's (refreshComparison): until it runs there is none, then it is the stored row.
    expect(await api.models({ days: 7 })).toEqual([]);
    await refreshComparison(db as never);
    expect(await api.models({ days: 7 })).toMatchObject([{ provider: "openai", runs: 1, groundedRate: 1 }]);
    expect(metrics.points[0]).toMatchObject({ name: "run.ended", slot: "slot-1" });
    expect(await deps({ catalog: null }).api.models()).toEqual([]);
  });

  it("serves an export only to its own world and generation", async () => {
    const files = memoryR2();
    const { api } = deps({ files });
    const key = exportObjectKey({ slot: "slot-1", gen: 3, jobId: "obx_x1", what: "world" });
    await files.put(key, "{}", { httpMetadata: { contentType: "application/json" }, customMetadata: { slot: "slot-1", gen: "3", what: "world", requestedBy: "usr_dana" } });
    expect(await api.exportFile({ slot: "slot-1", gen: 3, jobId: "obx_x1", what: "world" })).toEqual({ bytes: new TextEncoder().encode("{}"), contentType: "application/json" });
    expect(await api.exportFile({ slot: "slot-1", gen: 4, jobId: "obx_x1", what: "world" })).toBeNull();
    expect(await api.exportFile({ slot: "slot-2", gen: 3, jobId: "obx_x1", what: "world" })).toBeNull();
  });
});

/** Durable Object namespaces shaped like workerd's, over plain objects. */
const ns = <T>(make: (name: string) => T) => ({ idFromName: (name: string) => ({ name }), get: (id: unknown) => make((id as { name: string }).name) });

describe("wiring from weft-core's bindings", () => {
  function env(o: Partial<ExtrasEnv> = {}): ExtrasEnv & { calls: string[] } {
    const calls: string[] = [];
    const counters = memoryDailyCounters();
    const e: ExtrasEnv & { calls: string[] } = {
      calls,
      AI: fakeAi({ [DICTATION_MODEL]: () => ({ text: "hello", transcription_info: { duration: 1 } }) }),
      HELP: fakeAiSearch(chunks),
      FILES: memoryR2(), OPS: d1Shim(), CONFIG: memoryKv(),
      COMPANY: ns((name) => { calls.push(`company:${name}`); return fakeSlot({ slot: name }); }),
      LOBBY: ns((name) => {
        calls.push(`lobby:${name}`);
        return { extrasCounterTake: counters.take, extrasCounterAdd: counters.add, extrasCounterPeek: counters.peek, extrasReadout: async () => readout, extrasRecordVectors: async () => { calls.push("vectors"); } };
      }),
      SPEND: ns((name) => {
        calls.push(`spend:${name}`);
        const b = memoryNeuronBudget();
        return { reserve: async (i: { neurons?: number; product?: "dictation" }) => b.reserve({ product: i.product ?? "agent", neurons: i.neurons ?? 0, model: "m" }).then((r) => (r.ok ? r : { ok: false as const, code: "BUDGET_EXCEEDED" as const, cap: "day" as const, hostedCap: "neurons" as const, spentMicros: r.used, capMicros: r.cap })), settle: async () => {}, status: async () => status } as never;
      }),
      ...o,
    };
    return e;
  }
  const ctx = { waitUntil: () => {} };

  it("HostedExtras reaches the Lobby and SpendDO by their fixed names, and Help is off without its binding", async () => {
    const e = env();
    const api = createHostedExtras(hostedDepsFromEnv(e, ctx));
    expect((await api.help("tour")).ok).toBe(true);
    expect(await api.platform()).toMatchObject({ level: 0, restoresLeft: 3, dollars: { spentUsd: 0.012 }, neurons: { used: 40, cap: 5000 }, shares: { "help.queries": { used: 1, share: 30 } } });
    expect((await api.dictate({ audio: wav(1), contentType: "audio/wav", slot: "slot-1", gen: 1, visitor: "v", ipHash: "i" })).ok).toBe(true);
    expect(e.calls).toContain("lobby:lobby");
    expect(e.calls).toContain("spend:spend");
    expect(await createHostedExtras(hostedDepsFromEnv(env({ HELP: undefined }), ctx)).help("tour")).toMatchObject({ ok: false, code: "HELP_DISABLED" });
  });

  it("reuses the Platform readout for 30 s per isolate: any number of anonymous reads make one Lobby RPC and no SpendDO or counter call", async () => {
    const asked: string[] = [];
    const lobbyStub = {
      extrasReadout: async () => { asked.push("readout"); return { ...readout, counters: { "help.queries": 2, "pdf.browser_ms": 0 }, spend: status }; },
      extrasCounterPeek: async () => { asked.push("peek"); return 0; },
    };
    const e = env({ LOBBY: ns(() => lobbyStub) as never, SPEND: ns(() => ({ status: async () => { asked.push("spend.status"); return status; } })) as never });
    const api = () => createHostedExtras(hostedDepsFromEnv(e, ctx));
    const first = await api().platform();
    expect(first).toMatchObject({ dollars: { spentUsd: 0.012 }, shares: { "help.queries": { used: 2 } } });
    for (let i = 0; i < 50; i++) expect(await api().platform()).toEqual(first);
    // One readout, and nothing else: the Lobby's readout carried the spend status and the counters.
    expect(asked).toEqual(["readout"]);
  });

  it("the KV kill flags switch extras off, read once per isolate memo window", async () => {
    const kv = memoryKv({ "extras.help": "off", "extras.dictation": "off" });
    const e = env({ CONFIG: kv });
    const api = createHostedExtras(hostedDepsFromEnv(e, ctx));
    expect(await api.help("tour")).toMatchObject({ ok: false, code: "HELP_DISABLED" });
    expect(await api.dictate({ audio: wav(1), contentType: "audio/wav", slot: null, gen: null, visitor: null, ipHash: null })).toMatchObject({ ok: false, code: "DICTATION_DISABLED" });
    const reads = kv.reads;
    await flagsFor(e)();
    expect(kv.reads).toBe(reads);
    expect(flagsFor(e)).toBe(flagsFor({ CONFIG: kv }));
  });

  it("the queue consumers get the slot by name, the browser only when bound, and nothing evaluates puppeteer up front", async () => {
    const e = env();
    const d = jobDepsFromEnv(e, ctx);
    expect(d.launch).toBeNull();
    expect(jobDepsFromEnv(env({ BROWSER: {} }), ctx).launch).toBeTypeOf("function");
    expect((await d.slots("slot-2").extrasWorld()).slot).toBe("slot-2");
    expect(e.calls).toContain("company:slot-2");
    await d.recordVectorIds!("slot-2", 1, ["m_1"]);
    expect(e.calls).toContain("vectors");
    expect(d.gatewayFor({ slot: "slot-2", gen: 1, run: null, kind: "ocr", visitor: null })).toBeNull();
    expect(jobDepsFromEnv(env({ WEFT_AIG_GATEWAY: "gw" }), ctx).gatewayFor({ slot: "slot-2", gen: 1, run: null, kind: "ocr", visitor: null })).toMatchObject({ id: "gw" });
  });
});
