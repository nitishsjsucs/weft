// Connector mode selection (docs/wave3.md). Real only when WEFT_INTEGRATIONS_REAL=1 and every required secret for that
// vendor resolves from WEFT_SECRETS_FILE; otherwise simulated. Tests can never run a real adapter.
import { INTEGRATION_SECRETS, type ConnectorMode, type IntegrationVendor } from "@weft/contracts";
import { secretPresence, type Env } from "./secrets";

export class LiveIntegrationInTest extends Error {
  readonly code = "LIVE_INTEGRATION_IN_TEST";
  constructor(vendor: IntegrationVendor) { super(`LIVE_INTEGRATION_IN_TEST: ${vendor} would run a real adapter inside a test`); }
}

export function isTestEnv(env: Env): boolean { return env.VITEST === "true" || env.NODE_ENV === "test" || env.WEFT_TEST_MODE === "1"; }

/** True when the vendor has a required secret list and every name is present. HireRight has none and is never configured. */
export function configured(vendor: IntegrationVendor, env: Env): boolean {
  const names = INTEGRATION_SECRETS[vendor];
  if (names.length === 0) return false;
  return Object.values(secretPresence(names, env)).every(Boolean);
}

export function integrationMode(vendor: IntegrationVendor, env: Env, opts: { testMode?: boolean } = {}): ConnectorMode {
  const wantsReal = env.WEFT_INTEGRATIONS_REAL === "1" && configured(vendor, env);
  if (!wantsReal) return "simulated";
  if (opts.testMode || isTestEnv(env)) throw new LiveIntegrationInTest(vendor);
  return "real";
}
