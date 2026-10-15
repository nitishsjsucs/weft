// Cost accounting (harness 10). Only the three prices given for Luna; WEFT_PRICES_JSON overrides them.
import type { Usage } from "@weft/contracts";

export interface Prices { inPerM: number; cachedPerM: number; outPerM: number }
export const LUNA: Prices = { inPerM: 0.2, cachedPerM: 0.02, outPerM: 1.2 } as const;

export function pricesFromEnv(env: Record<string, string | undefined>): Prices {
  const raw = env.WEFT_PRICES_JSON;
  if (!raw) return LUNA;
  try {
    const p = JSON.parse(raw) as Partial<Prices>;
    return { inPerM: Number(p.inPerM ?? LUNA.inPerM), cachedPerM: Number(p.cachedPerM ?? LUNA.cachedPerM), outPerM: Number(p.outPerM ?? LUNA.outPerM) };
  } catch {
    return LUNA;
  }
}

/** USD for one model attempt. cacheWrite is recorded but priced at 0 (smoke call 4 decides). */
export function stepCostUsd(u: Usage, p: Prices = LUNA): number {
  return ((u.input - u.cached) * p.inPerM + u.cached * p.cachedPerM + u.output * p.outPerM) / 1e6;
}

export function usdToMicros(usd: number): number {
  return Math.ceil(usd * 1e6);
}

/** Worst case for one attempt: every input token uncached and the full output budget spent. */
export function reserveUsd(estimatedInputTokens: number, maxOutputTokens: number, p: Prices = LUNA): number {
  return (estimatedInputTokens * p.inPerM + maxOutputTokens * p.outPerM) / 1e6;
}

export const ZERO_USAGE: Usage = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, cached: a.cached + b.cached, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output, reasoning: a.reasoning + b.reasoning };
}
