// Wave 3 E2E test ids for the Integrations screen (docs/wave3.md). w3-integrations-hr owns the screen; each vendor card uses card(vendor).
export const W3_INTEGRATIONS_TID = {
  list: "integrations-list",
  card: (vendor: string) => `integration-${vendor}`,
  mode: (vendor: string) => `integration-mode-${vendor}`,
  test: (vendor: string) => `integration-test-${vendor}`,
  simulate: (vendor: string, kind: string) => `integration-simulate-${vendor}-${kind}`,
  syncItems: "integration-sync-items",
  screeningStatus: (offerId: string) => `screening-status-${offerId}`,
} as const;
