// Internal state shared by the executor modules. Never exported to the brain.
import type { MemoryStore, ProposalDecided, SimClock, Simulators } from "@weft/contracts";
import type { Db, DbTx } from "@weft/db";
import type { Registry } from "./registry";
import type { Redactor } from "./vault/redact";
import type { Vault } from "./vault/vault";

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
}
