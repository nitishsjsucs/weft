// Cost accounting (harness 10). Prices per provider (USD per million tokens); WEFT_PRICES_JSON overrides them.
import type { ProviderId, Usage } from "@weft/contracts";
import { USD_PER_1K_NEURONS, WORKERS_AI_NEURONS_PER_M, type HostedProviderId } from "../../contracts/src/ext/cf-agent";

/** cacheWritePerM is optional: absent means cache writes cost the input rate (OpenAI has no write surcharge). */
export interface Prices { inPerM: number; cachedPerM: number; outPerM: number; cacheWritePerM?: number }
export const LUNA: Prices = { inPerM: 0.2, cachedPerM: 0.02, outPerM: 1.2 } as const;
/** Claude Opus 5.5 from the bundled claude-api docs (shared/models.md, shared/prompt-caching.md): $4 input, $0.20
 * cache reads, $5 five-minute cache writes (1.25x input), $20 output. */
export const CLAUDE_OPUS_5_5: Prices = { inPerM: 4, cachedPerM: 0.2, outPerM: 20, cacheWritePerM: 5 } as const;
/** gpt-5.6-terra from the official OpenAI pricing page: $2.00 input, $0.20 cached input, $12.00 output. */
export const TERRA: Prices = { inPerM: 2, cachedPerM: 0.2, outPerM: 12 } as const;
export const ZERO_PRICES: Prices = { inPerM: 0, cachedPerM: 0, outPerM: 0 } as const;
/**
 * Workers AI `@cf/openai/gpt-oss-120b` in USD equivalents of neurons (docs/cloudflare/design.md 5.2): 31,818 neurons
 * per million input tokens and 68,182 per million output tokens at $0.011 per 1,000 neurons, about $0.35 and $0.75.
 * Workers AI has no cached-input discount, so cached tokens cost the input rate.
 */
export const NEURONS_PER_M = WORKERS_AI_NEURONS_PER_M;
export const WORKERS_AI_GPT_OSS: Prices = {
  inPerM: (WORKERS_AI_NEURONS_PER_M.input / 1000) * USD_PER_1K_NEURONS,
  cachedPerM: (WORKERS_AI_NEURONS_PER_M.input / 1000) * USD_PER_1K_NEURONS,
  outPerM: (WORKERS_AI_NEURONS_PER_M.output / 1000) * USD_PER_1K_NEURONS,
} as const;
/** Per provider; `workers_ai` is the hosted switch (an ext addition until the frozen ProviderId gains it). */
export const PRICES_BY_PROVIDER: Record<HostedProviderId, Prices> = { openai: LUNA, claude: CLAUDE_OPUS_5_5, openai_compat: ZERO_PRICES, scripted: LUNA, workers_ai: WORKERS_AI_GPT_OSS };

/** Neurons for one Workers AI attempt's usage (what the account's neuron allocation is charged). */
export function stepNeurons(u: Usage): number {
  return Math.ceil((u.input * WORKERS_AI_NEURONS_PER_M.input + u.output * WORKERS_AI_NEURONS_PER_M.output) / 1e6);
}

/** Per-model prices that win over the provider's table, so a WEFT_MODEL other than Luna is never priced as Luna. */
export const PRICES_BY_MODEL: Record<string, Prices> = { "gpt-5.6-luna": LUNA, "gpt-5.6-terra": TERRA };

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

/** The price table for one provider (and model, when PRICES_BY_MODEL knows it), still overridable by WEFT_PRICES_JSON. */
export function pricesFor(provider: ProviderId | HostedProviderId, env: Record<string, string | undefined>, model?: string): Prices {
  const byModel = model !== undefined && Object.hasOwn(PRICES_BY_MODEL, model) ? PRICES_BY_MODEL[model] : undefined;
  return pricesFromEnv(env, byModel ?? PRICES_BY_PROVIDER[provider] ?? LUNA);
}

/** USD for one model attempt. Cache writes (inside u.input) cost cacheWritePerM when the provider sets it. */
export function stepCostUsd(u: Usage, p: Prices = LUNA): number {
  const writes = p.cacheWritePerM === undefined ? 0 : Math.min(u.cacheWrite, Math.max(0, u.input - u.cached));
  return ((u.input - u.cached - writes) * p.inPerM + writes * (p.cacheWritePerM ?? p.inPerM) + u.cached * p.cachedPerM + u.output * p.outPerM) / 1e6;
}

/** Run cap factor per provider: Claude Opus 5.5 output costs about 17x Luna, so its runs get 6x the Luna cap. */
export const RUN_CAP_SCALE: Partial<Record<ProviderId, number>> = { claude: 6 };
// workers_ai stays at 1: its worst-case reservation per step is about Luna's (the 8,000-token output budget dominates and
// its output costs 0.625x Luna), so the first step always fits. Raise it through RUN_CAP_SCALE_BY_MODEL only if live
// runs are refused BUDGET_EXCEEDED on tasks Luna passes (tests/evals-workers-ai.test.ts pins 1).
/** Run cap factor per model, ahead of the provider's: gpt-5.6-terra is priced 10x Luna on every token class. */
export const RUN_CAP_SCALE_BY_MODEL: Record<string, number> = { "gpt-5.6-terra": 10 };

export function runCapScaleFor(provider: ProviderId | HostedProviderId, model?: string): number {
  if (model !== undefined && Object.hasOwn(RUN_CAP_SCALE_BY_MODEL, model)) return RUN_CAP_SCALE_BY_MODEL[model]!;
  return RUN_CAP_SCALE[provider as ProviderId] ?? 1;
}

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
