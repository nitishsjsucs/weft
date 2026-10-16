// Wave 2 E2E test ids for w2-onboarding (docs/wave2.md). Owner: w2-onboarding. Add entries here only; e2e specs import them from @weft/contracts.
// The additive w2-onboarding contracts ride along here because the frozen index exports this file.
export * from "../ext/w2-onboarding";

export const W2_ONBOARDING_TID = {
  hiringPage: "hiring-page",
  offerForm: "offer-form",
  offerFirst: "offer-first", offerLast: "offer-last", offerEmail: "offer-email", offerTitle: "offer-title",
  offerDepartment: "offer-department", offerManager: "offer-manager", offerState: "offer-state", offerBase: "offer-base", offerStart: "offer-start",
  offerSaveDraft: "offer-save-draft",
  offerRow: "offer-row", offerStatus: "offer-status", offerSend: "offer-send", offerVoid: "offer-void", offerPortalLink: "offer-portal-link",
  outbox: "sim-outbox", outboxItem: "sim-outbox-item",
  portalPage: "portal-page", portalCounter: "portal-counter", portalTask: "portal-task", portalError: "portal-error",
  docBody: "portal-doc-body", typedName: "portal-typed-name", signButton: "portal-sign",
  w4Filing: "w4-filing", w4Step2: "w4-step2", w4Step3: "w4-step3", w4Step4c: "w4-step4c", w4Submit: "w4-submit",
  stateFiling: "state-filing", stateAllowances: "state-allowances", stateSubmit: "state-submit",
  ddBank: "dd-bank", ddRouting: "dd-routing", ddAccount: "dd-account", ddSubmit: "dd-submit", ddError: "dd-error",
  i9Citizenship: "i9-citizenship", i9DocKind: "i9-doc-kind", i9Last4: "i9-last4", i9File: "i9-file", i9Submit: "i9-submit", i9Masked: "i9-masked",
  benefitsPlan: "benefits-plan", benefitsSubmit: "benefits-submit",
  portalDone: "portal-done",
  docLibrary: "doc-library", docTab: "doc-tab", docRow: "doc-row",
} as const;
