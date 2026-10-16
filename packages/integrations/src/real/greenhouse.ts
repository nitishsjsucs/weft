// Real greenhouse adapter (docs/wave3.md). Owner: w3-integrations-hr. Built against Harvest v3 (OAuth client credentials, cursor paging) and the public job board.
// The only code in Weft that calls this vendor over HTTP. Credentials come from ./secrets readSecret, never logged.
// Scaffold stub: returns null, so the simulator stays in place until the owning track implements it.
import type { AtsConnector } from "@weft/contracts";
import type { Env } from "../secrets";

export function createRealGreenhouse(_env: Env, _simulated: AtsConnector): AtsConnector | null {
  return null;
}
