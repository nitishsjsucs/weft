// Time-off amounts in the forms people ask for (wave 4 fix group read-figures). The ledger counts minutes, while a
// person asks how many hours or days are left, used or requested. Every agent read that returns a time-off amount
// adds its hours and its days as numbers (two decimals, a day is MINUTES_PER_DAY), so an answer can state either form
// and the grounding check finds the figure in the result instead of in the model's own arithmetic.
import { MINUTES_PER_DAY } from "@weft/contracts";
import { displayName } from "./store";

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Minutes as hours, two decimals: 3,293 minutes give 54.88. */
export const hoursOf = (minutes: number): number => round2(minutes / 60);
/** Minutes as working days of MINUTES_PER_DAY, two decimals: 3,293 minutes give 6.86. */
export const daysOf = (minutes: number): number => round2(minutes / MINUTES_PER_DAY);

/** `<name>_hours` and `<name>_days` for one minute amount. */
export function timeForms<N extends string>(name: N, minutes: number): Record<`${N}_hours` | `${N}_days`, number> {
  return { [`${name}_hours`]: hoursOf(minutes), [`${name}_days`]: daysOf(minutes) } as Record<`${N}_hours` | `${N}_days`, number>;
}

/** The hours and days of a balance's available, used and held minutes (the parts a person asks about). */
export function balanceForms(b: { availableMinutes: number; usedMinutes: number; holdsMinutes: number }) {
  return { ...timeForms("available", b.availableMinutes), ...timeForms("used", b.usedMinutes), ...timeForms("holds", b.holdsMinutes) };
}

/** A balance in minutes, hours and days. */
const balanceOfMinutes = (minutes: number) => ({ minutes, hours: hoursOf(minutes), days: daysOf(minutes) });

/**
 * A request's policy balance before and after it. `available` is today's available balance, which already nets out
 * every pending and approved request; `counted` is what this request holds or used (0 when denied or cancelled), so
 * the balance before it is available plus counted.
 */
export function requestBalance(available: number, counted: number) {
  return { balance_before_request: balanceOfMinutes(available + counted), balance_after_request: balanceOfMinutes(available) };
}

/** A minute total in every form: minutes, hours and days. */
export const minuteTotal = (minutes: number) => ({ requested_minutes: minutes, ...timeForms("requested", minutes) });

export const REQUEST_TOTALS_BY = ["worker", "policy"] as const;
export type RequestTotalsBy = (typeof REQUEST_TOTALS_BY)[number];

/**
 * Totals of time-off requests: `totals` over every row, then `by_worker` and `by_policy` when asked for, so "how many
 * days has each person asked for" is a field and never a sum the model adds up. Entries sort by minutes, largest
 * first, then by key.
 */
export function requestTotals(
  rows: readonly { workerId: string; policyId: string; requestedMinutes: number }[], by: readonly RequestTotalsBy[],
  names: (workerId: string) => string, policyName: (policyId: string) => string,
): Record<string, unknown> {
  const group = (key: (r: (typeof rows)[number]) => string) => {
    const m = new Map<string, { count: number; minutes: number }>();
    for (const r of rows) { const g = m.get(key(r)) ?? { count: 0, minutes: 0 }; g.count++; g.minutes += r.requestedMinutes; m.set(key(r), g); }
    return [...m.entries()].sort(([a, x], [b, y]) => y.minutes - x.minutes || (a < b ? -1 : a > b ? 1 : 0));
  };
  const out: Record<string, unknown> = { totals: { count: rows.length, ...minuteTotal(rows.reduce((s, r) => s + r.requestedMinutes, 0)) } };
  if (by.includes("worker")) out.by_worker = group((r) => r.workerId).map(([id, g]) => ({ worker: names(id), count: g.count, ...minuteTotal(g.minutes) }));
  if (by.includes("policy")) out.by_policy = group((r) => r.policyId).map(([id, g]) => ({ policy: policyName(id), count: g.count, ...minuteTotal(g.minutes) }));
  return out;
}

/** A worker name with its short id, as other reads show people: "Ruth Okoro (demo) (wrk_0010)". */
export const workerRef = (w: Parameters<typeof displayName>[0] & { id: string }) => `${displayName(w)} (${w.id})`;
