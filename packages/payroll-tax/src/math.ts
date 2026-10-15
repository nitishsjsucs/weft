// Exact decimal helpers. Every amount is integer cents; rate math runs in decimal.js and rounds half up once per line.
import Decimal from "decimal.js";

export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;

export const dec = (v: number | string | Dec): Dec => new D(v);
/** Rounds a cents decimal to integer cents, half up (SPEC 0 rule 9). */
export function roundCents(v: Dec): number {
  const n = v.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
  return Object.is(n, -0) ? 0 : n;
}
export const maxCents = (a: number, b: number) => (a > b ? a : b);
export const minCents = (a: number, b: number) => (a < b ? a : b);

/** 123456 -> "1,234.56" (no currency symbol), used by trace lines. */
export function fmt(cents: number | Dec): string {
  const d = typeof cents === "number" ? new D(cents) : cents;
  const neg = d.isNegative();
  const abs = d.abs().dividedBy(100);
  const fixed = abs.toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
  let [whole, frac = ""] = fixed.toFixed().split(".");
  frac = frac.padEnd(2, "0");
  whole = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
export const pct = (rate: string) => `${new D(rate).times(100).toFixed()}%`;

/** Remaining room under an annual wage base given YTD wages: min(wages, max(0, base - ytd)). */
export function underBase(wagesCents: number, ytdCents: number, baseCents: number | null): number {
  if (baseCents === null) return wagesCents;
  return minCents(wagesCents, maxCents(0, baseCents - ytdCents));
}

/** Annual bracket lookup: the last row whose threshold is at or below the amount. */
export function bracketTax(amountCents: Dec, table: { atLeastCents: number; baseCents: number; rate: string }[]): { tax: Dec; row: { atLeastCents: number; baseCents: number; rate: string } } {
  let row = table[0]!;
  for (const r of table) if (amountCents.greaterThanOrEqualTo(r.atLeastCents)) row = r;
  const tax = new D(row.baseCents).plus(amountCents.minus(row.atLeastCents).times(row.rate));
  return { tax, row };
}
