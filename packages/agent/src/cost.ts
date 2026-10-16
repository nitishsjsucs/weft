// Cost accounting (harness 10). Prices per provider (USD per million tokens); WEFT_PRICES_JSON overrides them.
import type { ProviderId, Usage } from "@weft/contracts";

/** cacheWritePerM is optional: absent means cache writes cost the input rate (OpenAI has no write surcharge). */
export interface Prices { inPerM: number; cachedPerM: number; outPerM: number; cacheWritePerM?: number }
export const LUNA: Prices = { inPerM: 0.2, cachedPerM: 0.02, outPerM: 1.2 } as const;
/** Claude Opus 5.5 from the bundled claude-api docs (shared/models.md, shared/prompt-caching.md): $4 input, $0.20
 * cache reads, $5 five-minute cache writes (1.25x input), $20 output. */
export const CLAUDE_OPUS_5_5: Prices = { inPerM: 4, cachedPerM: 0.2, outPerM: 20, cacheWritePerM: 5 } as const;
export const ZERO_PRICES: Prices = { inPerM: 0, cachedPerM: 0, outPerM: 0 } as const;
export const PRICES_BY_PROVIDER: Record<ProviderId, Prices> = { openai: LUNA, claude: CLAUDE_OPUS_5_5, openai_compat: ZERO_PRICES, scripted: LUNA };

export function pricesFromEnv(env: Record<string, string | undefined>, base: Prices = LUNA): Prices {
  const raw = env.WEFT_PRICES_JSON;
  if (!raw) return base;
  try {
    const p = JSON.parse(raw) as Partial<Prices>;
    const write = p.cacheWritePerM ?? base.cacheWritePerM;
    return { inPerM: Number(p.inPerM ?? base.inPerM), cachedPerM: Number(p.cachedPerM ?? base.cachedPerM), outPerM: Number(p.outPerM ?? base.outPerM), ...(write === undefined ? {} : { cacheWritePerM: Number(write) }) };
  } catch {
    return base;
  }
}

/** The price table for one provider, still overridable by WEFT_PRICES_JSON. */
export function pricesFor(provider: ProviderId, env: Record<string, string | undefined>): Prices {
  return pricesFromEnv(env, PRICES_BY_PROVIDER[provider] ?? LUNA);
}

/** USD for one model attempt. Cache writes (inside u.input) cost cacheWritePerM when the provider sets it. */
export function stepCostUsd(u: Usage, p: Prices = LUNA): number {
  const writes = p.cacheWritePerM === undefined ? 0 : Math.min(u.cacheWrite, Math.max(0, u.input - u.cached));
  return ((u.input - u.cached - writes) * p.inPerM + writes * (p.cacheWritePerM ?? p.inPerM) + u.cached * p.cachedPerM + u.output * p.outPerM) / 1e6;
}

/** Run cap factor per provider: Claude Opus 5.5 output costs about 17x Luna, so its runs get 6x the Luna cap. */
export const RUN_CAP_SCALE: Partial<Record<ProviderId, number>> = { claude: 6 };

export function usdToMicros(usd: number): number {
  return Math.ceil(usd * 1e6);
}

/** Worst case for one attempt: every input token uncached and the full output budget spent. */
export function reserveUsd(estimatedInputTokens: number, maxOutputTokens: number, p: Prices = LUNA): number {
  return (estimatedInputTokens * Math.max(p.inPerM, p.cacheWritePerM ?? 0) + maxOutputTokens * p.outPerM) / 1e6;
}

export const ZERO_USAGE: Usage = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, cached: a.cached + b.cached, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output, reasoning: a.reasoning + b.reasoning };
}
