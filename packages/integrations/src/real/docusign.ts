// Real docusign adapter (docs/wave3.md). Owner: w3-integrations-screening-esign. Built against eSignature REST v2.1 (JWT grant, embedded signing, Connect HMAC) behind WEFT_ESIGN=docusign and WEFT_LIVE_DOCUSIGN=1.
// The only code in Weft that calls this vendor over HTTP. Credentials come from ./secrets readSecret, never logged.
// Scaffold stub: returns null, so the simulator stays in place until the owning track implements it.
import type { ESignConnector } from "@weft/contracts";
import type { Env } from "../secrets";

export function createRealDocusign(_env: Env, _simulated: ESignConnector): ESignConnector | null {
  return null;
}
