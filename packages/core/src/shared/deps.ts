// SPEC 9.0 amendment 1: the third argument of every command's amountCents, preview and run.
// The executor builds it inside its transaction; the brain never sees it.
import type { CommandDef, IdPrefix, SimClock, Simulators } from "@weft/contracts";
import type { DbTx } from "@weft/db";

export interface CommandDeps {
  tx: DbTx;                                        // the executor's open transaction (from @weft/db)
  sims: Simulators;                                // createSimulators({ db: tx, clock })
  resolveCredential(ref: `vault:${string}`): Promise<string>;   // in-memory only, never persisted or returned
  clock: SimClock;
  newId(prefix: IdPrefix): Promise<string>;        // counter table, inside tx
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WeftCommand<I = any, O = any> = CommandDef<I, O, CommandDeps>;
