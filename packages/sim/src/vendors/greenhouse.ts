// Simulated Greenhouse (ats) for wave 3 (docs/wave3.md). Owner: w3-integrations-hr. Follows the vendor's published API shapes; writes only
// sim_vendor_records and sim_webhook_outbox, reads the sim clock and checks the fault injector before each call. Scaffold stub:
// status() answers; every other method throws NotImplemented until the owning track fills it in.
import { NotImplemented, type AtsConnector, type ConnectorStatus, type FaultInjector, type SimClock } from "@weft/contracts";
import type { DbTx } from "@weft/db";

export function createGreenhouseSim(_db: DbTx, clock: SimClock, _faults: FaultInjector): AtsConnector {
  const todo = (m: string) => { throw new NotImplemented(`greenhouse simulator ${m} (w3-integrations-hr)`); };
  return {
    async status(): Promise<ConnectorStatus> { void clock; return { vendor: "greenhouse", category: "ats", mode: "simulated", configured: false, lastSyncAt: null, cursor: null, health: "ok", detail: null }; },
    async testConnection() { return todo("testConnection"); },
    async listHires() { return todo("listHires"); },
    async getHire() { return todo("getHire"); },
    async listJobs() { return todo("listJobs"); },
    async markHired() { return todo("markHired"); },
    verifyWebhook() { return todo("verifyWebhook"); },
    parseWebhook() { return todo("parseWebhook"); },
  };
}
