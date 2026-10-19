// Phoenix deep links (scripts/phoenix-links.ts, docs/telemetry.md "Where Phoenix shows a project's cost"). Phoenix opens
// a project on its Spans tab filtered to root spans, where a Weft run (an agent.run root with no tokens) reads Total
// Cost $0; the cost link opens the Spans tab filtered to LLM spans instead. The unit part runs against a fake REST
// endpoint; with WEFT_PHOENIX_SMOKE_URL naming a private Phoenix it also exports an agent.run with a priced
// llm.responses child and reads Phoenix's own cost summary under both filters.
import { describe, expect, it } from "vitest";
import { LUNA, PRICES_BY_MODEL } from "../packages/agent/src/cost";
import { DEMO_PHOENIX_PROJECT as FROM_DEMO } from "../scripts/demo-scenario";
import { DEMO_PHOENIX_PROJECT, LINK_TIME_RANGE, LLM_SPAN_FILTER, phoenixBaseUrl, phoenixLinksLines, phoenixProjectId, phoenixProjectLinks } from "../scripts/phoenix-links";
import { syncModelPricing } from "../scripts/phoenix-pricing";
import { startTracing } from "../apps/api/src/telemetry";

const URL_ = process.env.WEFT_PHOENIX_SMOKE_URL ?? "";
const MODEL = "gpt-5.6-luna";

/** A fake Phoenix REST endpoint: GET /v1/projects/<name> and POST /v1/projects. */
function fakePhoenix(projects: Record<string, string> = {}) {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if ((init?.method ?? "GET") === "POST") {
      const { name } = JSON.parse(String(init!.body)) as { name: string };
      projects[name] = `UHJvamVjdDo${Object.keys(projects).length + 1}`;
      return new Response(JSON.stringify({ data: { name, id: projects[name] } }), { status: 200 });
    }
    const name = decodeURIComponent(path.split("/").pop()!);
    return projects[name] ? new Response(JSON.stringify({ data: { name, id: projects[name] } }), { status: 200 }) : new Response(`Project with name ${name} not found`, { status: 404 });
  };
  return { calls, projects, fetchImpl };
}

describe("Phoenix links", () => {
  it("the cost link opens the Spans tab filtered to LLM spans over a pinned range; traces and metrics share the range", () => {
    const l = phoenixProjectLinks("http://127.0.0.1:6206/", "UHJvamVjdDoy");
    const cost = new URL(l.cost);
    expect(cost.origin + cost.pathname).toBe("http://127.0.0.1:6206/projects/UHJvamVjdDoy/spans");
    // Phoenix reads the Spans filter from spanFilterCondition; its default is the root-span filter that reads $0.
    expect(cost.searchParams.get("spanFilterCondition")).toBe("span_kind == 'LLM'");
    expect(LLM_SPAN_FILTER).not.toContain("parent_id");
    expect(cost.searchParams.get("timeRangeKey")).toBe(LINK_TIME_RANGE);
    expect(l.traces).toBe(`http://127.0.0.1:6206/projects/UHJvamVjdDoy/traces?timeRangeKey=${LINK_TIME_RANGE}`);
    expect(l.metrics).toBe(`http://127.0.0.1:6206/projects/UHJvamVjdDoy/metrics?timeRangeKey=${LINK_TIME_RANGE}`);
  });

  it("finds the project by name, creates it only when asked, and the demo shares the project name", async () => {
    const f = fakePhoenix({ "weft-demo": "UHJvamVjdDoz" });
    expect(await phoenixProjectId("http://127.0.0.1:6206", "weft-demo", { fetch: f.fetchImpl })).toEqual({ id: "UHJvamVjdDoz", created: false });
    expect(await phoenixProjectId("http://127.0.0.1:6206", "fresh", { fetch: f.fetchImpl })).toBeNull();
    expect(f.calls).toEqual(["GET /v1/projects/weft-demo", "GET /v1/projects/fresh"]);
    expect(await phoenixProjectId("http://127.0.0.1:6206", "fresh", { fetch: f.fetchImpl, create: true })).toEqual({ id: f.projects.fresh, created: true });
    expect(f.calls.slice(2)).toEqual(["GET /v1/projects/fresh", "POST /v1/projects"]);
    expect(FROM_DEMO).toBe(DEMO_PHOENIX_PROJECT);
  });

  it("prints the links, says when it created the project, and never throws", async () => {
    const f = fakePhoenix();
    const lines = await phoenixLinksLines("http://127.0.0.1:6206", "weft-demo", { fetch: f.fetchImpl });
    expect(lines[0]).toBe("Phoenix project weft-demo (created empty: runs traced with WEFT_PHOENIX_PROJECT=weft-demo land in it), last 7 days:");
    expect(lines.join("\n")).toContain(phoenixProjectLinks("http://127.0.0.1:6206", f.projects["weft-demo"]!).cost);
    expect((await phoenixLinksLines("http://127.0.0.1:6206", "weft-demo", { fetch: f.fetchImpl }))[0]).toBe("Phoenix project weft-demo, last 7 days:");
    expect(await phoenixLinksLines("http://127.0.0.1:6206", "other", { fetch: f.fetchImpl, create: false })).toEqual(["Phoenix project other has no traces yet; pnpm phoenix:up prints its links (creating it empty)"]);
    const down = await phoenixLinksLines("http://127.0.0.1:1", "weft-demo", { fetch: async () => { throw new Error("connect ECONNREFUSED"); } });
    expect(down).toEqual(["WARNING no Phoenix links for project weft-demo (connect ECONNREFUSED); start Phoenix with pnpm phoenix:up"]);
    const err = await phoenixLinksLines("http://127.0.0.1:6206", "weft-demo", { fetch: async () => new Response("boom", { status: 500 }) });
    expect(err[0]).toMatch(/^WARNING no Phoenix links for project weft-demo \(Phoenix answered HTTP 500/);
  });

  it("resolves Phoenix as the API does and refuses a host that is not loopback", () => {
    expect(phoenixBaseUrl({})).toBe("http://127.0.0.1:6206");
    expect(phoenixBaseUrl({ WEFT_PHOENIX_PORT: "6410" })).toBe("http://127.0.0.1:6410");
    expect(phoenixBaseUrl({ WEFT_PHOENIX_URL: "http://localhost:6500/v1/traces" })).toBe("http://localhost:6500");
    expect(() => phoenixBaseUrl({ WEFT_PHOENIX_URL: "https://app.phoenix.arize.com" })).toThrow(/must run locally/);
  });

  it.skipIf(!URL_)("against a private Phoenix: the root-span view reads $0 and the cost link's filter reads the model spend", async () => {
    const project = `weft-links-smoke-${Date.now()}`;
    await syncModelPricing(URL_);
    const made = await phoenixProjectId(URL_, project, { create: true });
    expect(made?.created).toBe(true);
    const tracing = startTracing({ url: URL_, projectName: project, batch: false });
    const tokens = { prompt: 4_000, completion: 100 };
    const tracer = tracing.provider.getTracer("weft-links-smoke");
    tracer.startActiveSpan("agent.run", { attributes: { "openinference.span.kind": "AGENT" } }, (root) => {
      tracer.startSpan("llm.responses", { attributes: {
        "openinference.span.kind": "LLM", "llm.model_name": MODEL, "llm.provider": "openai",
        "llm.token_count.prompt": tokens.prompt, "llm.token_count.completion": tokens.completion, "llm.token_count.total": tokens.prompt + tokens.completion,
      } }).end();
      root.end();
    });
    await tracing.forceFlush();
    await tracing.shutdown();
    // The project the link names is the one the spans landed in (created before the first span, matched by name).
    expect((await phoenixProjectId(URL_, project))?.id).toBe(made!.id);
    const cost = async (filter: string) => {
      const r = await fetch(`${URL_}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        query: "query ($id: ID!, $f: String!) { node(id: $id) { ... on Project { costSummary(filterCondition: $f) { total { cost tokens } } validateSpanFilterCondition(condition: $f) { isValid errorMessage } } } }",
        variables: { id: made!.id, f: filter },
      }) });
      return ((await r.json()) as { data: { node: { costSummary: { total: { cost: number | null; tokens: number | null } }; validateSpanFilterCondition: { isValid: boolean; errorMessage: string | null } } } }).data.node;
    };
    const p = PRICES_BY_MODEL[MODEL]!;
    expect(p).toBe(LUNA);
    const expected = (tokens.prompt * p.inPerM + tokens.completion * p.outPerM) / 1e6;
    let llm = await cost(LLM_SPAN_FILTER);
    for (let i = 0; i < 40 && !llm.costSummary.total.tokens; i++) { await new Promise((ok) => setTimeout(ok, 250)); llm = await cost(LLM_SPAN_FILTER); }
    expect(llm.validateSpanFilterCondition).toEqual({ isValid: true, errorMessage: null });
    expect(llm.costSummary.total.tokens).toBe(tokens.prompt + tokens.completion);
    expect(llm.costSummary.total.cost).toBeCloseTo(expected, 9);
    const roots = await cost("parent_id is None");
    expect(roots.costSummary.total.cost ?? 0).toBe(0);
  }, 30_000);
});
