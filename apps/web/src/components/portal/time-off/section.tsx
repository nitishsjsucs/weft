// Portal section slot (wave 3, docs/wave3.md). Owner: w3-timeoff. Intentionally empty: the portal's Request time off
// section (balances, the request form and the person's own requests, from GET /v1/portal/time-off) is in
// components/portal/w4-people.tsx, which wave 4 (w4-parity-people) built in this slot's place. Keep one, not two.
export function TimeOffPortalSection(_props: { workerId: string; principal: string }) {
  return null;
}
