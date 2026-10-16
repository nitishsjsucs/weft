// @weft/integrations (docs/wave3.md): real vendor adapters, mode selection, secrets presence and webhook signatures.
// The only package that makes outbound HTTP calls to vendors. packages/agent and packages/routines never import it
// (tests/boundaries.test.ts); apps/api/src/compose.ts passes createVendorOverlay() to createSimulators.
import { INTEGRATION_OPTIONAL_SECRETS, INTEGRATION_SECRETS, IntegrationVendor, type ConnectorMode, type VendorConnectors } from "@weft/contracts";
import { integrationMode } from "./mode";
import { secretPresence, type Env } from "./secrets";
import { createRealGreenhouse } from "./real/greenhouse";
import { createRealWorkday } from "./real/workday";
import { createRealCheckr } from "./real/checkr";
import { createRealHireright } from "./real/hireright";
import { createRealDocusign } from "./real/docusign";

export { LiveIntegrationInTest, configured, integrationMode, isTestEnv } from "./mode";
export { readSecret, secretPresence, type Env } from "./secrets";
export { constantTimeEqual, hmacSha256 } from "./webhook";
export { VENDOR_COPY, type VendorCopy } from "./cards";

/** Mode per vendor, for the Integrations screen and GET /v1/health. */
export function integrationModes(env: Env, opts: { testMode?: boolean } = {}): Record<IntegrationVendor, ConnectorMode> {
  return Object.fromEntries(IntegrationVendor.options.map((v) => [v, integrationMode(v, env, opts)])) as Record<IntegrationVendor, ConnectorMode>;
}

/** Secret names per vendor with present or missing; never a value. */
export function secretsReport(vendor: IntegrationVendor, env: Env): { name: string; present: boolean; optional: boolean }[] {
  const req = secretPresence(INTEGRATION_SECRETS[vendor], env), opt = secretPresence(INTEGRATION_OPTIONAL_SECRETS[vendor], env);
  return [...Object.entries(req).map(([name, present]) => ({ name, present, optional: false })), ...Object.entries(opt).map(([name, present]) => ({ name, present, optional: true }))];
}

/** Overlay for createSimulators({ vendors }): swaps in a real adapter only for vendors whose mode is real. */
export function createVendorOverlay(env: Env, opts: { testMode?: boolean } = {}): (simulated: VendorConnectors) => VendorConnectors {
  const modes = integrationModes(env, opts);
  return (sim) => ({
    greenhouse: (modes.greenhouse === "real" ? createRealGreenhouse(env, sim.greenhouse) : null) ?? sim.greenhouse,
    workday: (modes.workday === "real" ? createRealWorkday(env, sim.workday) : null) ?? sim.workday,
    checkr: (modes.checkr === "real" ? createRealCheckr(env, sim.checkr) : null) ?? sim.checkr,
    hireright: (modes.hireright === "real" ? createRealHireright(env, sim.hireright) : null) ?? sim.hireright,
    docusign: (modes.docusign === "real" ? createRealDocusign(env, sim.docusign) : null) ?? sim.docusign,
  });
}
export { fetchBoardJobs, parseBoardJobs, boardUrl, type BoardJob, type BoardMetadata } from "./board";
