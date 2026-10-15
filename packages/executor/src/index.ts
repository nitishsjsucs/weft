// The hands (SPEC 9.3, harness 5 and 6). Owner: t3-governance.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { NotImplemented, type ExecutorBundle, type SandboxEngine, type SimClock } from "@weft/contracts";
import { createMemoryStore } from "./memory/store";
import { seedMemoryFiles } from "./memory/seed-content";
import { memoryCommands } from "./memory/commands";
import { withWriteLock, type Db } from "@weft/db";
import type { WeftCommand } from "@weft/core";
import { createAgentExecutor } from "./agent";
import { builtinCommands } from "./builtins";
import { verifyActions } from "./chain";
import type { Engine, SimulatorsFactory } from "./engine";
import { createHumanExecutor } from "./human";
import { expireProposals } from "./proposals";
import { createRegistry } from "./registry";
import { createRunAuthority } from "./runs";
import { markTainted } from "./taint";
import { createReadOnlyExecutor, createSystemExecutor } from "./system";
import { Redactor } from "./vault/redact";
import { createVault, loadVaultKey } from "./vault/vault";

export type { SimulatorsFactory } from "./engine";
export { toStrictJsonSchema, nullToUndefined, sampleFromSchema, rawJsonSchema, strictSchemaProblems } from "./strict-schema";
export { createRegistry, wireName, MAX_TOOLS, type Registry } from "./registry";
export { policy, riskOf, RISK_RANK, TAINTED_WRITE_COMMANDS, type PolicyFacts } from "./policy";
export { SYSTEM_ALLOWLISTS, SYSTEM_PRINCIPALS } from "./system";
export { Redactor, encodings } from "./vault/redact";
export { escapeUntrusted, wrapUntrusted, nonceFromToken, LT_ESCAPE } from "./untrusted";
export { actionHash, GENESIS_HASH } from "./chain";
export { toProposal } from "./proposals";
export { toCsv } from "./workspace";
export type { WeftRunHandle } from "./runs";
export type { BatchedAgentCall } from "./agent";
export { adminChange, createApiKey, AdminRefused } from "./admin";
export { MemoryError, MEMORY_FOLDERS } from "./memory/store";

export interface CreateExecutorOptions {
  db: Db;
  clock: SimClock;
  dataDir: string;
  commands: WeftCommand[];
  simulators: SimulatorsFactory;
  testMode: boolean;
  log?: (line: string) => void;
}

/** Executor internals that apps/api routes and the seed may reach (never the brain). */
export interface ExecutorInternals {
  engine: Engine;
  addSecret(value: string | null | undefined): void;
  /** Taints a freshly opened run, for runs started from a tainted suggestion (harness 6.2). */
  taintRun(runId: string, by: string): Promise<void>;
}
const internals = new WeakMap<object, ExecutorInternals>();
export function executorInternals(bundle: ExecutorBundle): ExecutorInternals | null { return internals.get(bundle) ?? null; }


export async function createExecutor(opts: CreateExecutorOptions): Promise<ExecutorBundle> {
  const redactor = new Redactor();
  for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "WEFT_VAULT_KEY"]) redactor.add(process.env[k]);
  const key = loadVaultKey(opts.dataDir);
  redactor.add(key.toString("hex"));
  const vault = createVault({ db: opts.db, clock: opts.clock, key, redactor });
  const engine: Engine = {
    db: opts.db, clock: opts.clock, dataDir: opts.dataDir, testMode: opts.testMode, registry: undefined as never, redactor, vault,
    simulators: opts.simulators, memory: undefined as never, decided: [], batches: new Map(), lastBatch: new Map(),
    log: opts.log ?? ((line) => { if (!opts.testMode) console.error(redactor.redact(line)); }), gitHeadSeq: null,
  };
  const memory = createMemoryStore({
    dataDir: opts.dataDir, clock: opts.clock, redactor,
    defaultCompanyId: async () => (await opts.db.all<{ id: string }>(sql`SELECT id FROM companies ORDER BY id LIMIT 1`))[0]?.id ?? null,
    initialFiles: (companyId, now) => seedMemoryFiles(opts.db, companyId, now),
  });
  engine.memory = memory;
  const mine = [...builtinCommands(engine), ...memoryCommands(engine)];
  const own = new Set(mine.map((c) => c.name));
  engine.registry = createRegistry([...opts.commands.filter((c) => !own.has(c.name)), ...mine]);
  await vault.primeRedactor().catch(() => undefined);
  for (const f of ["demo-api-key.txt", "demo-mcp-key.txt"]) {
    try { redactor.add(readFileSync(join(opts.dataDir, f), "utf8").trim()); } catch { /* not seeded yet */ }
  }

  const bundle: ExecutorBundle = {
    agent: createAgentExecutor(engine),
    readOnly: createReadOnlyExecutor(engine),
    runs: createRunAuthority(engine),
    human: createHumanExecutor(engine),
    system: createSystemExecutor(engine),
    vault: { put: (i) => vault.put(i), list: () => vault.list() },
    memory: engine.memory,
    registry: engine.registry,
    expireProposals: (now) => withWriteLock(() => opts.db.transaction((tx) => expireProposals(engine, tx, now))),
    async verifyChain() {
      const gitSeq = memory.root() ? (memory.chainHeadSeq() ?? engine.gitHeadSeq ?? 0) : null;
      const s = await verifyActions(opts.db, gitSeq);
      return { ok: s.ok, head: s.head, gaps: s.gaps, badSeq: s.badSeq, gitLag: s.gitLag };
    },
    redact: (text) => redactor.redact(text),
    async close() { /* the db belongs to createWeft; nothing else is held open */ },
  };
  internals.set(bundle, {
    engine, addSecret: (v) => redactor.add(v),
    taintRun: (runId, by) => withWriteLock(() => opts.db.transaction((tx) => markTainted(tx, runId, by, 0))),
  });
  return bundle;
}

/**
 * P1 (SPEC 9.9, harness 3): code.run sandbox. Local engine is quickjs-emscripten inside the executor; the hosted
 * Cloudflare Workers Free twin keeps WEFT_SANDBOX=off; Dynamic Workers ("worker_loader") are the paid upgrade path
 * behind the same SandboxEngine contract. P0 ships only this stub.
 */
export function createSandbox(): SandboxEngine {
  throw new NotImplemented("createSandbox (P1, WEFT_SANDBOX=off)");
}
