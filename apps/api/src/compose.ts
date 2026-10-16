// The composition root (SPEC 2, 9.0). The only place that wires db, simulators, executor,
// core commands and handlers, providers, the agent runtime, routines, the scheduler and the Hono app.
// Until every track lands, factories may still throw NotImplemented; unless `strict`, each such part becomes a
// stub that throws NotImplemented when used and is listed in `weft.stubs` (and in GET /v1/health).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { INTEGRATION_OPTIONAL_SECRETS, INTEGRATION_SECRETS, IntegrationVendor, isWeftError, NotImplemented, type RunHandle, type AgentRuntime, type ExecutorBundle, type ModelProvider, type RoutinesEngine, type SimClock, type Simulators, type SpendLedger } from "@weft/contracts";
import { eq } from "drizzle-orm";
import { closeDb, migrate, notices, openDb, type Db } from "@weft/db";
import { commands, createSimClock, handlers } from "@weft/core";
import { createSimulators } from "@weft/sim";
import { createVendorOverlay, readSecret } from "@weft/integrations";
import { createExecutor, executorInternals } from "@weft/executor";
import { createAgentRuntime, createProvider, createSpendLedger, loadSecret } from "@weft/agent";
import { createRoutines, type WeftRoutinesEngine } from "@weft/routines";
import { createChatContextSource } from "./routes/agent";
import { createRoutinesEventSource } from "./routes/routines";
import type { Weft } from "./http/context";
import { buildApp } from "./app";
import { createScheduler } from "./scheduler";

export type { Weft, WeftEnv } from "./http/context";

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

function readOrCreateProxySecret(dataDir: string): string {
  const dir = join(dataDir, "run");
  const file = join(dir, "proxy.secret");
  mkdirSync(dir, { recursive: true });
  if (existsSync(file)) { const s = readFileSync(file, "utf8").trim(); if (s.length >= 32) return s; }
  const secret = randomBytes(32).toString("hex");
  writeFileSync(file, secret + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return secret;
}

/** Gate report item 2: run handles for open runs, so a waiting routine run survives an API restart (agent RunHandleStore). */
interface RunHandleStore { save(handle: RunHandle): Promise<void>; load(runId: string): Promise<RunHandle | null>; drop(runId: string): Promise<void> }

const SAFE_RUN_ID = /^run_[A-Za-z0-9_]+$/;

/** One 0600 JSON file per open run handle in `dir` (created 0700). */
function fileRunHandleStore(dir: string): RunHandleStore {
  const file = (runId: string) => {
    if (!SAFE_RUN_ID.test(runId)) throw new Error(`unsafe run id ${JSON.stringify(runId).slice(0, 40)}`);
    return join(dir, `${runId}.json`);
  };
  return {
    async save(handle) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const f = file(handle.runId);
      writeFileSync(f, JSON.stringify(handle), { mode: 0o600 });
      chmodSync(f, 0o600);
    },
    async load(runId) {
      if (!SAFE_RUN_ID.test(runId)) return null;
      try {
        const v = JSON.parse(readFileSync(file(runId), "utf8")) as Partial<RunHandle> & { nonce?: unknown };
        if (v.runId !== runId || typeof v.token !== "string") return null;
        return Object.freeze(typeof v.nonce === "string" ? { runId, token: v.token, nonce: v.nonce } : { runId, token: v.token });
      } catch { return null; }
    },
    async drop(runId) {
      if (!SAFE_RUN_ID.test(runId)) return;
      try { rmSync(file(runId), { force: true }); } catch { /* already gone */ }
    },
  };
}

const placeholderProvider: ModelProvider = {
  id: "scripted", model: "none", label: "Scripted, no model", live: false,
  step: async () => { throw new NotImplemented("provider.step (t4-agent)"); },
};

// Scripted provider only (SPEC 12 GP5): the scripted stand-in plays a model that reads the notice body when that body
// carries an injected line, so the browser GP5 exercises taint with the same delivery click as GP1. A live model
// decides for itself (eval L4) and never sees this hook.
const INJECTED_LINE = /ignore (all )?prior instructions/i;
function scriptVariant(db: Db) {
  return async ({ routineId, trigger }: { routineId: string; trigger: Record<string, unknown> }): Promise<string | null> => {
    if (routineId !== "rt_agency_notice" || typeof trigger.notice_id !== "string") return null;
    const rows = await db.select({ body: notices.bodyText }).from(notices).where(eq(notices.id, trigger.notice_id)).limit(1);
    return rows[0] && INJECTED_LINE.test(rows[0].body) ? "rt_agency_notice.injection" : null;
  };
}

export async function createWeft(opts: CreateWeftOptions): Promise<Weft> {
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

  const db = openDb({ dataDir });
  await migrate(db);
  const clock = opts.clock ?? (await createSimClock({ db, initial: testMode ? { at: "2026-10-26T15:30:00.000Z", rate: 0 } : undefined }));
  // Wave 3: real vendor adapters overlay the simulated ones only outside tests, with WEFT_INTEGRATIONS_REAL=1 and every secret present.
  const vendors = testMode ? undefined : createVendorOverlay(process.env);
  const simulators = (o: { db: Parameters<typeof createSimulators>[0]["db"]; clock: Parameters<typeof createSimulators>[0]["clock"] }) => createSimulators({ ...o, vendors });
  const sims = await tolerate<Simulators>("sim", () => simulators({ db, clock }), () => stubOf("sims"));
  const executor = await tolerate<ExecutorBundle>("executor", () => createExecutor({ db, clock, dataDir, commands, simulators, testMode }), () => stubOf("executor"));
  // Harness 6.4: provider keys may come from WEFT_SECRETS_FILE and never reach process.env; teach the redactor them too.
  for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    const v = (() => { try { return loadSecret(k, process.env); } catch { return null; } })();
    if (v) executorInternals(executor)?.addSecret(v);
  }
  // Wave 3: the vendor credentials too (and the DocuSign private key's contents), as a backstop if one ever reached
  // an action row, a refusal, the model or MCP output. Names only come from the contracts; values stay in memory.
  const vendorSecretNames = [...new Set(IntegrationVendor.options.flatMap((v) => [...INTEGRATION_SECRETS[v], ...INTEGRATION_OPTIONAL_SECRETS[v]]))];
  for (const k of vendorSecretNames) {
    const v = (() => { try { return readSecret(k, process.env); } catch { return null; } })();
    if (!v) continue;
    executorInternals(executor)?.addSecret(v);
    if (k === "DOCUSIGN_PRIVATE_KEY_FILE") {
      const pem = (() => { try { return readFileSync(v, "utf8").trim(); } catch { return null; } })();
      if (pem) executorInternals(executor)?.addSecret(pem);
    }
  }
  const ledger = await tolerate<SpendLedger>("spend-ledger", () => createSpendLedger({ dir: join(dataDir, "spend") }), () => stubOf("ledger"));
  const provider = opts.provider ?? (await tolerate<ModelProvider>("provider", () => createProvider({
    env: process.env, ledger, testMode, scriptVariant: scriptVariant(db),
    // The local chat-completions providers send each tool's compact description (wave 2, w2-providers-sandbox request 1).
    compactDescriptions: (wire) => executorInternals(executor)?.engine.registry.def(wire)?.compactDescription || null,
  }), () => placeholderProvider));
  const routinesRef: { current: RoutinesEngine | null } = { current: null };
  const agent = await tolerate<AgentRuntime>("agent", () => createAgentRuntime({
    db, clock, executor: executor.agent, provider, ledger,
    // Routines are built after the agent, so the view resolves lazily through routinesRef.
    routinesView: {
      get: (id: string) => (routinesRef.current as WeftRoutinesEngine).view.get(id),
      checklist: (x) => (routinesRef.current as WeftRoutinesEngine).view.checklist(x),
    },
    contextSource: createChatContextSource(db),
    handleStore: fileRunHandleStore(join(dataDir, "run", "handles")),
  }), () => stubOf("agent"));
  const routines = await tolerate<RoutinesEngine>("routines", () => createRoutines({ db, clock, agent, runs: executor.runs, readOnly: executor.readOnly, events: createRoutinesEventSource(db) }), () => stubOf("routines"));
  routinesRef.current = routines;
  const scheduler = createScheduler({ db, clock, sims, executor, handlers, routines, log: testMode ? () => undefined : undefined });

  // Wiring (SPEC 9.0): decisions wake routines; agent boot rule PROCESS_RESTART.
  await tolerate("wiring.onProposalDecided", () => executor.human.onProposalDecided((p) => routines.onProposalDecided(p)), () => undefined);
  if (!opts.seeding) await tolerate("wiring.agent.boot", () => agent.boot(), () => undefined);

  const proxySecret = readOrCreateProxySecret(dataDir);
  const ports = {
    api: opts.ports?.api ?? Number(process.env.WEFT_API_PORT ?? 4070),
    web: opts.ports?.web ?? Number(process.env.WEFT_WEB_PORT ?? 3070),
  };
  let closed = false;
  const weft: Weft = {
    app: undefined as never, db, dataDir, executor, sims, agent, routines, scheduler, clock, ledger, provider, proxySecret, testMode, ports, stubs,
    async close() {
      if (closed) return;
      closed = true;
      await scheduler.stop();
      // Drain (gate report item 1): let in-flight agent runs settle, then let the routine finalizations their terminal
      // steps started write, each within a bound, before the database closes. A run still going after the bound is
      // left as running; the boot rule fails it with PROCESS_RESTART on the next start, and its late writes are caught.
      const bound = Number(process.env.WEFT_CLOSE_DRAIN_MS ?? 5_000);
      const quiet = async (fn: () => Promise<unknown> | undefined) => { try { await fn(); } catch { /* a stubbed part has nothing to drain */ } };
      await quiet(() => (agent as { drain?: (ms: number) => Promise<boolean> }).drain?.(bound));
      await quiet(() => (routines as { drain?: (ms: number, closing: boolean) => Promise<boolean> }).drain?.(bound, true));
      try { await executor.close(); } catch (e) { if (!isStubError(e)) throw e; }
      await closeDb(db);
    },
  };
  weft.app = buildApp(weft);
  return weft;
}
