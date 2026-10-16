// Simulated Workday (hris) for wave 3 (docs/wave3.md). Owner: w3-integrations-hr. Follows the vendor's published API shapes; writes only
// sim_vendor_records and sim_webhook_outbox, reads the sim clock and checks the fault injector before each call. Scaffold stub:
// status() answers; every other method throws NotImplemented until the owning track fills it in.
import { NotImplemented, type HrisConnector, type ConnectorStatus, type FaultInjector, type SimClock } from "@weft/contracts";
import type { DbTx } from "@weft/db";

export function createWorkdaySim(_db: DbTx, clock: SimClock, _faults: FaultInjector): HrisConnector {
  const todo = (m: string) => { throw new NotImplemented(`workday simulator ${m} (w3-integrations-hr)`); };
  return {
    async status(): Promise<ConnectorStatus> { void clock; return { vendor: "workday", category: "hris", mode: "simulated", configured: false, lastSyncAt: null, cursor: null, health: "ok", detail: null }; },
    async testConnection() { return todo("testConnection"); },
    async listChangedWorkers() { return todo("listChangedWorkers"); },
    async listOrganizations() { return todo("listOrganizations"); },
    async listTimeOff() { return todo("listTimeOff"); },
    async listBalances() { return todo("listBalances"); },
    async requestTimeOff() { return todo("requestTimeOff"); },
  };
}
