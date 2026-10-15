// The hands (SPEC 9.3, harness 5 and 6). Owner: t3-governance.
import { NotImplemented, type ExecutorBundle, type SandboxEngine, type SimClock, type Simulators } from "@weft/contracts";
import type { Db, DbTx } from "@weft/db";
import type { WeftCommand } from "@weft/core";

export type SimulatorsFactory = (opts: { db: DbTx; clock: SimClock }) => Simulators;

export interface CreateExecutorOptions {
  db: Db;
  clock: SimClock;
  dataDir: string;
  commands: WeftCommand[];
  simulators: SimulatorsFactory;
  testMode: boolean;
}

export async function createExecutor(_opts: CreateExecutorOptions): Promise<ExecutorBundle> {
  throw new NotImplemented("createExecutor (t3-governance)");
}

/**
 * P1 (SPEC 9.9, harness 3): code.run sandbox. Local engine is quickjs-emscripten inside the executor; the hosted
 * Cloudflare Workers Free twin keeps WEFT_SANDBOX=off; Dynamic Workers ("worker_loader") are the paid upgrade path
 * behind the same SandboxEngine contract. P0 ships only this stub.
 */
export function createSandbox(): SandboxEngine {
  throw new NotImplemented("createSandbox (P1, WEFT_SANDBOX=off)");
}
