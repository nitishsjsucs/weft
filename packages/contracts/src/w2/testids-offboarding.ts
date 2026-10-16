// Wave 2 E2E test ids for w2-offboarding (docs/wave2.md). Owner: w2-offboarding. Add entries here only; e2e specs import them from @weft/contracts.
export const W2_OFFBOARDING_TID = {
  personTerminate: "person-terminate", personCaseLink: "person-offboarding-case",
  terminateKind: "terminate-kind", terminateLastDay: "terminate-last-day", terminateNote: "terminate-note", terminatePto: "terminate-pto",
  terminateSubmit: "terminate-submit", terminateError: "terminate-error",
  personOffCycle: "person-off-cycle", offCyclePeriodStart: "off-cycle-period-start", offCyclePeriodEnd: "off-cycle-period-end",
  offCyclePayday: "off-cycle-payday", offCycleReason: "off-cycle-reason", offCycleBonus: "off-cycle-bonus", offCycleSubmit: "off-cycle-submit",
  skipReason: "offboarding-skip-reason", skipConfirm: "offboarding-skip-confirm",
  caseStatus: "offboarding-case-status", caseSteps: "offboarding-case-steps", runRemaining: "offboarding-run-remaining", caseList: "offboarding-case-list",
} as const;

/** Parameterized w2-offboarding test ids. */
export const w2OffboardingTid = {
  caseRow: (caseId: string) => `offboarding-case-${caseId}`,
  step: (kind: string) => `offboarding-step-${kind}`,
  stepStatus: (kind: string) => `offboarding-step-status-${kind}`,
  stepProposal: (kind: string) => `offboarding-step-proposal-${kind}`,
  stepRunNow: (kind: string) => `offboarding-step-run-now-${kind}`,
  stepSkip: (kind: string) => `offboarding-step-skip-${kind}`,
};
