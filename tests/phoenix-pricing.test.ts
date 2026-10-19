// Phoenix model pricing from cost.ts (scripts/phoenix-pricing.ts, docs/telemetry.md "Cost: Weft and Phoenix"). The
// unit part runs against a fake GraphQL endpoint; with WEFT_PHOENIX_SMOKE_URL naming a private Phoenix it also upserts
// into the real one and reads the prices back.
import { describe, expect, it } from "vitest";
import { LUNA, PRICES_BY_MODEL, stepCostUsd, TERRA } from "../packages/agent/src/cost";
import { pricingName, syncModelPricing, syncModelPricingLine, weftModelPricing, type PhoenixTokenPrice } from "../scripts/phoenix-pricing";

const URL_ = process.env.WEFT_PHOENIX_SMOKE_URL ?? "";

interface Node { id: string; name: string; kind: string; provider: string | null; namePattern: string; tokenPrices: PhoenixTokenPrice[] }

/** A fake Phoenix GraphQL endpoint: lists models over two pages and applies createModel and updateModel. */
function fakePhoenix(initial: Node[]) {
  const models = [...initial];
  const calls: string[] = [];
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init!.body)) as { query: string; variables: Record<string, unknown> };
    const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    if (query.includes("generativeModels")) {
      calls.push(`list:${String(variables.after ?? "")}`);
      const start = variables.after ? Number(variables.after) : 0;
      const page = models.slice(start, start + 2);
      return reply({ generativeModels: { pageInfo: { hasNextPage: start + 2 < models.length, endCursor: String(start + 2) }, edges: page.map((node) => ({ node })) } });
    }
    const input = variables.input as { id?: string; name: string; provider: string; namePattern: string; costs: PhoenixTokenPrice[] };
    if (query.includes("createModel")) {
      calls.push(`create:${input.name}`);
      models.push({ id: `m${models.length}`, name: input.name, kind: "CUSTOM", provider: input.provider, namePattern: input.namePattern, tokenPrices: input.costs });
      return reply({ createModel: { model: { id: `m${models.length - 1}` } } });
    }
    calls.push(`update:${input.name}`);
    const m = models.find((x) => x.id === input.id)!;
    Object.assign(m, { provider: input.provider, namePattern: input.namePattern, tokenPrices: input.costs });
    return reply({ updateModel: { model: { id: m.id } } });
  };
  return { models, calls, fetchImpl };
}

describe("Phoenix model pricing from cost.ts", () => {
  it("one anchored custom model per PRICES_BY_MODEL entry, at the rates cost.ts charges", () => {
    const p = weftModelPricing();
    expect(p.map((m) => m.name)).toEqual(Object.keys(PRICES_BY_MODEL).map(pricingName));
    const luna = p.find((m) => m.name === pricingName("gpt-5.6-luna"))!;
    expect(luna.provider).toBe("openai");
    const re = new RegExp(luna.namePattern);
    expect(["gpt-5.6-luna"].filter((n) => re.test(n))).toEqual(["gpt-5.6-luna"]);
    expect(["us.openai.gpt-5.6-luna", "gpt-5.6-luna-2026-01-01", "gpt-5x6-luna"].some((n) => re.test(n))).toBe(false);
    const rate = (t: string) => luna.costs.find((c) => c.tokenType === t)!.costPerMillionTokens;
    // No write surcharge in cost.ts: cache writes cost the input rate; reasoning is output.
    expect([rate("input"), rate("cache_read"), rate("cache_write"), rate("output"), rate("reasoning")]).toEqual([LUNA.inPerM, LUNA.cachedPerM, LUNA.inPerM, LUNA.outPerM, LUNA.outPerM]);
    const terra = p.find((m) => m.name === pricingName("gpt-5.6-terra"))!;
    expect(terra.costs.find((c) => c.tokenType === "output")!.costPerMillionTokens).toBe(TERRA.outPerM);
  });

  it("Phoenix's arithmetic on these rates gives the ledger's figure for the 2026-10-16 live step", () => {
    const u = { input: 9288, cached: 3999, cacheWrite: 5283, output: 365, reasoning: 0 };
    const luna = weftModelPricing().find((m) => m.name === pricingName("gpt-5.6-luna"))!;
    const r = (t: string) => luna.costs.find((c) => c.tokenType === t)!.costPerMillionTokens / 1e6;
    // Phoenix: each prompt detail at its own rate, the rest of the prompt at input, the completion at output.
    const phoenix = u.cached * r("cache_read") + u.cacheWrite * r("cache_write") + (u.input - u.cached - u.cacheWrite) * r("input") + u.output * r("output");
    expect(phoenix).toBeCloseTo(stepCostUsd(u, LUNA), 12);
  });

  it("creates what is missing, updates what drifted, keeps what matches, and pages through the listing", async () => {
    const want = weftModelPricing();
    const builtIn: Node = { id: "b1", name: "gpt-5.6-luna", kind: "BUILT_IN", provider: null, namePattern: "gpt-5\\.6-luna", tokenPrices: [] };
    const stale: Node = { id: "c1", name: pricingName("gpt-5.6-luna"), kind: "CUSTOM", provider: "openai", namePattern: want[0]!.namePattern, tokenPrices: [{ tokenType: "input", kind: "PROMPT", costPerMillionTokens: 9 }] };
    const other: Node = { id: "c2", name: "someone else's model", kind: "CUSTOM", provider: "openai", namePattern: "^x$", tokenPrices: [] };
    const phx = fakePhoenix([builtIn, other, stale]);
    const first = await syncModelPricing("http://127.0.0.1:1/", phx.fetchImpl);
    expect(first).toEqual({ created: [pricingName("gpt-5.6-terra")], updated: [pricingName("gpt-5.6-luna")], unchanged: [] });
    expect(phx.calls.filter((c) => c.startsWith("list"))).toEqual(["list:", "list:2"]);
    expect(phx.models.find((m) => m.id === "c1")!.tokenPrices).toEqual(want[0]!.costs);
    expect(phx.models.find((m) => m.id === "c2")!.tokenPrices).toEqual([]);   // never touches another custom model
    const again = await syncModelPricing("http://127.0.0.1:1", phx.fetchImpl);
    expect(again).toEqual({ created: [], updated: [], unchanged: want.map((m) => m.name) });
  });

  it("a Phoenix that cannot be reached is one warning line, never a throw", async () => {
    const line = await syncModelPricingLine("http://127.0.0.1:1", async () => { throw new Error("connect ECONNREFUSED"); });
    expect(line).toMatch(/^WARNING Phoenix model pricing not set \(connect ECONNREFUSED\)/);
  });

  it.skipIf(!URL_)("against a private Phoenix: upserts, then the listing carries cost.ts's rates", async () => {
    await syncModelPricing(URL_);
    const again = await syncModelPricing(URL_);
    expect(again.unchanged.sort()).toEqual(weftModelPricing().map((m) => m.name).sort());
  });
});
