// Simulated DocuSign (esign) for wave 3 (docs/wave3.md). Owner: w3-integrations-screening-esign. Follows the vendor's published API shapes; writes only
// sim_vendor_records and sim_webhook_outbox, reads the sim clock and checks the fault injector before each call. Scaffold stub:
// status() answers; every other method throws NotImplemented until the owning track fills it in.
import { NotImplemented, type ESignConnector, type ConnectorStatus, type FaultInjector, type SimClock } from "@weft/contracts";
import type { DbTx } from "@weft/db";

export function createDocuSignSim(_db: DbTx, clock: SimClock, _faults: FaultInjector): ESignConnector {
  const todo = (m: string) => { throw new NotImplemented(`docusign simulator ${m} (w3-integrations-screening-esign)`); };
  return {
    async status(): Promise<ConnectorStatus> { void clock; return { vendor: "docusign", category: "esign", mode: "simulated", configured: false, lastSyncAt: null, cursor: null, health: "ok", detail: null }; },
    async send() { return todo("send"); },
    async signingUrl() { return todo("signingUrl"); },
    async envelope() { return todo("envelope"); },
    async void() { return todo("void"); },
    async download() { return todo("download"); },
    verifyWebhook() { return todo("verifyWebhook"); },
    parseWebhook() { return todo("parseWebhook"); },
  };
}
