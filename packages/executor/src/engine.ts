// Internal state shared by the executor modules. Never exported to the brain.
import type { MemoryStore, ProposalDecided, SimClock, Simulators } from "@weft/contracts";
import type { Db, DbTx } from "@weft/db";
import type { Registry } from "./registry";
import type { Redactor } from "./vault/redact";
import type { Vault } from "./vault/vault";
import type { RunFileStore } from "./hosted/run-files";
import type { OutboxWorld } from "./hosted/outbox";
import type { TxGuard } from "../../contracts/src/ext/cf-db";

export type SimulatorsFactory = (opts: { db: DbTx; clock: SimClock }) => Simulators;

export interface BatchState { blocked: boolean; pending: boolean }

export interface Engine {
  db: Db;
  clock: SimClock;
  dataDir: string;
  testMode: boolean;
  registry: Registry;
  redactor: Redactor;
  vault: Vault;
  simulators: SimulatorsFactory;
  memory: MemoryStore;
  decided: ((p: ProposalDecided) => Promise<void>)[];
  /** Batch rule state per run and batch key (harness 4.6). */
  batches: Map<string, BatchState>;
  /** Latest batch key seen per run, so a new key resets the run's batch state. */
  lastBatch: Map<string, string>;
  log: (line: string) => void;
  /** Chain head last written to the memory timeline, for gitLag. */
  gitHeadSeq: number | null;
  /** Run artifact and sandbox code bodies: files under dataDir on Node, the run_files table on the durable platform. */
  runFiles: RunFileStore;
  /** The environment this world reads: process.env on Node; Worker vars and secrets only on the durable platform. */
  env: Readonly<Record<string, string | undefined>>;
  /** Weft on Cloudflare (docs/cloudflare/design.md 3.4, 4.2 and 4.4). Every field is off on Node. */
  hosted: EngineHosted;
}

export interface EngineHosted {
  /** Reads outside a run return `res_e_` ids and write no rows (design 4.4). */
  ephemeralReadIds: boolean;
  /** The world the after-commit outbox writer stamps on each job; null when the platform has no outbox (Node). */
  outbox: OutboxWorld | null;
  /** Called after an outer commit that appended outbox rows: the slot sends them to their queues and deletes them. */
  onOutbox: (() => void) | null;
  /** Set when a command appended an outbox row; afterCommit clears it and calls onOutbox. */
  outboxPending: boolean;
  /** The facade's IO_IN_TX guard; null on Node. */
  guard: TxGuard | null;
  /** System principals this platform adds beside the frozen four (svc_jobs on the durable platform), each with its exact allowlist. */
  systemAllowlists: ReadonlyMap<string, readonly string[]>;
}

/** Node: every hosted option off. Frozen, so nothing can switch one on for every Node world at once. */
export const NODE_HOSTED: EngineHosted = Object.freeze({ ephemeralReadIds: false, outbox: null, onOutbox: null, outboxPending: false, guard: null, systemAllowlists: new Map<string, readonly string[]>() });
