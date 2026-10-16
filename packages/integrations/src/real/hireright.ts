// Real hireright adapter (docs/wave3.md). Owner: w3-integrations-screening-esign. Built against nothing: HireRight publishes no API, so this always refuses with INTEGRATION_NOT_AVAILABLE.
// The only code in Weft that calls this vendor over HTTP. Credentials come from ./secrets readSecret, never logged.
// Scaffold stub: returns null, so the simulator stays in place until the owning track implements it.
import type { ScreeningConnector } from "@weft/contracts";
import type { Env } from "../secrets";

export function createRealHireright(_env: Env, _simulated: ScreeningConnector): ScreeningConnector | null {
  return null;
}
