// Weft on Cloudflare, round 0 contract (track cf0-contracts; docs/cloudflare/design.md 3.3, 4 and 6.4). Additive
// only. The platform seams `assembleWeft(platform, opts)` composes over: where the database, uploads, small state,
// fixtures, run handles and run files live, how ticks and run jobs are hosted, which memory repo and spend ledger a
// world uses, and the executor's hosted options. `createWeft(opts)` is `assembleWeft(nodePlatform, opts)`, and Node
// keeps today's behavior: every part a platform leaves out falls back to the code apps/api/src/assemble.ts runs
// today. The durable platform supplies every part. Implemented by cf2-platform (apps/api, packages/executor);
// CompanyDO (cf4-worker) builds the durable platform from DurablePlatformInput. Types and constants only.
import type { CommandDef, RunHandle } from "../commands";
import type { SystemPrincipal } from "../runtime";
import type { SpendLedger } from "../spend";
import type { DurableStorageLike, SqlMeter, TxGuard } from "./cf-db";
import type { MemoryRepo } from "./cf-memory";
import type { FetchCounter, HostedSpendLedger, RunHost, WorkersAiBindingLike } from "./cf-agent";
import type { HostedWorldRef } from "./cf-hosted";

export type PlatformKind = "node" | "durable";

/** Environment switches the hosted work adds. On Node each is off unless set; the durable platform sets them all. */
export const CF_ENV = {
  /** "durable-emu": Node's database is openDurableDb over the node:sqlite emulator. */
  db: "WEFT_DB",
  /** "sqlite": the SQL memory repo on Node. */
  memory: "WEFT_MEMORY",
  /** "sqlite": the SQL BlobStore on Node. */
  blobs: "WEFT_BLOBS",
  /** "1": reads outside a run return ephemeral `res_e_` ids and write no rows. */
  ephemeralReadIds: "WEFT_EPHEMERAL_READ_IDS",
  /** "cloudflare" on hosted. */
  runtime: "WEFT_RUNTIME",
  /** "1": assemble throws when WEFT_VAULT_KEY is missing (hosted fails closed). */
  requireVaultKey: "WEFT_REQUIRE_VAULT_KEY",
  /** The only allowed origin on hosted, for example https://weft.nitish-ratakonda.workers.dev. */
  publicOrigin: "WEFT_PUBLIC_ORIGIN",
  /** "0" (default): semantic recall candidates off. */
  semanticRecall: "WEFT_SEMANTIC_RECALL",
  /** "1": `next build` emits the static export (cf5-web). */
  staticExport: "WEFT_STATIC_EXPORT",
  /** "1": the web build includes the hosted shell (cf5-web). */
  hostedWeb: "NEXT_PUBLIC_WEFT_HOSTED",
} as const;

/** Content-addressed uploads (design 4.1). Node: `<dataDir>/uploads/<sha256>.bin`, storage_path `uploads/<sha256>.bin`.
 * SQL: the `blobs` table in 1 MiB chunks, storage_path `blob:<sha256>`. Hosted uploads are capped at 1.5 MB. */
export interface BlobStore {
  readonly kind: "file" | "sqlite";
  /** Stores bytes under their sha256; `fresh` is false when they were already stored. Returns the storage_path. */
  put(bytes: Uint8Array): Promise<{ storagePath: string; sha256: string; bytes: number; fresh: boolean }>;
  get(storagePath: string): Promise<Uint8Array | null>;
  has(storagePath: string): Promise<boolean>;
  /** Undo for a put whose command was then refused. */
  delete(storagePath: string): Promise<void>;
}

/** Small synchronous values (Node: files under dataDir; durable: the `kv_state` table, part of the slot's transactions). */
export interface SmallState {
  get(key: string): string | null;
  set(key: string, value: string): void;
  /** Stores `value` unless the key exists, and returns what is stored now. */
  setIfAbsent(key: string, value: string): string;
  delete(key: string): void;
}
export const SMALL_STATE_KEYS = {
  /** Node: `wld_<16 hex>` in companies/.world-id; durable: hostedWorldId(), "slot-N:gen-G". */
  worldId: "world.id",
  /** "1" on the showcase: every mutation is refused in the DO too. */
  readOnly: "world.readonly",
  /** The lease's visitor and IP hash: background runs are charged to them. */
  leaseVisitor: "lease.visitor",
  leaseIpHash: "lease.ip_hash",
  /** The lease's start (epoch ms): the slot checks the lease's own total and idle expiry against it (MCP keys). */
  leaseStartedAt: "lease.started_at",
  /** JSON array of the plaintext keys minted for the current lease, for the redactor only; gone with the lease. */
  leaseKeys: "lease.keys",
} as const;

/** Bundled fixtures (Node: the repo files; durable: the generated module apps/cf/generated/fixtures.ts). Paths are
 * repo-relative with "/", for example packages/sim/fixtures/notices/<name>.txt. */
export interface FixtureSource {
  text(path: string): string | null;
  bytes(path: string): Uint8Array | null;
  /** Sorted file paths directly under a directory. */
  list(dir: string): string[];
}

/** A run handle as the store keeps it: a bearer credential, never in run_steps, read by no route. */
export interface RunHandleRecord extends RunHandle { readonly nonce?: string }
/** Node: one 0600 JSON file per open run under <dataDir>/run/handles; durable: the `run_handles` table. */
export interface RunHandleStore {
  save(handle: RunHandleRecord): Promise<void>;
  load(runId: string): Promise<RunHandleRecord | null>;
  drop(runId: string): Promise<void>;
}

/** Run artifacts and sandbox code, keyed by the dataDir-relative path the run_artifacts row records
 * (companies/<cmp>/runs/<run>/artifacts/<n>-<wire>.json). Durable: the `run_files` table, bodies over 2 MB chunked. */
export interface RunFileStore {
  write(path: string, body: string): Promise<void>;
  read(path: string): Promise<string | null>;
  /** Removes every file under a prefix (a world reset). */
  removePrefix(prefix: string): Promise<void>;
}

/** Periodic scheduler ticks. Node: setInterval every intervalMs plus kick() after mutations, as today. Durable:
 * kick() inline after mutations, and periodic ticks from the DO alarm only while the clock rate is above 0. */
export interface SchedulerHost {
  start(input: { tick: () => Promise<void>; intervalMs: number; clockRate: () => number }): void;
  stop(): Promise<void>;
}

/** The system principals including svc_jobs, the queue write-backs' principal; the frozen SystemPrincipal holds it since
 * the integration fold (cf7), and the name stays for the hosted modules' imports. */
export type HostedSystemPrincipal = SystemPrincipal;

export interface HostedExecutorOptions {
  /** `def.effect === "read"` with no run returns `res_e_` + 16 random hex instead of minting a counter id, so reads
   * write no rows (design 4.4). Run reads keep counter ids. Off on Node, so id sequences and eval digests stay put. */
  ephemeralReadIds?: boolean;
  /** Commands registered on this platform only (the hidden OCR write-backs in cf-extras.ts). */
  extraCommands?: readonly CommandDef[];
  /** Called after an outer commit that appended outbox rows; the slot sends each to its queue and deletes the row.
   * Absent on Node, where no command appends an outbox row. */
  onOutbox?: () => void;
}
export const EPHEMERAL_READ_ID_PREFIX = "res_e_";

/** The database a platform opens. Durable: openDurableDb plus migrate-durable, with its meter and guard. */
export interface PlatformDb<TDb> { db: TDb; meter: SqlMeter | null; guard: TxGuard | null; close(): Promise<void> }

/** What a platform part factory receives once assemble has opened the database. */
export interface PlatformContext<TDb = unknown> {
  readonly dataDir: string;
  readonly db: TDb;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly testMode: boolean;
}

/**
 * A platform for assembleWeft. `TDb` is @weft/db's Db (contracts cannot import it). Every part is optional so the
 * Node platform can start as `{ kind: "node" }` with today's code paths, and gain parts one at a time.
 */
export interface WeftPlatform<TDb = unknown> {
  readonly kind: PlatformKind;
  /** Absent: process.env. Durable: Worker vars and secrets only (no secrets file, no process.env). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The hosted world this platform serves; absent on Node. */
  readonly world?: HostedWorldRef;
  /** True on the showcase: the read-only world guard refuses every mutation. */
  readonly readOnly?: boolean;
  openDb?(dataDir: string): Promise<PlatformDb<TDb>>;
  blobs?(ctx: PlatformContext<TDb>): BlobStore;
  state?(ctx: PlatformContext<TDb>): SmallState;
  readonly fixtures?: FixtureSource;
  runHandles?(ctx: PlatformContext<TDb>): RunHandleStore;
  runFiles?(ctx: PlatformContext<TDb>): RunFileStore;
  /** The memory repo for a company's memory. */
  memoryRepo?(ctx: PlatformContext<TDb>, companyId: string): MemoryRepo;
  /** The ledger the agent runtime gets. Durable: an adapter over SpendDO bound to this world's lease. */
  spendLedger?(ctx: PlatformContext<TDb>): SpendLedger;
  readonly runHost?: RunHost;
  readonly schedulerHost?: SchedulerHost;
  readonly executor?: HostedExecutorOptions;
}

/**
 * Admits a run the API starts on its own, with no HTTP request of its own to pass the host's gates: the cursor
 * assistant's handoff to a chat run. The hosted slot supplies it (RL_RUN for the lease's visitor and the rows budget,
 * as at the door for POST /v1/agent/runs); without one (Node) every such run is admitted.
 */
export type RunAdmission = (input: { kind: "assist_handoff"; fromRunId: string }) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;

/** The durable platform supplies every part. */
export type DurableWeftPlatform<TDb = unknown> = Required<WeftPlatform<TDb>> & { readonly kind: "durable" };

/** What CompanyDO hands cf2's `durablePlatform(input)`. */
export interface DurablePlatformInput {
  storage: DurableStorageLike;
  env: Readonly<Record<string, string | undefined>>;
  world: HostedWorldRef;
  fixtures: FixtureSource;
  /** A SpendDO client (RPC stub calls assert they are not inside a transaction). */
  spend: HostedSpendLedger;
  runHost: RunHost;
  schedulerHost: SchedulerHost;
  extraCommands?: readonly CommandDef[];
  onOutbox?: () => void;
  // Integration additions (cf3-agent request 2, folded by cf7): what the hosted model path needs from the Worker.
  /** The Workers AI binding (`env.AI`) for the workers_ai switch; absent locally where nothing emulates it. */
  ai?: WorkersAiBindingLike | null;
  /** The fetch the model transports call: CompanyDO's counted fetch (at most MAX_FETCHES_PER_ALARM per alarm). */
  fetch?: typeof fetch;
  fetchCounter?: FetchCounter | null;
}
