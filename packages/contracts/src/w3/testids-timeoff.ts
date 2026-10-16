// Wave 3 E2E test ids for w3-timeoff (docs/wave3.md). Owner: w3-timeoff. Add entries here only; e2e specs import them from @weft/contracts.
export const W3_TIMEOFF_TID = {
  tab: (tab: string) => `time-off-tab-${tab}`,
  requestRow: (id: string) => `time-off-request-${id}`,
  check: (rule: string) => `time-off-check-${rule}`,
  decide: (decision: string) => `time-off-decide-${decision}`,
  calendar: "time-off-calendar",
  calendarDay: (date: string) => `time-off-day-${date}`,
  balance: (workerId: string, policyId: string) => `time-off-balance-${workerId}-${policyId}`,
  submit: "time-off-submit",
} as const;
