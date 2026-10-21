// The composition body (SPEC 2, 9.0), split out of compose.ts for Weft on Cloudflare (docs/cloudflare/design.md 3.3).
// The only place that wires db, simulators, executor, core commands and handlers, providers, the agent runtime,
// routines, the scheduler and the Hono app, over a WeftPlatform. compose.ts keeps createWeft(opts) as
// assembleWeft(nodePlatform, opts) with the same signature. Until every track lands, factories may still throw
// NotImplemented; unless `strict`, each such part becomes a stub that throws NotImplemented when used and is listed
// in `weft.stubs` (and in GET /v1/health).
//
// Every platform part a platform leaves out is today's Node code (apps/api/src/platform/node.ts); the durable platform
// (platform/durable.ts) supplies all of them, and nothing on its path calls node:fs. The durable platform fails
// closed: no WEFT_VAULT_KEY or WEFT_PROXY_SECRET means no world (design 4.1), before anything is opened.
import { join, resolve } from "node:path";
import { isWeftError, NotImplemented, type AgentRuntime, type ExecutorBundle, type ModelProvider, type RoutinesEngine, type SimClock, type Simulators, type SpendLedger } from "@weft/contracts";
import { eq } from "drizzle-orm";
import { closeDb, migrate, notices, openDb, type Db } from "@weft/db";
import { commands, complianceNoticeVariant, createSimClock, handlers } from "@weft/core";
import { createSimulators } from "@weft/sim";
import { createVendorOverlay } from "@weft/integrations";
import { createExecutor, executorInternals, fileRunFiles } from "@weft/executor";
import { createAgentRuntime, createProvider, createSpendLedger, loadSecret, setTraceRedactor, traceMcpCall } from "@weft/agent";
import { createRoutines, PREBUILT_HASH_KEY, type WeftRoutinesEngine } from "@weft/routines";
import { createChatContextSource } from "./routes/agent";
import { createRoutinesEventSource } from "./routes/routines";
import type { Weft, WeftPlatformInfo } from "./http/context";
import { hostedApp } from "./http/hosted";
import { buildApp } from "./app";
import { createScheduler } from "./scheduler";
import { worldId } from "./world-id";
import { fileRunHandleStore, learnVendorSecrets, nodeBlobStore, readOrCreateProxySecret } from "./platform/node";
import { fileSmallState, kvRow } from "./platform/state";
import { repoFixtures } from "./platform/fixtures";
import { useNoticeFixtures } from "../../../packages/sim/src/notices/fixtures";
import { HOSTED_CLOCK } from "../../../packages/contracts/src/ext/cf-hosted";
import { SMALL_STATE_KEYS, type PlatformContext, type PlatformDb, type WeftPlatform } from "../../../packages/contracts/src/ext/cf-platform";

export { nodePlatform } from "./platform/node";
// The hosted entry for apps/cf (CompanyDO): the durable platform and its parts, from @weft/api/assemble.
export { durablePlatform, defaultDurableDriver, hostedSpendLedger, type DurableDbDriver, type DurablePlatformDeps, type HostedPlatformInput, type WeftDurablePlatform } from "./platform/durable";
export { FIXTURE_PATHS, mapFixtures, repoFixtures, bundleFixtures } from "./platform/fixtures";
export { sqlSmallState } from "./platform/state";
export { sqlBlobStore, sqlRunFileStore, sqlRunHandleStore, BlobTooLarge, SQL_BLOB_PREFIX } from "./platform/sql";
export { hostedApp, markUncachable, POLLED_GET_ROUTES } from "./http/hosted";
export type { HostedResetHook, WeftPlatformInfo } from "./http/context";

export interface CreateWeftOptions {
  dataDir: string;
  /** Provide a clock, or let createWeft build the persisted SimClock (rate from WEFT_CLOCK_RATE, 0 in testMode). */
  clock?: SimClock;
  provider?: ModelProvider;
  testMode?: boolean;
  /** Throw on any NotImplemented factory instead of stubbing it. */
  strict?: boolean;
  /** Set by the seed CLI: skips agent.boot() and the proposal wiring side effects that need a seeded world. */
  seeding?: boolean;
  ports?: { api?: number; web?: number };
}

const isStubError = (e: unknown) => isWeftError(e) && e._tag === "NotImplemented";

/** A callable, infinitely nested proxy whose calls throw NotImplemented. Never thenable. */
export function stubOf<T>(name: string): T {
  const make = (path: string): unknown => new Proxy(function stub() {}, {
    get: (_t, prop) => (prop === "then" ? undefined : prop === Symbol.toPrimitive ? () => `[stub ${path}]` : make(`${path}.${String(prop)}`)),
    apply: () => { throw new NotImplemented(path); },
  });
  return make(name) as T;
}

/** A platform secret that is missing or malformed; assemble throws it before opening anything. */
export class PlatformSecretMissing extends Error {
  readonly code = "PLATFORM_SECRET_MISSING";
  constructor(readonly secret: string, why: string) { super(`${secret} ${why}; the hosted world fails closed without it`); this.name = "PlatformSecretMissing"; }
}

/**
 * The vault key from the environment (design 4.1). Required on the durable platform and wherever
 * WEFT_REQUIRE_VAULT_KEY=1 (the hosted snapshot build): a missing or malformed key throws. Otherwise absent means
 * Node's <dataDir>/run/vault.key, created on first use, as before.
 */
export function vaultKeyFromEnv(env: Readonly<Record<string, string | undefined>>, required: boolean): Buffer | undefined {
  const v = env.WEFT_VAULT_KEY;
  if (v && /^[0-9a-f]{64}$/i.test(v)) return Buffer.from(v, "hex");
  if (required) throw new PlatformSecretMissing("WEFT_VAULT_KEY", v ? "is not 64 hex characters" : "is not set");
  return undefined;
}

/** The x-weft-proxy secret on hosted: the WEFT_PROXY_SECRET Worker secret, shared with the front Worker. */
export function proxySecretFromEnv(env: Readonly<Record<string, string | undefined>>): string {
  const v = env.WEFT_PROXY_SECRET?.trim();
  if (!v || v.length < 32) throw new PlatformSecretMissing("WEFT_PROXY_SECRET", v ? "is shorter than 32 characters" : "is not set");
  return v;
}

const placeholderProvider: ModelProvider = {
  id: "scripted", model: "none", label: "Scripted, no model", live: false,
  step: async () => { throw new NotImplemented("provider.step (t4-agent)"); },
};

// Scripted provider only (SPEC 12 GP5): the scripted stand-in plays a model that reads the notice body when that body
// carries an injected line, so the browser GP5 exercises taint with the same delivery click as GP1. A live model
// decides for itself (eval L4) and never sees this hook.
const INJECTED_LINE = /ignore (all )?prior instructions/i;
function scriptVariant(db: Db, clock: { now(): string }) {
  // Wave 4 (w4-parity-compliance): rt_compliance_notices, rt_compliance_uploads and rt_compliance_training pick their
  // script from the same plan the precheck derives (packages/core/src/compliance/script-variant.ts), on the sim clock.
  const compliance = complianceNoticeVariant(db, () => clock.now());
  return async ({ routineId, trigger }: { routineId: string; trigger: Record<string, unknown> }): Promise<string | null> => {
    if (routineId.startsWith("rt_compliance_")) return compliance({ routineId, trigger });
    if (routineId !== "rt_agency_notice" || typeof trigger.notice_id !== "string") return null;
    const rows = await db.select({ body: notices.bodyText }).from(notices).where(eq(notices.id, trigger.notice_id)).limit(1);
    return rows[0] && INJECTED_LINE.test(rows[0].body) ? "rt_agency_notice.injection" : null;
  };
}

/** The lease's MCP and admin key plaintexts (kv_state lease.keys), which the redactor learns at boot on hosted. */
function leaseKeys(state: { get(key: string): string | null }): string[] {
  try {
    const v = JSON.parse(state.get(SMALL_STATE_KEYS.leaseKeys) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length >= 8) : [];
  } catch { return []; }
}

/** Composes a Weft over a platform (docs/cloudflare/design.md 3.3). */
export async function assembleWeft(platform: WeftPlatform<Db>, opts: CreateWeftOptions): Promise<Weft> {
  const durable = platform.kind === "durable";
  const env: Readonly<Record<string, string | undefined>> = platform.env ?? process.env;
  // Fail closed before anything is opened: the durable platform never generates, reads or writes a key file.
  const vaultKey = vaultKeyFromEnv(env, durable || env.WEFT_REQUIRE_VAULT_KEY === "1");
  const hostedProxySecret = durable ? proxySecretFromEnv(env) : null;
  const testMode = opts.testMode ?? false;
  const dataDir = resolve(opts.dataDir);
  const stubs: string[] = [];
  const tolerate = async <T>(name: string, build: () => T | Promise<T>, fallback: () => T): Promise<T> => {
    try { return await build(); } catch (e) {
      if (opts.strict || !isStubError(e)) throw e;
      stubs.push(name);
      return fallback();
    }
  };

  let pdb: PlatformDb<Db>;
  if (platform.openDb) {
    pdb = await platform.openDb(dataDir);
  } else {
    const db = openDb({ dataDir });
    await migrate(db);
    pdb = { db, meter: null, guard: null, close: () => closeDb(db) };
  }
  const db = pdb.db;
  const ctx: PlatformContext<Db> = { dataDir, db, env, testMode };
  const blobs = platform.blobs?.(ctx) ?? nodeBlobStore(ctx);
  const state = platform.state?.(ctx) ?? fileSmallState(dataDir);
  const fixtures = platform.fixtures ?? repoFixtures();
  const runHandles = platform.runHandles?.(ctx) ?? fileRunHandleStore(join(dataDir, "run", "handles"));
  const runFiles = platform.runFiles?.(ctx) ?? fileRunFiles(dataDir);
  // The notice scenarios and mailed samples come from the bundled fixtures on the durable platform.
  if (platform.fixtures) useNoticeFixtures(platform.fixtures);
  const world = platform.world ?? null;
  // Secrets come from the Worker env only on the durable platform: no WEFT_SECRETS_FILE is ever read there.
  const secretEnv: Record<string, string | undefined> = durable ? Object.fromEntries(Object.entries(env).filter(([k]) => k !== "WEFT_SECRETS_FILE")) : (env as Record<string, string | undefined>);

  const clock = opts.clock ?? (await createSimClock({ db, initial: testMode || durable ? { at: HOSTED_CLOCK.at, rate: HOSTED_CLOCK.rate } : undefined }));
  // Wave 3: real vendor adapters overlay the simulated ones only outside tests, with WEFT_INTEGRATIONS_REAL=1 and every
  // secret present. Hosted integrations are always simulated (design 3.3).
  const vendors = testMode || durable ? undefined : createVendorOverlay(secretEnv);
  const simulators = (o: { db: Parameters<typeof createSimulators>[0]["db"]; clock: Parameters<typeof createSimulators>[0]["clock"] }) => createSimulators({ ...o, vendors });
  const sims = await tolerate<Simulators>("sim", () => simulators({ db, clock }), () => stubOf("sims"));
  // Hosted executor options: the platform's, or on Node only what the environment switches on (all off by default).
  const hosted = platform.executor
    ? { ...platform.executor, outboxWorld: world ? { slot: world.slot, gen: world.gen } : null }
    : env.WEFT_EPHEMERAL_READ_IDS === "1" ? { ephemeralReadIds: true } : undefined;
  const executor = await tolerate<ExecutorBundle>("executor", () => createExecutor({
    db, clock, dataDir, commands, simulators, testMode, env, vaultKey, runFiles, blobs, hosted, txGuard: pdb.guard,
    ...(durable ? { bootSecrets: () => leaseKeys(state) } : {}),
    ...(platform.memoryRepo ? { memoryRepo: (companyId: string) => platform.memoryRepo!(ctx, companyId) } : {}),
  }), () => stubOf("executor"));
  // Harness 6.4: provider keys may come from WEFT_SECRETS_FILE and never reach process.env; teach the redactor them too.
  for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    const v = (() => { try { return loadSecret(k, secretEnv); } catch { return null; } })();
    if (v) executorInternals(executor)?.addSecret(v);
  }
  if (!durable) {
    // Wave 3: the vendor credentials too (and the DocuSign private key's contents), as a backstop if one ever reached
    // an action row, a refusal, the model or MCP output. Names only come from the contracts; values stay in memory.
    learnVendorSecrets(secretEnv, (v) => executorInternals(executor)?.addSecret(v));
    // The trace redactor and the MCP span are process globals of @weft/agent: only Node (one world per process)
    // installs them; hosted spans stay off (design 10), so no world's redactor ever serves another world.
    setTraceRedactor(<T>(v: T): T => executorInternals(executor)?.engine.redactor.value(v) ?? v);   // wave 4: spans redact at the source
    Object.assign(executorInternals(executor)?.engine ?? {}, { observeCall: traceMcpCall });   // wave 4: a root TOOL span per MCP call
  }
  // The per-run cap keys a run by (world, run id): run ids restart with every rebuilt world, the ledger never resets.
  const ledger = await tolerate<SpendLedger>("spend-ledger", () => platform.spendLedger
    ? platform.spendLedger(ctx)
    : createSpendLedger({ dir: join(dataDir, "spend"), world: () => worldId(dataDir) }), () => stubOf("ledger"));
  // The fixtures and the run host ride along for the agent package's hosted options (cf3-agent); Node passes neither.
  const providerOptions = {
    env: secretEnv, ledger, testMode, scriptVariant: scriptVariant(db, clock),
    // The local chat-completions providers send each tool's compact description (wave 2, w2-providers-sandbox request 1).
    compactDescriptions: (wire: string) => executorInternals(executor)?.engine.registry.def(wire)?.compactDescription || null,
    ...(durable ? { fixtures } : {}),
  };
  const provider = opts.provider ?? (await tolerate<ModelProvider>("provider", () => createProvider(providerOptions), () => placeholderProvider));
  const routinesRef: { current: RoutinesEngine | null } = { current: null };
  const agentOptions = {
    db, clock, executor: executor.agent, provider, ledger,
    // Routines are built after the agent, so the view resolves lazily through routinesRef.
    routinesView: {
      get: (id: string) => (routinesRef.current as WeftRoutinesEngine).view.get(id),
      checklist: (x: Parameters<WeftRoutinesEngine["view"]["checklist"]>[0]) => (routinesRef.current as WeftRoutinesEngine).view.checklist(x),
    },
    contextSource: createChatContextSource(db),
    handleStore: runHandles,
    ...(platform.runHost ? { runHost: platform.runHost } : {}),
    ...(durable ? { env: secretEnv, fixtures } : {}),
  };
  const agent = await tolerate<AgentRuntime>("agent", () => createAgentRuntime(agentOptions), () => stubOf("agent"));
  // Design 4.4: the prebuilt hash gate, so a second boot (a restored snapshot booted once) writes nothing on its first
  // tick. Always on the durable platform; on Node only for the hosted snapshot build (WEFT_PREBUILT_HASH=1, so the
  // snapshot carries the hash), and otherwise off: a Node world compares the rows on every boot and writes no kv_state
  // row, exactly as before.
  const prebuiltGate = durable || env.WEFT_PREBUILT_HASH === "1";
  const routines = await tolerate<RoutinesEngine>("routines", () => createRoutines({
    db, clock, agent, runs: executor.runs, readOnly: executor.readOnly, events: createRoutinesEventSource(db),
    ...(prebuiltGate ? { prebuiltHash: kvRow(db, PREBUILT_HASH_KEY) } : {}),
  }), () => stubOf("routines"));
  routinesRef.current = routines;
  const scheduler = createScheduler({ db, clock, sims, executor, handlers, routines, log: testMode ? () => undefined : undefined, ...(platform.schedulerHost ? { host: platform.schedulerHost } : {}) });

  // Wiring (SPEC 9.0): decisions wake routines; agent boot rule PROCESS_RESTART.
  await tolerate("wiring.onProposalDecided", () => executor.human.onProposalDecided((p) => routines.onProposalDecided(p)), () => undefined);
  if (!opts.seeding) await tolerate("wiring.agent.boot", () => agent.boot(), () => undefined);

  const proxySecret = hostedProxySecret ?? readOrCreateProxySecret(dataDir);
  const ports = {
    api: opts.ports?.api ?? Number(env.WEFT_API_PORT ?? 4070),
    web: opts.ports?.web ?? Number(env.WEFT_WEB_PORT ?? 3070),
  };
  const info: WeftPlatformInfo = {
    kind: platform.kind, env, world, readOnly: platform.readOnly === true,
    publicOrigin: durable && env.WEFT_PUBLIC_ORIGIN ? new URL(env.WEFT_PUBLIC_ORIGIN).origin : null,
    meter: pdb.meter, guard: pdb.guard, state, fixtures,
    reset: (platform as { reset?: WeftPlatformInfo["reset"] }).reset ?? null,
  };
  let closed = false;
  const weft: Weft = {
    app: undefined as never, db, dataDir, executor, sims, agent, routines, scheduler, clock, ledger, provider, proxySecret, testMode, ports, stubs,
    blobs, runFiles, platform: info,
    async close() {
      if (closed) return;
      closed = true;
      await scheduler.stop();
      // Drain (gate report item 1): let in-flight agent runs settle, then let the routine finalizations their terminal
      // steps started write, each within a bound, before the database closes. A run still going after the bound is
      // left as running; the boot rule fails it with PROCESS_RESTART on the next start, and its late writes are caught.
      const bound = Number(env.WEFT_CLOSE_DRAIN_MS ?? 5_000);
      const quiet = async (fn: () => Promise<unknown> | undefined) => { try { await fn(); } catch { /* a stubbed part has nothing to drain */ } };
      await quiet(() => (agent as { drain?: (ms: number) => Promise<boolean> }).drain?.(bound));
      await quiet(() => (routines as { drain?: (ms: number, closing: boolean) => Promise<boolean> }).drain?.(bound, true));
      try { await executor.close(); } catch (e) { if (!isStubError(e)) throw e; }
      await pdb.close();
    },
  };
  // The hosted layer (ETag/304, x-weft-tables, the read-only guard) wraps the app only where a facade meter exists.
  weft.app = durable || pdb.meter ? hostedApp(buildApp(weft), weft, pdb.meter) : buildApp(weft);
  return weft;
}
