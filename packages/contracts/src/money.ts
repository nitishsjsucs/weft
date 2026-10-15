import { z } from "zod";
// Money is integer cents everywhere (SPEC 0 rule 9). Rates are decimal strings.
export const Currency = z.enum(["USD", "EUR", "INR", "CAD"]);
export type Currency = z.infer<typeof Currency>;
/** API money shape (SPEC 10): `{ amount, currency, display }`, amount in minor units. */
export const Money = z.object({ amount: z.number().int(), currency: Currency, display: z.string() });
export type Money = z.infer<typeof Money>;
export const Rate = z.string().regex(/^\d+(\.\d+)?$/, "decimal string such as 0.034");
export type Rate = z.infer<typeof Rate>;

const SYMBOL: Record<Currency, string> = { USD: "$", EUR: "EUR ", INR: "INR ", CAD: "CAD " };

/** 123456 -> "$1,234.56"; -500 -> "-$5.00". Integer arithmetic only. */
export function formatCents(cents: number, currency: Currency = "USD"): string {
  if (!Number.isInteger(cents)) throw new Error(`formatCents: not an integer: ${cents}`);
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}${SYMBOL[currency]}${whole}.${frac}`;
}

export function money(amount: number, currency: Currency = "USD"): Money {
  return { amount, currency, display: formatCents(amount, currency) };
}
