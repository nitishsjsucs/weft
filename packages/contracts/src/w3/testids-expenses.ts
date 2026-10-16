// Wave 3 E2E test ids for w3-expenses (docs/wave3.md). Owner: w3-expenses. Add entries here only; e2e specs import them from @weft/contracts.
export const W3_EXPENSES_TID = {
  band: (band: string) => `expenses-band-${band}`,
  table: "expenses-table",
  row: (id: string) => `expense-row-${id}`,
  drawer: "expense-drawer",
  check: (rule: string) => `expense-check-${rule}`,
  decide: (decision: string) => `expense-decide-${decision}`,
  submit: "expense-submit",
} as const;
