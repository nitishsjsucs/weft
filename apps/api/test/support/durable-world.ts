// Durable test worlds (track cf2-platform): a seeded world built on Node the way the hosted snapshot is (blobs and
// memory in SQL and WEFT_PREBUILT_HASH=1, booted and ticked once so the prebuilt routine rows and their hash match the code),
// then opened as a Durable Object slot through the durable platform over the node:sqlite storage stand-in
// (./durable-emu.ts), with fake SpendDO, RunHost and SchedulerHost bindings. Everything that touches the disk happens
// in buildSeededWorld() and openDurableWorld()'s setup, before a test turns its fs guard on.
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { seedWorld } from "@weft/seed";
import { seedWorldProfile } from "@weft/seed/profile";
import { createWeft } from "../../src/compose";
import { assembleWeft } from "../../src/assemble";
import type { ModelProvider } from "@weft/contracts";
import type { Weft } from "../../src/http/context";
import { durablePlatform, type HostedPlatformInput, type WeftDurablePlatform } from "../../src/platform/durable";
import { bundleFixtures, mapFixtures } from "../../src/platform/fixtures";
import type { HostedReserveInput, HostedSpendLedger, RunHost, RunHostJob } from "../../../../packages/contracts/src/ext/cf-agent";
import type { HostedWorldRef, WorldMode } from "../../../../packages/contracts/src/ext/cf-hosted";
import type { FixtureSource, SchedulerHost } from "../../../../packages/contracts/src/ext/cf-platform";
import { createEmuStorage, testDurableDriver, type EmuStorage, type TestMeter } from "./durable-emu";

export interface SeededWorld { dir: string; vaultKey: string; profile: "base" | "rich"; dispose(): void }

/** What the hosted snapshot build sets on Node: blobs in SQL and the prebuilt hash gate (so the snapshot carries the hash). */
export const SNAPSHOT_BUILD_ENV = { WEFT_BLOBS: "sqlite", WEFT_MEMORY: "sqlite", WEFT_PREBUILT_HASH: "1" } as const;

/**
 * Seeds a world on Node as the snapshot builder does (blobs in SQL, the prebuilt hash gate, frozen clock) and boots it
 * once: ensurePrebuilt plus one scheduler tick, which consumes the seed's pending event and sets the handlers cursor
 * (2 rows a restored slot would otherwise write on its first tick). Then it closes the world.
 */
export async function buildSeededWorld(profile: "base" | "rich" = "base"): Promise<SeededWorld> {
  const dir = mkdtempSync(join(tmpdir(), "weft-durable-seed-"));
  const prev = Object.fromEntries(Object.keys(SNAPSHOT_BUILD_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, SNAPSHOT_BUILD_ENV);
  try {
    const w = await createWeft({ dataDir: dir, testMode: true });
    if (profile === "rich") await seedWorldProfile(w, "rich"); else await seedWorld(w);
    await w.clock.set("2026-10-26T15:30:00.000Z", 0);
    await (w.routines as unknown as { ensurePrebuilt(): Promise<void> }).ensurePrebuilt();
    await w.scheduler.tick();
    await w.close();
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const vaultKey = readFileSync(join(dir, "run", "vault.key"), "utf8").trim();
  return { dir, vaultKey, profile, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface FakeSpend extends HostedSpendLedger { reserves: HostedReserveInput[]; calls: string[]; settles: { id: string; usd: number; actual?: { neurons?: number } }[] }
export function fakeSpend(): FakeSpend {
  const reserves: HostedReserveInput[] = [];
  const calls: string[] = [];
  const settles: { id: string; usd: number; actual?: { neurons?: number } }[] = [];
  const settled = new Map<string, number>();
  let n = 0;
  return {
    reserves, calls, settles,
    async reserve(input) { calls.push("reserve"); reserves.push(input); const id = `rsv_${++n}`; settled.set(id, input.usdMicros); return { ok: true, reservationId: id }; },
    async settle(id, usd, actual?: { neurons?: number }) { calls.push("settle"); settles.push({ id, usd, ...(actual ? { actual } : {}) }); settled.set(id, usd); },
    async release(id) { calls.push("release"); settled.delete(id); },
    async spent() { calls.push("spent"); return [...settled.values()].reduce((a, b) => a + b, 0); },
    async status() {
      calls.push("status");
      return { day: "2026-10-26", caps: { runUsd: 0.1, dayUsd: 2, liveUsd: null, visitorDayUsd: 2, ipDayUsd: 2, neuronsDay: 5000 }, spentMicros: { day: 0, visitor: 0, ip: 0, live: 0 }, neurons: { used: 0, byProduct: { agent: 0, ocr: 0, embeddings: 0, dictation: 0, speech: 0 } }, openReservations: 0 };
    },
    async settleOrphans() { calls.push("settleOrphans"); return 0; },
  };
}

/** Starts each job at once (what Node does); the alarm FIFO host is cf3-agent and cf4-worker's. */
export function immediateRunHost(): RunHost & { submitted: string[] } {
  const submitted: string[] = [];
  return {
    kind: "immediate", submitted,
    submit(job: RunHostJob) { submitted.push(job.runId); void job.start(); },
    pending: () => [],
    drain: async () => ({ started: 0, remaining: 0 }),
  };
}

export function recordingSchedulerHost(): SchedulerHost & { starts: number; stops: number; rate: (() => number) | null; tick: (() => Promise<void>) | null } {
  const h = {
    starts: 0, stops: 0, rate: null as (() => number) | null, tick: null as (() => Promise<void>) | null,
    start(input: { tick: () => Promise<void>; intervalMs: number; clockRate: () => number }) { h.starts++; h.rate = input.clockRate; h.tick = input.tick; },
    async stop() { h.stops++; },
  };
  return h;
}

let fixturesCache: FixtureSource | null = null;
/** The bundled fixtures (migrations, notice scenarios, mailed samples), read from the repo once per test file. */
export function testFixtures(): FixtureSource {
  return (fixturesCache ??= mapFixtures(bundleFixtures()));
}

export interface DurableTestWorld {
  weft: Weft;
  storage: EmuStorage;
  meter: TestMeter;
  platform: WeftDurablePlatform;
  spend: FakeSpend;
  runHost: ReturnType<typeof immediateRunHost>;
  schedulerHost: ReturnType<typeof recordingSchedulerHost>;
  /** Times the outbox flush ran (CompanyDO sends and deletes the rows; the test reads them). */
  outboxFlushes: { n: number };
  resets: { profile: string }[];
  env: Record<string, string>;
  dataDir: string;
  headers(principal: string): Record<string, string>;
  /** Closes the Weft and opens a second one on the same storage (a cold start of the same Durable Object). */
  reboot(): Promise<DurableTestWorld>;
  close(): Promise<void>;
}

export interface OpenDurableOptions {
  world?: Partial<HostedWorldRef> & { mode?: WorldMode };
  env?: Record<string, string>;
  /** Copy the seeded data dir first, so this world shares nothing on disk with another (the git memory repo). */
  copy?: boolean;
  extra?: Partial<HostedPlatformInput>;
  /** The model provider (the scripted one by default, as in every test). */
  provider?: ModelProvider;
}

/** Opens a seeded world as a durable slot. */
export async function openDurableWorld(seed: SeededWorld, opts: OpenDurableOptions = {}): Promise<DurableTestWorld> {
  let dataDir = seed.dir;
  let ownDir = false;
  if (opts.copy) {
    dataDir = mkdtempSync(join(tmpdir(), "weft-durable-slot-"));
    cpSync(seed.dir, dataDir, { recursive: true });
    ownDir = true;
  }
  const storage = createEmuStorage(join(dataDir, "weft.db"));
  const env: Record<string, string> = {
    WEFT_VAULT_KEY: seed.vaultKey, WEFT_PROXY_SECRET: randomBytes(32).toString("hex"), WEFT_DEV_AUTH: "1", WEFT_CLOCK_RATE: "0", ...opts.env,
  };
  const world: HostedWorldRef = { slot: opts.world?.slot ?? "slot-1", gen: opts.world?.gen ?? 1, mode: opts.world?.mode ?? "slot" };
  const fixtures = testFixtures();
  const build = async (): Promise<DurableTestWorld> => {
    const spend = fakeSpend();
    const runHost = immediateRunHost();
    const schedulerHost = recordingSchedulerHost();
    const outboxFlushes = { n: 0 };
    const resets: { profile: string }[] = [];
    const driver = testDurableDriver();
    const platform = durablePlatform({
      storage, env, world, fixtures, spend, runHost, schedulerHost,
      onOutbox: () => { outboxFlushes.n++; },
      reset: async ({ profile }) => { resets.push({ profile }); return { gen: world.gen + 1 }; },
      ...opts.extra,
    }, { driver });
    const weft = await assembleWeft(platform, { dataDir, testMode: true, ...(opts.provider ? { provider: opts.provider } : {}) });
    const meter = driver.handles[0]!.meter as TestMeter;
    const t: DurableTestWorld = {
      weft, storage, meter, platform, spend, runHost, schedulerHost, outboxFlushes, resets, env, dataDir,
      headers: (p) => ({ "x-weft-principal": p, "x-weft-proxy": weft.proxySecret }),
      async reboot() { await weft.close(); return build(); },
      async close() { await weft.close(); storage.close(); if (ownDir) rmSync(dataDir, { recursive: true, force: true }); },
    };
    return t;
  };
  return build();
}
