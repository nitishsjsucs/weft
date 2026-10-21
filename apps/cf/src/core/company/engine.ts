// The seam between CompanyDO's Durable Object plumbing and the Weft stack it hosts. CompanyDO owns the request gate
// (x-weft-ctx, generations, the read-only showcase), the alarm, the WebSocket feed, the outbox flush, leases and the
// reset and restore steps; an EngineModule supplies the world: assembleWeft over the durable platform (cf1's facade,
// cf2's platform, cf3's agent and MCP handler) plus the storage-level snapshot operations. The real module is
// weft-engine.ts, loaded lazily (design 3.2: @weft/* is imported inside blockConcurrencyWhile); the Miniflare suite
// plugs a small fake in through the same seam, so the plumbing is tested without the Weft stack.
import type {
  AigMetadata, DurableStorageLike, HostedProviderId, HostedSpendLedger, HostedWorldRef, McpKeyMint, RunHost, SchedulerHost, SqlMeter, TxGuard, WorkersAiBindingLike,
} from "../../shared/contracts";
import type { AiGatewayOption, ExtrasFlags, HostedJob, NeuronBudget, QueueLike, R2BucketLike, RunCatalogRow, VectorizeLike } from "@weft/cf-extras";
import type { SlotExtrasPort } from "../../extras/ports";

/** The Worker bindings the extras use inside a world (cf6-extras); an absent one switches its extra off. */
export interface WorldExtrasBindings {
  ai: WorkersAiBindingLike | null;
  vectors: VectorizeLike | null;
  files: R2BucketLike | null;
  render: QueueLike<HostedJob> | null;
  /** The memoized KV flags (flagsFor(env)). */
  flags: () => Promise<ExtrasFlags>;
  /** SpendDO's ledger as the embeddings share sees it. */
  neurons: NeuronBudget | null;
  gateway: (meta: AigMetadata) => AiGatewayOption | null;
  /** The snapshot this world was restored from (the seed vectors live in seed-<snapshot>). */
  snapshot: () => string;
}

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
  /** The Workers AI binding for the workers_ai switch (absent where nothing provides it). */
  ai?: WorkersAiBindingLike | null;
  /** MCP agent_ask admission per key per UTC day (MCP_AGENT_ASK_PER_KEY_DAY, a Lobby counter). */
  mcpAskAllowed: (apiKey: string) => Promise<boolean>;
  /** The extras' bindings; absent in the fake-engine suite. */
  extras?: WorldExtrasBindings;
}

/** What the PDF route needs from CompanyDO beyond the world (design 6.3). */
export interface WorldPdfInput {
  ctx: { human: boolean; smoke: boolean };
  /** Browser milliseconds used today (the Lobby counter pdf.browser_ms). */
  browserMsUsed: () => Promise<number>;
  /** A globally unique job id (obx_<16 hex>). */
  newJobId: () => string;
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
  /** The extras' slot port (CompanyDO's extras* RPC methods delegate to it); null without the extras bindings. */
  readonly extras?: SlotExtrasPort | null;
  /** GET /_hosted/pdf/<kind>/<id> on this world (cf6's handleHostedPdf over the world's own read routes). */
  pdf?(request: Request, input: WorldPdfInput): Promise<Response>;
  /** The run catalog row of a run that settled (done, failed or waiting), or null while it runs. */
  catalogRow?(runId: string): Promise<RunCatalogRow | null>;
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
  /** Counts, digests and chain head against the manifest; `full` digests every table but kv_state (the world's stamp). */
  verify(storage: DurableStorageLike, a: SnapshotArtifacts, opts: { full: boolean }): VerifyResult;
  /** True when no domain row was written since the last reset (no dirty key outside kv_state, which is never tracked). */
  isClean(storage: DurableStorageLike): boolean;
  deltaReset(storage: DurableStorageLike, a: SnapshotArtifacts): DeltaResetResult;
  /** The design 11.3 conformance cases on this object's storage (the deployed `conformance` scratch object); `deliver`
   * sends a case's second event to the same object (an RPC to itself, which waits for the input gate). */
  conformance?(storage: DurableStorageLike, opts?: { deliver?(name: string): Promise<unknown> }): Promise<{ passed: number; failed: number; skipped?: number; cases: { name: string; ok: boolean; skipped?: boolean; detail?: string }[] }>;
  /** One second-event body of the conformance cases, run on this storage. */
  conformanceSub?(storage: DurableStorageLike, name: string): Promise<unknown>;
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
