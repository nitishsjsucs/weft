// Shared Hono types for apps/api. `Weft` is what createWeft() returns.
import type { Hono } from "hono";
import type { AgentRuntime, ExecutorBundle, HumanSession, ModelProvider, RoutinesEngine, Scheduler, SimClock, Simulators, SpendLedger } from "@weft/contracts";
import type { Db } from "@weft/db";
import type { SqlMeter, TxGuard } from "../../../../packages/contracts/src/ext/cf-db";
import type { BlobStore, FixtureSource, PlatformKind, RunFileStore, SmallState } from "../../../../packages/contracts/src/ext/cf-platform";
import type { HostedWorldRef } from "../../../../packages/contracts/src/ext/cf-hosted";

export interface Weft {
  app: Hono<WeftEnv>;
  db: Db;
  dataDir: string;
  executor: ExecutorBundle;
  sims: Simulators;
  agent: AgentRuntime;
  routines: RoutinesEngine;
  scheduler: Scheduler;
  clock: SimClock;
  ledger: SpendLedger;
  provider: ModelProvider;
  proxySecret: string;
  testMode: boolean;
  ports: { api: number; web: number };
  /** Parts still answering NotImplemented (scaffold stubs). Empty once every track has landed. */
  stubs: string[];
  /** Uploads: files under dataDir on Node, the blobs table with WEFT_BLOBS=sqlite and on the durable platform. */
  blobs: BlobStore;
  /** Run artifact and code bodies: files on Node, the run_files table on the durable platform. */
  runFiles: RunFileStore;
  /** The platform this world runs on (docs/cloudflare/design.md 3.3). */
  platform: WeftPlatformInfo;
  close(): Promise<void>;
}

/** What routes and the hosted layer need to know about the platform. */
export interface WeftPlatformInfo {
  kind: PlatformKind;
  /** process.env on Node; the Worker vars and secrets on the durable platform. */
  env: Readonly<Record<string, string | undefined>>;
  /** The hosted world (slot, generation, mode); null on Node. */
  world: HostedWorldRef | null;
  /** The showcase: every mutation is refused (kv_state world.readonly can also set it). */
  readOnly: boolean;
  /** The only allowed host and mutation origin on hosted (WEFT_PUBLIC_ORIGIN); null on Node, which allows its ports. */
  publicOrigin: string | null;
  /** The facade meter and IO_IN_TX guard on the durable platform; null on Node. */
  meter: SqlMeter | null;
  guard: TxGuard | null;
  state: SmallState;
  fixtures: FixtureSource;
  /**
   * The hosted reset (design 4.6 and 6.2): the durable platform resets its storage (delta reset or full restore) and
   * returns the new generation; the seed generator never runs in a Worker. Null on Node, which reseeds.
   */
  reset: HostedResetHook | null;
}

export type HostedResetHook = (input: { profile: "rich" }) => Promise<{ gen: number }>;

export interface WeftEnv { Variables: { weft: Weft; session: HumanSession | null } }
