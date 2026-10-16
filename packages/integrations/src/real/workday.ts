// Real workday adapter (docs/wave3.md). Owner: w3-integrations-hr. Built against SOAP Get_Workers with the updated window and REST absenceManagement v5.
// The only code in Weft that calls this vendor over HTTP. Credentials come from ./secrets readSecret, never logged.
// Scaffold stub: returns null, so the simulator stays in place until the owning track implements it.
import type { HrisConnector } from "@weft/contracts";
import type { Env } from "../secrets";

export function createRealWorkday(_env: Env, _simulated: HrisConnector): HrisConnector | null {
  return null;
}
