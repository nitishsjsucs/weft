// Fixed FX table for global contractor payments (P1 payouts). Synthetic: not market data, never updated.
import type { Currency } from "@weft/contracts";

export const FX_LABEL = "Synthetic FX table (fixed, not market data)";

/** USD per one unit of the currency, as a decimal string. */
export const FX_USD_PER_UNIT: Readonly<Record<Currency, string>> = {
  USD: "1",
  EUR: "1.08",
  CAD: "0.73",
  INR: "0.012",
};

/** Converts minor units of `currency` to USD cents, rounding half up, with integer math on the scaled rate. */
export function toUsdCents(amountMinor: number, currency: Currency): number {
  if (!Number.isInteger(amountMinor)) throw new Error(`toUsdCents: not an integer ${amountMinor}`);
  const rate = FX_USD_PER_UNIT[currency];
  const [i, f = ""] = rate.split(".");
  const scale = 10n ** BigInt(f.length);
  const scaled = BigInt(i + f);   // rate * scale
  const num = BigInt(amountMinor) * scaled;
  const q = num / scale, r = num % scale;
  return Number(r * 2n >= scale ? q + 1n : q);
}
