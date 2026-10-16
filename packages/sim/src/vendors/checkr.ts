// Simulated Checkr (screening) for wave 3 (docs/wave3.md). Owner: w3-integrations-screening-esign. Follows the vendor's published API shapes; writes only
// sim_vendor_records and sim_webhook_outbox, reads the sim clock and checks the fault injector before each call. Scaffold stub:
// status() answers; every other method throws NotImplemented until the owning track fills it in.
import { NotImplemented, type ScreeningConnector, type ConnectorStatus, type FaultInjector, type SimClock } from "@weft/contracts";
import type { DbTx } from "@weft/db";

export function createCheckrSim(_db: DbTx, clock: SimClock, _faults: FaultInjector): ScreeningConnector {
  const todo = (m: string) => { throw new NotImplemented(`checkr simulator ${m} (w3-integrations-screening-esign)`); };
  return {
    async status(): Promise<ConnectorStatus> { void clock; return { vendor: "checkr", category: "screening", mode: "simulated", configured: false, lastSyncAt: null, cursor: null, health: "ok", detail: null }; },
    async listPackages() { return todo("listPackages"); },
    async createOrder() { return todo("createOrder"); },
    async getOrder() { return todo("getOrder"); },
    async cancelOrder() { return todo("cancelOrder"); },
    async listAdverseItems() { return todo("listAdverseItems"); },
    async startPreAdverse() { return todo("startPreAdverse"); },
    async cancelAdverse() { return todo("cancelAdverse"); },
    verifyWebhook() { return todo("verifyWebhook"); },
    parseWebhook() { return todo("parseWebhook"); },
  };
}
