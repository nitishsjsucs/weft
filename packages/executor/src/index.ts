// The hands (SPEC 9.3, harness 5 and 6). Owner: t3-governance. Weft on Cloudflare (docs/cloudflare/design.md 3.3,
// 4.1, 4.2 and 4.4, track cf2-platform): the platform hands in the environment, the vault key, the run file store,
// the boot-time redactor secrets and the hosted options; every one defaults to today's Node behavior.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { NotImplemented, type ExecutorBundle, type SandboxEngine, type SimClock } from "@weft/contracts";
import { createMemoryStore } from "./memory/store";
import { seedMemoryFiles } from "./memory/seed-content";
import { memoryCommands } from "./memory/commands";
import { withMemoryCitations } from "./memory/citations";
import { type Db } from "@weft/db";
import type { WeftCommand } from "@weft/core";
import { createAgentExecutor } from "./agent";
import { builtinCommands } from "./builtins";
import { verifyActions } from "./chain";
import type { Engine, SimulatorsFactory } from "./engine";
import { createHumanExecutor } from "./human";
import { expireProposals, fireExpired } from "./proposals";
import { createRegistry } from "./registry";
import { createRunAuthority } from "./runs";
import { markTainted } from "./taint";
import { createReadOnlyExecutor, createSystemExecutor } from "./system";
import { Redactor } from "./vault/redact";
import { createVault, loadVaultKey } from "./vault/vault";
import { writeLocked } from "./write";
import { sandboxFromEnv } from "./sandbox/select";
import { NODE_HOSTED, type EngineHosted } from "./engine";
import { fileRunFiles, type RunFileStore } from "./hosted/run-files";
import { JOBS_ALLOWLIST, JOBS_PRINCIPAL } from "./hosted/commands";
import type { OutboxWorld } from "./hosted/outbox";
import type { TxGuard } from "../../contracts/src/ext/cf-db";
import type { BlobStore, HostedExecutorOptions } from "../../contracts/src/ext/cf-platform";
import type { MemoryRepo } from "../../contracts/src/ext/cf-memory";

export type { SimulatorsFactory } from "./engine";
export { toStrictJsonSchema, nullToUndefined, sampleFromSchema, rawJsonSchema, strictSchemaProblems } from "./strict-schema";
export { createRegistry, wireName, MAX_TOOLS, type Registry } from "./registry";
export { policy, riskOf, RISK_RANK, TAINTED_WRITE_COMMANDS, type PolicyFacts } from "./policy";
export { SYSTEM_ALLOWLISTS, SYSTEM_PRINCIPALS } from "./system";
export { Redactor, encodings } from "./vault/redact";
export { writeLocked, isBusy } from "./write";
export { escapeUntrusted, wrapUntrusted, nonceFromToken, LT_ESCAPE } from "./untrusted";
export { actionHash, GENESIS_HASH } from "./chain";
export { toProposal, approvalCardOf } from "./proposals";
export { toCsv } from "./workspace";
export type { WeftRunHandle } from "./runs";
export type { BatchedAgentCall } from "./agent";
export { adminChange, createApiKey, AdminRefused } from "./admin";
export { MemoryError, MEMORY_FOLDERS } from "./memory/store";
export { serialGit } from "./memory/git";
export { COMPANY_TZ, companyDay, fmtDateTimePT, humanTimes } from "./memory/time";
export { fileRunFiles, runRel, safeRunFileKey, type RunFileStore } from "./hosted/run-files";
export { appendOutbox, ackOutbox, pendingOutbox, jobsFor, contentTypeOf, type HostedJobDraft, type OutboxWorld } from "./hosted/outbox";
export { hostedServiceCommands, JOBS_PRINCIPAL, JOBS_ALLOWLIST, MAX_SCAN_TEXT } from "./hosted/commands";
export { ephemeralReadId, EPHEMERAL_READ_ID } from "./hosted/read-ids";

export interface CreateExecutorOptions {
  db: Db;
  clock: SimClock;
  dataDir: string;
  commands: WeftCommand[];
  simulators: SimulatorsFactory;
  testMode: boolean;
  log?: (line: string) => void;
  /** The environment for the redactor and the sandbox selector; process.env when absent (Node). */
  env?: Readonly<Record<string, string | undefined>>;
  /** The vault key; when absent, loadVaultKey reads or creates <dataDir>/run/vault.key (Node). */
  vaultKey?: Buffer;
  /** Run artifact and code bodies; files under dataDir when absent (Node). */
  runFiles?: RunFileStore;
  /** The world's upload store, exposed to the seed through executorInternals (receipts go where uploads go). */
  blobs?: BlobStore | null;
  /** Plaintexts the redactor learns at boot; when absent, <dataDir>/demo-api-key.txt and demo-mcp-key.txt (Node). */
  bootSecrets?: () => readonly string[];
  /** Hosted executor options (ephemeral read ids, extra commands, the outbox); all off when absent (Node). */
  hosted?: HostedExecutorOptions & { outboxWorld?: OutboxWorld | null };
  /** The durable facade's IO_IN_TX guard. */
  txGuard?: TxGuard | null;
  /** The memory repo per company (docs/cloudflare/design.md 4.3). Handed to the memory store; when absent it keeps today's git repo. */
  memoryRepo?: (companyId: string) => MemoryRepo;
}

/** Executor internals that apps/api routes and the seed may reach (never the brain). */
export interface ExecutorInternals {
  engine: Engine;
  addSecret(value: string | null | undefined): void;
  /** Taints a freshly opened run, for runs started from a tainted suggestion (harness 6.2). */
  taintRun(runId: string, by: string): Promise<void>;
  /** The world's upload store when the composition root gave one (the seed stores receipts through it). */
  blobs: BlobStore | null;
}
const internals = new WeakMap<object, ExecutorInternals>();
export function executorInternals(bundle: ExecutorBundle): ExecutorInternals | null { return internals.get(bundle) ?? null; }


export async function createExecutor(opts: CreateExecutorOptions): Promise<ExecutorBundle> {
  const env = opts.env ?? process.env;
  const redactor = new Redactor();
  for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "WEFT_VAULT_KEY"]) redactor.add(env[k]);
  const key = opts.vaultKey ?? loadVaultKey(opts.dataDir, env);
  redactor.add(key.toString("hex"));
  const vault = createVault({ db: opts.db, clock: opts.clock, key, redactor });
  const extra = opts.hosted?.extraCommands ?? [];
  const hosted: EngineHosted = opts.hosted || opts.txGuard ? {
    ephemeralReadIds: opts.hosted?.ephemeralReadIds === true,
    outbox: opts.hosted?.onOutbox ? (opts.hosted.outboxWorld ?? null) : null,
    onOutbox: opts.hosted?.onOutbox ?? null, outboxPending: false,
    guard: opts.txGuard ?? null,
    // svc_jobs exists only where its write-backs are registered (the durable platform's extraCommands).
    systemAllowlists: new Map(extra.some((c) => JOBS_ALLOWLIST.includes(c.name)) ? [[JOBS_PRINCIPAL, JOBS_ALLOWLIST.filter((n) => extra.some((c) => c.name === n))]] : []),
  } : NODE_HOSTED;
  const engine: Engine = {
    db: opts.db, clock: opts.clock, dataDir: opts.dataDir, testMode: opts.testMode, registry: undefined as never, redactor, vault,
    simulators: opts.simulators, memory: undefined as never, decided: [], batches: new Map(), lastBatch: new Map(),
    log: opts.log ?? ((line) => { if (!opts.testMode) console.error(redactor.redact(line)); }), gitHeadSeq: null,
    runFiles: opts.runFiles ?? fileRunFiles(opts.dataDir), env, hosted,
  };
  // The repo port (cf1-db) rides along when the platform has one; the store keeps today's git repo otherwise.
  const memoryOptions = {
    dataDir: opts.dataDir, clock: opts.clock, redactor,
    defaultCompanyId: async () => (await opts.db.all<{ id: string }>(sql`SELECT id FROM companies ORDER BY id LIMIT 1`))[0]?.id ?? null,
    initialFiles: (companyId: string, now: string) => seedMemoryFiles(opts.db, companyId, now),
    ...(opts.memoryRepo ? { repo: opts.memoryRepo } : {}),
  };
  const memory = createMemoryStore(memoryOptions);
  engine.memory = memory;
  const mine = [...builtinCommands(engine), ...memoryCommands(engine)];
  const own = new Set(mine.map((c) => c.name));
  // Wave 4 round 2 (R3): a command that cites a memory note (notices.escalate procedure_ref) is checked against memory.
  // Platform-only commands (the hidden OCR write-backs) join last; Node passes none, so its registry is unchanged.
  engine.registry = createRegistry(withMemoryCitations(memory, [...opts.commands.filter((c) => !own.has(c.name)), ...mine, ...(extra as WeftCommand[])]));
  await vault.primeRedactor().catch(() => undefined);
  if (opts.bootSecrets) {
    for (const v of opts.bootSecrets()) redactor.add(v);
  } else {
    for (const f of ["demo-api-key.txt", "demo-mcp-key.txt"]) {
      try { redactor.add(readFileSync(join(opts.dataDir, f), "utf8").trim()); } catch { /* not seeded yet */ }
    }
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
    expireProposals: async (now) => {
      const expired = await writeLocked(() => opts.db.transaction((tx) => expireProposals(engine, tx, now)));
      await fireExpired(engine, expired);
      return expired.length;
    },
    async verifyChain() {
      const gitSeq = memory.root() ? (memory.chainHeadSeq() ?? 0) : null;
      const s = await verifyActions(opts.db, gitSeq);
      return { ok: s.ok, head: s.head, gaps: s.gaps, badSeq: s.badSeq, gitLag: s.gitLag, signatureProblems: s.signatureProblems };
    },
    redact: (text) => redactor.redact(text),
    async close() { /* the db belongs to createWeft; nothing else is held open */ },
  };
  internals.set(bundle, {
    engine, addSecret: (v) => redactor.add(v), blobs: opts.blobs ?? null,
    taintRun: (runId, by) => writeLocked(() => opts.db.transaction((tx) => markTainted(tx, runId, by, 0))),
  });
  return bundle;
}

/**
 * The code.run sandbox (SPEC 9.9, harness 3). WEFT_SANDBOX=quickjs returns the quickjs-emscripten engine that runs
 * inside the executor; off (the default, and the hosted Cloudflare Workers Free twin) throws NotImplemented, as do
 * the engines that are not built (microvm, and Dynamic Workers "worker_loader" on the paid upgrade path), all
 * behind the same SandboxEngine contract.
 */
export function createSandbox(env: Record<string, string | undefined> = process.env): SandboxEngine {
  const s = sandboxFromEnv(env);
  if (!s.engine) throw new NotImplemented(`createSandbox: ${s.reason}`);
  return s.engine;
}
