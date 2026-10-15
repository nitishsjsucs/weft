// Shared Hono types for apps/api. `Weft` is what createWeft() returns.
import type { Hono } from "hono";
import type { AgentRuntime, ExecutorBundle, HumanSession, ModelProvider, RoutinesEngine, Scheduler, SimClock, Simulators, SpendLedger } from "@weft/contracts";
import type { Db } from "@weft/db";

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
  close(): Promise<void>;
}

export interface WeftEnv { Variables: { weft: Weft; session: HumanSession | null } }
