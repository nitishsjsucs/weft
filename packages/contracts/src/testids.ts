// E2E test ids (SPEC 11.4). Static ids are constants; parameterized ids are functions.
export const TID = {
  cmdkInput: "cmdk-input", viewingAs: "viewing-as", simClock: "sim-clock", providerBadge: "provider-badge",
  agentComposer: "agent-composer", agentSend: "agent-send", agentStep: "agent-step", agentStatus: "agent-status", agentAnswer: "agent-answer",
  inboxApprove: "inbox-approve", inboxDeny: "inbox-deny", inboxTaintedBanner: "inbox-tainted-banner",
  proposalDiff: "proposal-diff", proposalContent: "proposal-content",
  payrollGroupNeedsReview: "payroll-group-needs-review", payrollGroupReady: "payroll-group-ready",
  payrollSubmit: "payroll-submit", payrollRunReview: "payroll-run-review", payrollPreview: "payroll-preview",
  payrollNewDraft: "payroll-new-draft", payrollStatus: "payroll-status", payrollTotals: "payroll-totals",
  noticeStatus: "notice-status", routineRunRow: "routine-run-row", routineRunNow: "routine-run-now",
  routineDraftInput: "routine-draft-input", routineDraftSubmit: "routine-draft-submit", runStep: "run-step",
  auditChainStatus: "audit-chain-status",
} as const;

export const tid = {
  nav: (slug: string) => `nav-${slug}`,
  inboxCard: (proposalId: string) => `inbox-card-${proposalId}`,
  payrollRow: (workerId: string) => `payroll-row-${workerId}`,
  payrollFlag: (workerId: string, rule: string) => `payroll-flag-${workerId}-${rule}`,
  noticeRow: (noticeId: string) => `notice-row-${noticeId}`,
  registrationRow: (state: string) => `registration-row-${state}`,
  rateRow: (jurisdiction: string, code: string) => `rate-row-${jurisdiction}-${code}`,
  routineCard: (routineId: string) => `routine-card-${routineId}`,
  auditRow: (seq: number) => `audit-row-${seq}`,
  auditUndo: (seq: number) => `audit-undo-${seq}`,
  simDeliver: (scenario: string) => `sim-deliver-${scenario}`,
  simAdvance: (step: string) => `sim-advance-${step}`,
  simFault: (target: string) => `sim-fault-${target}`,
  chatChannel: (name: string) => `chat-channel-${name}`,
  offerAccept: (offerId: string) => `offer-accept-${offerId}`,
  onboardingTask: (kind: string) => `onboarding-task-${kind}`,
} as const;
