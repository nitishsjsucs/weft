// Real hireright adapter (docs/wave3.md). Owner: w3-integrations-screening-esign. Built against nothing: HireRight publishes no API, so this always refuses with INTEGRATION_NOT_AVAILABLE.
// The only code in Weft that calls this vendor over HTTP. Credentials come from ./secrets readSecret, never logged.
// Live access needs a HireRight customer contract and an assigned technical consultant; until then every call refuses and
// the simulator (labeled "Sandbox, API shape not published") stays in place.
import type { ConnectorStatus, ScreeningConnector, WebhookVerdict } from "@weft/contracts";
import type { Env } from "../secrets";
import { IntegrationRefused } from "./checkr";

const refuse = (): never => { throw new IntegrationRefused("INTEGRATION_NOT_AVAILABLE", "HireRight publishes no public API; access comes with a customer contract and a technical consultant"); };

export function createHireRightRefusal(): ScreeningConnector {
  return {
    async status(): Promise<ConnectorStatus> { return { vendor: "hireright", category: "screening", mode: "real", configured: false, lastSyncAt: null, cursor: null, health: "not_available", detail: "INTEGRATION_NOT_AVAILABLE" }; },
    async listPackages() { return refuse(); }, async createOrder() { return refuse(); }, async getOrder() { return refuse(); }, async cancelOrder() { return refuse(); },
    async listAdverseItems() { return refuse(); }, async startPreAdverse() { return refuse(); }, async cancelAdverse() { return refuse(); },
    verifyWebhook(): WebhookVerdict { return { ok: false, dedupeKey: null }; },
    parseWebhook() { return []; },
  };
}

export function createRealHireright(_env: Env, _simulated: ScreeningConnector): ScreeningConnector | null {
  return createHireRightRefusal();
}
