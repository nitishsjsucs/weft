// Cost accounting (harness 10). Prices per provider (USD per million tokens); WEFT_PRICES_JSON overrides them.
import type { ProviderId, Usage } from "@weft/contracts";

export interface Prices { inPerM: number; cachedPerM: number; outPerM: number }
export const LUNA: Prices = { inPerM: 0.2, cachedPerM: 0.02, outPerM: 1.2 } as const;
/** Claude Opus 5.5 from the bundled claude-api docs (shared/models.md): $4 input, $0.20 cache reads, $20 output. */
export const CLAUDE_OPUS_5_5: Prices = { inPerM: 4, cachedPerM: 0.2, outPerM: 20 } as const;
export const ZERO_PRICES: Prices = { inPerM: 0, cachedPerM: 0, outPerM: 0 } as const;
export const PRICES_BY_PROVIDER: Record<ProviderId, Prices> = { openai: LUNA, claude: CLAUDE_OPUS_5_5, openai_compat: ZERO_PRICES, scripted: LUNA };

export function pricesFromEnv(env: Record<string, string | undefined>, base: Prices = LUNA): Prices {
  const raw = env.WEFT_PRICES_JSON;
  if (!raw) return base;
  try {
    const p = JSON.parse(raw) as Partial<Prices>;
    return { inPerM: Number(p.inPerM ?? base.inPerM), cachedPerM: Number(p.cachedPerM ?? base.cachedPerM), outPerM: Number(p.outPerM ?? base.outPerM) };
  } catch {
    return base;
  }
}

/** The price table for one provider, still overridable by WEFT_PRICES_JSON. */
export function pricesFor(provider: ProviderId, env: Record<string, string | undefined>): Prices {
  return pricesFromEnv(env, PRICES_BY_PROVIDER[provider] ?? LUNA);
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
