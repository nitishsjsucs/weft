// The seam between CompanyDO's Durable Object plumbing and the Weft stack it hosts. CompanyDO owns the request gate
// (x-weft-ctx, generations, the read-only showcase), the alarm, the WebSocket feed, the outbox flush, leases and the
// reset and restore steps; an EngineModule supplies the world: assembleWeft over the durable platform (cf1's facade,
// cf2's platform, cf3's agent and MCP handler) plus the storage-level snapshot operations. The real module is
// weft-engine.ts, loaded lazily (design 3.2: @weft/* is imported inside blockConcurrencyWhile); the Miniflare suite
// plugs a small fake in through the same seam, so the plumbing is tested without the Weft stack.
import type {
  DurableStorageLike, HostedProviderId, HostedSpendLedger, HostedWorldRef, McpKeyMint, RunHost, SchedulerHost, SqlMeter, TxGuard,
} from "../../shared/contracts";

/** What the world boots with (DurablePlatformInput, plus the DO-side knobs). */
export interface WorldBootInput {
  storage: DurableStorageLike;
  /** Worker vars and secrets, with the KV weft-config values folded in (at most 60 s old; see company-do.ts). */
  env: Readonly<Record<string, string | undefined>>;
  world: HostedWorldRef;
  spend: HostedSpendLedger;
  runHost: RunHost;
  schedulerHost: SchedulerHost;
  /** After an outer commit that appended outbox rows. */
  onOutbox: () => void;
  readOnly: boolean;
  /** Counted fetch for model transports (design 8.1: at most 40 per alarm). */
  fetch: typeof fetch;
  /** MCP agent_ask admission per key per UTC day (MCP_AGENT_ASK_PER_KEY_DAY, a Lobby counter). */
  mcpAskAllowed: (apiKey: string) => Promise<boolean>;
}

export interface WorldEngine {
  readonly meter: SqlMeter;
  readonly guard: TxGuard;
  /** The world's Hono app, inside its WorldScope. */
  fetch(req: Request): Promise<Response>;
  /** Stateless Streamable HTTP MCP at /mcp (design 3.3), its tools calling the app in process; the key comes from
   * the request (Bearer or x-api-key) and the in-process API checks it like any key. */
  mcp(req: Request): Promise<Response>;
  /** Runs alarm-side work (scheduler ticks, run jobs) inside the world's scope. */
  inScope<T>(fn: () => Promise<T>): Promise<T>;
  /** The sim clock rate; periodic ticks run only while it is above 0. */
  clockRate(): number;
  /** The lease's MCP key, minted through the executor's admin path (the plaintext is shown once). */
  mintMcpKey(input: { slot: string; gen: number; principalId: string | null; publicUrl: string; expiresAt: string }): Promise<McpKeyMint>;
  /** The Simulators panel's model switch: the per-world provider setting (null clears it). */
  setWorldProvider(input: { provider: HostedProviderId | null; principalId: string | null }): Promise<void>;
  /** Teaches the redactor a secret (minted lease keys). */
  addSecret(value: string): void;
  /** Drains in-flight work within a bound and closes the world. */
  close(): Promise<void>;
}

/** The bundled snapshot (design 4.1): built on Node by pnpm cf:snapshot with cf1's buildSnapshot, decoded once. */
export interface SnapshotArtifacts {
  /** The snapshot's identity: KV snapshot.version names the one deployed, and a slot restored from another is stale. */
  version: string;
  manifest: SnapshotManifestView;
  /** cf1-db's Snapshot (manifest, INSERT chunks under 90 KB, per-table seed rows), opaque to this seam. */
  snapshot: unknown;
}

/** The manifest fields CompanyDO reads (cf1's SnapshotManifest; `extra` is what scripts/cf/snapshot.ts adds). */
export interface SnapshotManifestView {
  journalHash: string;
  digest: string;
  chunks: number;
  rows: number;
  extra?: SnapshotExtra;
}

/** What scripts/cf/snapshot.ts records beside cf1's manifest (design 9.2 step 2). */
export interface SnapshotExtra {
  snapshotId: string;
  createdAt: string;
  profile: "rich";
  worldDigest: string;
  chainHead: string | null;
  memoryHead: string | null;
  vaultKeyFingerprint: string;
  stats: unknown;
}

export interface VerifyResult { ok: boolean; mismatches: string[]; rows: number; chainValid: boolean }
export interface DeltaResetResult { ok: boolean; rowsWritten: number; mismatches: string[] }
export interface RestoreTrigger { name: string; sql: string }

/** Storage-level operations (cf1's migrate-durable.ts and snapshot.ts); none needs a running world. */
export interface WorldStore {
  /** After deleteAll: apply the migrations and set the schema's triggers aside (finishRestore recreates them). */
  beginRestore(storage: DurableStorageLike, a: SnapshotArtifacts): { applied: number; triggers: RestoreTrigger[] };
  chunkCount(a: SnapshotArtifacts): number;
  /** Runs restore chunk `index` (an INSERT batch). */
  restoreChunk(storage: DurableStorageLike, a: SnapshotArtifacts, index: number): { rowsWritten: number };
  /** Triggers back, sequences as the source had them, the dirty-tracking triggers armed, then a full digest check. */
  finishRestore(storage: DurableStorageLike, a: SnapshotArtifacts, triggers: readonly RestoreTrigger[]): { ok: boolean; mismatches: string[]; rowsWritten: number };
  /** Counts, digests and chain head against the manifest; `full` digests every table. */
  verify(storage: DurableStorageLike, a: SnapshotArtifacts, opts: { full: boolean }): VerifyResult;
  /** True when no domain row was written since the last reset (the dirty-key table holds nothing but kv_state). */
  isClean(storage: DurableStorageLike): boolean;
  deltaReset(storage: DurableStorageLike, a: SnapshotArtifacts): DeltaResetResult;
  /** The design 11.3 conformance cases on this object's storage (the deployed `conformance` scratch object). */
  conformance?(storage: DurableStorageLike): Promise<{ passed: number; failed: number; cases: { name: string; ok: boolean; detail?: string }[] }>;
}

export interface EngineModule {
  boot(input: WorldBootInput): Promise<WorldEngine>;
  store: WorldStore;
  /** The bundled snapshot artifacts, decompressed once per isolate. */
  artifacts(): Promise<SnapshotArtifacts>;
}

export type EngineLoader = () => Promise<EngineModule>;

let loader: EngineLoader | null = null;

/** The entry module wires the engine: src/core/index.ts the real one, the Miniflare suite's entry a fake. */
export function setEngineLoader(l: EngineLoader): void {
  loader = l;
}

let loaded: Promise<EngineModule> | null = null;
export function loadEngine(): Promise<EngineModule> {
  if (!loader) return Promise.reject(new Error("CompanyDO has no engine loader; the worker entry must call setEngineLoader"));
  loaded ??= loader().catch((e: unknown) => { loaded = null; throw e; });
  return loaded;
}
