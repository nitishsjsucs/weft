// Real checkr adapter (docs/wave3.md). Owner: w3-integrations-screening-esign. Built against the published Checkr API; refuses production unless WEFT_LIVE_CHECKR=1, never run live in wave 3.
// The only code in Weft that calls this vendor over HTTP. Credentials come from ./secrets readSecret, never logged.
// Scaffold stub: returns null, so the simulator stays in place until the owning track implements it.
import type { ScreeningConnector } from "@weft/contracts";
import type { Env } from "../secrets";

export function createRealCheckr(_env: Env, _simulated: ScreeningConnector): ScreeningConnector | null {
  return null;
}
