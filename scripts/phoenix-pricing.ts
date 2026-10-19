// Phoenix model pricing from Weft's own price table (docs/telemetry.md, "Cost: Weft and Phoenix"). Phoenix prices an
// LLM span from llm.model_name, llm.provider and the token counts with its bundled manifest, which charges Luna cache
// writes at a surcharge that cost.ts does not (OpenAI has no write surcharge). `pnpm phoenix:up` and the eval runner
// call syncModelPricing, which upserts one custom Phoenix model per PRICES_BY_MODEL entry. Phoenix ranks custom
// models above built-in ones, so every new span is priced exactly as the ledger prices it. Spans already stored keep
// the cost they were ingested with.
import { PRICES_BY_MODEL, type Prices } from "../packages/agent/src/cost";

type Kind = "PROMPT" | "COMPLETION";
export interface PhoenixTokenPrice { tokenType: string; kind: Kind; costPerMillionTokens: number }
export interface PhoenixModelInput { name: string; provider: string; namePattern: string; costs: PhoenixTokenPrice[] }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The custom model's name in Phoenix (Settings, Models): the model id and where the prices come from. */
export const pricingName = (model: string) => `${model} (weft cost.ts)`;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One Phoenix model per Weft model. The pattern is anchored on the exact model id Weft sends as llm.model_name, so it
 * never captures a dated snapshot or a regional alias Phoenix prices separately. Every token class Weft reports gets
 * the rate cost.ts charges: cache writes at cacheWritePerM, else the input rate; reasoning at the output rate.
 */
export function weftModelPricing(prices: Record<string, Prices> = PRICES_BY_MODEL): PhoenixModelInput[] {
  return Object.entries(prices).map(([model, p]) => ({
    name: pricingName(model),
    provider: model.startsWith("claude") ? "anthropic" : "openai",
    namePattern: `^${escapeRegex(model)}$`,
    costs: [
      { tokenType: "input", kind: "PROMPT", costPerMillionTokens: p.inPerM },
      { tokenType: "cache_read", kind: "PROMPT", costPerMillionTokens: p.cachedPerM },
      { tokenType: "cache_write", kind: "PROMPT", costPerMillionTokens: p.cacheWritePerM ?? p.inPerM },
      { tokenType: "output", kind: "COMPLETION", costPerMillionTokens: p.outPerM },
      { tokenType: "reasoning", kind: "COMPLETION", costPerMillionTokens: p.outPerM },
    ],
  }));
}

interface ModelNode { id: string; name: string; kind: string; provider: string | null; namePattern: string; tokenPrices: PhoenixTokenPrice[] }

async function gql<T>(url: string, fetchImpl: Fetch, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = await fetchImpl(`${url}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Phoenix GraphQL answered HTTP ${r.status}`);
  const body = (await r.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`Phoenix GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
  return body.data as T;
}

const LIST = `query ($after: String) { generativeModels(first: 500, after: $after) {
  pageInfo { hasNextPage endCursor }
  edges { node { id name kind provider namePattern tokenPrices { tokenType kind costPerMillionTokens } } } } }`;
const CREATE = `mutation ($input: CreateModelMutationInput!) { createModel(input: $input) { model { id } } }`;
const UPDATE = `mutation ($input: UpdateModelMutationInput!) { updateModel(input: $input) { model { id } } }`;

async function customModels(url: string, fetchImpl: Fetch): Promise<ModelNode[]> {
  const out: ModelNode[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const d: { generativeModels: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: { node: ModelNode }[] } } = await gql(url, fetchImpl, LIST, { after });
    out.push(...d.generativeModels.edges.map((e) => e.node).filter((n) => n.kind !== "BUILT_IN"));
    if (!d.generativeModels.pageInfo.hasNextPage) break;
    after = d.generativeModels.pageInfo.endCursor;
  }
  return out;
}

const key = (c: PhoenixTokenPrice) => `${c.kind}:${c.tokenType}`;
function samePrices(a: PhoenixTokenPrice[], b: PhoenixTokenPrice[]): boolean {
  if (a.length !== b.length) return false;
  const m = new Map(b.map((c) => [key(c), c.costPerMillionTokens]));
  return a.every((c) => m.has(key(c)) && Math.abs(m.get(key(c))! - c.costPerMillionTokens) < 1e-9);
}

export interface PricingSync { created: string[]; updated: string[]; unchanged: string[] }

/** Upserts weftModelPricing() into the Phoenix at `url` (custom models, matched by name). Idempotent. */
export async function syncModelPricing(url: string, fetchImpl: Fetch = (u, i) => fetch(u, i), wanted: PhoenixModelInput[] = weftModelPricing()): Promise<PricingSync> {
  const base = url.replace(/\/+$/, "");
  const have = await customModels(base, fetchImpl);
  const out: PricingSync = { created: [], updated: [], unchanged: [] };
  for (const w of wanted) {
    const cur = have.find((m) => m.name === w.name);
    if (!cur) {
      await gql(base, fetchImpl, CREATE, { input: w });
      out.created.push(w.name);
    } else if (cur.namePattern !== w.namePattern || (cur.provider ?? "") !== w.provider || !samePrices(cur.tokenPrices, w.costs)) {
      await gql(base, fetchImpl, UPDATE, { input: { id: cur.id, ...w } });
      out.updated.push(w.name);
    } else out.unchanged.push(w.name);
  }
  return out;
}

/** One line for a log: what the sync did, or why it could not run (Phoenix still works; its costs use its manifest). */
export async function syncModelPricingLine(url: string, fetchImpl?: Fetch): Promise<string> {
  try {
    const r = await syncModelPricing(url, fetchImpl);
    const parts = [r.created.length ? `added ${r.created.join(", ")}` : "", r.updated.length ? `updated ${r.updated.join(", ")}` : "", r.unchanged.length ? `kept ${r.unchanged.join(", ")}` : ""].filter(Boolean);
    return `Phoenix model pricing from cost.ts: ${parts.join("; ")}`;
  } catch (e) {
    return `WARNING Phoenix model pricing not set (${(e as Error).message}); Phoenix costs use its bundled manifest`;
  }
}
