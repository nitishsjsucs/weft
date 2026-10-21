// The SpendDO client a world's agent runtime receives (DurablePlatformInput.spend). It is the frozen SpendLedger plus
// the hosted calls, bound to the world ("slot-N:gen-G", read at every call so a reset starts a new world) and to the
// lease's visitor and IP hash, so background runs are charged to the visitor whose mutation started them (design
// 5.3). Every RPC first asserts it is not inside a database transaction (IO_IN_TX, design 4.2): a cross-object call
// inside a transaction would hold the slot's input gate, and a reservation must survive a company rollback anyway.
import type { HostedReserveInput, HostedSpendLedger, HostedSpendScope, NeuronProduct, TxGuard } from "../../shared/contracts";
import type { SpendDO } from "./spend-do";

export interface SpendBinding {
  stub(): DurableObjectStub<SpendDO>;
  /** "slot-N:gen-G" now. */
  world(): string;
  /** Who reservations are charged to: the lease's visitor and IP hash (null on slot-smoke and the showcase). */
  charge(): { visitor: string | null; ipHash: string | null };
  guard(): TxGuard | null;
}

export interface WorldSpendLedger extends HostedSpendLedger {
  recordNeurons(input: { product: NeuronProduct; model: string; neurons: number }): Promise<void>;
}

export function spendClient(b: SpendBinding): WorldSpendLedger {
  const call = <T>(what: string, fn: (s: DurableObjectStub<SpendDO>) => Promise<T>): Promise<T> => {
    b.guard()?.assertNotInTx(`SpendDO.${what}`);
    return fn(b.stub());
  };
  const withWorld = (scope: HostedSpendScope): HostedSpendScope => (scope.runId !== undefined && scope.world === undefined ? { ...scope, world: b.world() } : scope);
  return {
    async reserve(input: HostedReserveInput) {
      const who = b.charge();
      const full: HostedReserveInput = {
        ...input,
        world: input.world ?? b.world(),
        visitor: input.visitor !== undefined ? input.visitor : who.visitor,
        ipHash: input.ipHash !== undefined ? input.ipHash : who.ipHash,
      };
      return call("reserve", (s) => s.reserve(full) as ReturnType<HostedSpendLedger["reserve"]>);
    },
    settle: (id, usd, actual) => call("settle", (s) => s.settle(id, usd, actual)),
    release: (id) => call("release", (s) => s.release(id)),
    spent: (scope) => call("spent", (s) => s.spent(withWorld(scope))),
    status: (scope) => call("status", (s) => s.status(scope)),
    settleOrphans: (now) => call("settleOrphans", (s) => s.settleOrphans(now?.toISOString())),
    recordNeurons: (input) => call("recordNeurons", (s) => s.recordNeurons(input)),
  };
}
