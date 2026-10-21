// SpendDO "spend" (design 3.1, 4.3 and 6.3): the one ledger every world reserves against, so the day, visitor, IP-hash
// and neuron caps hold across slots. Strongly consistent (one object, synchronous SQL); the Rate Limiting binding
// and the gateway spend rule are only coarse backstops. Never evaluates @weft/*. Caps are read from KV weft-config
// (memoized 60 s) at every RPC, so they change without a redeploy.
import { DurableObject } from "cloudflare:workers";
import type { HostedCaps, HostedReserveInput, HostedSpendScope, HostedSpendStatus, NeuronProduct } from "../../shared/contracts";
import { capsFrom, envConfig } from "../../shared/config";
import type { CoreEnv } from "../../shared/env";
import { createSqlSpendLedger, migrateSpend, type ReserveResult, type SpendRow, type SqlSpendLedger, type Totals } from "./ledger";

export class SpendDO extends DurableObject<CoreEnv> {
  private ledger: SqlSpendLedger;
  private caps: HostedCaps;

  constructor(ctx: DurableObjectState, env: CoreEnv) {
    super(ctx, env);
    const storage = ctx.storage;
    migrateSpend({ sql: storage.sql, transactionSync: (fn) => storage.transactionSync(fn) });
    this.caps = capsFrom(new Map(), env);
    this.ledger = createSqlSpendLedger({ sql: storage.sql, transactionSync: (fn) => storage.transactionSync(fn) }, { caps: () => this.caps });
  }

  /** Refreshes the caps from KV (memoized per isolate) before a call that checks them. */
  private async fresh(): Promise<void> {
    this.caps = capsFrom(await envConfig(this.env), this.env);
  }

  async reserve(input: HostedReserveInput): Promise<ReserveResult> {
    await this.fresh();
    return this.ledger.reserve(input);
  }
  async settle(reservationId: string, actualUsdMicros: number, actual?: { neurons?: number }): Promise<void> {
    this.ledger.settle(reservationId, actualUsdMicros, actual);
  }
  async release(reservationId: string): Promise<void> {
    this.ledger.release(reservationId);
  }
  async spent(scope: HostedSpendScope): Promise<number> {
    return this.ledger.spent(scope);
  }
  async committed(scope: HostedSpendScope): Promise<Totals> {
    return this.ledger.committed(scope);
  }
  async status(scope: { visitor?: string | null; ipHash?: string | null }): Promise<HostedSpendStatus> {
    await this.fresh();
    return this.ledger.status(scope);
  }
  async settleOrphans(nowIso?: string): Promise<number> {
    return this.ledger.settleOrphans(nowIso ? new Date(nowIso) : undefined);
  }
  async recordNeurons(input: { product: NeuronProduct; model: string; neurons: number }): Promise<void> {
    this.ledger.recordNeurons(input);
  }
  async neuronsLeft(product: NeuronProduct): Promise<{ product: number; day: number }> {
    await this.fresh();
    return this.ledger.neuronsLeft(product);
  }
  async entries(day?: string): Promise<SpendRow[]> {
    return this.ledger.entries(day);
  }

  override async fetch(): Promise<Response> {
    return new Response("SpendDO answers RPC only", { status: 404 });
  }
}
