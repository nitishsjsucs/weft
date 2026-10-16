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

// w3-integrations-hr additions: screen sections and the sync item rows.
export const W3_INTEGRATIONS_HR_TID = {
  secret: (vendor: string, name: string) => `integration-secret-${vendor}-${name}`,
  health: (vendor: string) => `integration-health-${vendor}`,
  testResult: (vendor: string) => `integration-test-result-${vendor}`,
  syncItem: (id: string) => `sync-item-${id}`,
  syncResolve: (id: string, take: string) => `sync-item-resolve-${id}-${take}`,
  jobs: "integration-jobs",
  importedOffers: "integration-imported-offers",
  notice: "integration-notice",
} as const;
export * from "../ext/w3-integrations-hr";
