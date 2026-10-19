// Deep links into a Phoenix project, so a presenter lands on views whose figures are right (docs/telemetry.md, "Where
// Phoenix shows a project's cost"). Phoenix opens a project on its Spans tab filtered to root spans
// (`parent_id is None`), and its Stats panel adds up the cost of the spans that filter selects. A Weft root is
// agent.run, which carries no tokens (OpenInference puts tokens and cost on the LLM span, and pricing the root too
// would count every run twice), so that default view reads Total Cost $0. The cost link opens the Spans tab already
// filtered to `span_kind == 'LLM'` (Phoenix reads the filter from the spanFilterCondition query parameter), where
// Total Cost is the project's model spend. `pnpm phoenix:up`, `pnpm phoenix:status` and `pnpm demo:scenario
// trace-mcp` print these links for the demo project, creating the project first when no run has reached it yet so
// its id (and the link) exists before the first trace.
import { PHOENIX, TRACE_ENV } from "../packages/contracts/src/telemetry";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The Phoenix project the live demo's traces land in (WEFT_PHOENIX_PROJECT in the demo start command). */
export const DEMO_PHOENIX_PROJECT = "weft-demo";

/** The span filter under which Phoenix's Stats panel sums every model call: LLM spans carry the tokens and the cost. */
export const LLM_SPAN_FILTER = "span_kind == 'LLM'";

/** The time range the links pin (Phoenix's own default), so a range picked earlier in the browser does not hide runs. */
export const LINK_TIME_RANGE = "7d";

export interface PhoenixLinks {
  /** Spans tab filtered to LLM spans: Stats, Total Cost is the model spend in the time range. */
  cost: string;
  /** Traces tab: one row per run; open one for its span tree and its trace header Total Cost. */
  traces: string;
  /** Metrics tab: cost per day and top models by cost. */
  metrics: string;
}

/**
 * The Phoenix a script talks to, resolved as the API resolves it (apps/api/src/telemetry.ts phoenixUrl): WEFT_PHOENIX_URL,
 * else 127.0.0.1 on WEFT_PHOENIX_PORT or 6206. Loopback only, like startTracing: a hosted URL is refused.
 */
export function phoenixBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const url = (env[TRACE_ENV.url] ?? `http://${PHOENIX.host}:${env.WEFT_PHOENIX_PORT ?? PHOENIX.httpPort}`).replace(/\/+$/, "").replace(/\/v1\/traces$/, "");
  const host = new URL(url).hostname;
  if (!LOOPBACK.has(host)) throw new Error(`Phoenix must run locally (got host ${host})`);
  return url;
}

/** The links for the project whose Phoenix id (the REST `id`, a GraphQL global id) is `projectId`. */
export function phoenixProjectLinks(base: string, projectId: string): PhoenixLinks {
  const root = `${base.replace(/\/+$/, "")}/projects/${encodeURIComponent(projectId)}`;
  const range = new URLSearchParams({ timeRangeKey: LINK_TIME_RANGE });
  const cost = new URLSearchParams({ spanFilterCondition: LLM_SPAN_FILTER, timeRangeKey: LINK_TIME_RANGE });
  return { cost: `${root}/spans?${cost}`, traces: `${root}/traces?${range}`, metrics: `${root}/metrics?${range}` };
}

async function rest<T>(fetchImpl: Fetch, url: string, init?: RequestInit): Promise<{ status: number; body: T | null }> {
  const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(5_000) });
  return { status: r.status, body: r.ok ? ((await r.json()) as T) : null };
}

/**
 * The project's Phoenix id, from GET /v1/projects/<name>. With `create`, a missing project is created
 * (POST /v1/projects), which is what OTLP ingestion would do on the first span; spans exported later under that
 * name land in it. Throws when Phoenix cannot be reached or answers with an error.
 */
export async function phoenixProjectId(base: string, name: string, opts: { fetch?: Fetch; create?: boolean } = {}): Promise<{ id: string; created: boolean } | null> {
  const f = opts.fetch ?? ((u, i) => fetch(u, i));
  const root = base.replace(/\/+$/, "");
  const got = await rest<{ data: { id: string } }>(f, `${root}/v1/projects/${encodeURIComponent(name)}`);
  if (got.body?.data?.id) return { id: got.body.data.id, created: false };
  if (got.status !== 404) throw new Error(`Phoenix answered HTTP ${got.status} for project ${name}`);
  if (!opts.create) return null;
  const made = await rest<{ data: { id: string } }>(f, `${root}/v1/projects`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, description: "Weft traces (WEFT_PHOENIX_PROJECT); cost: Spans tab filtered to span_kind == 'LLM'" }),
  });
  if (!made.body?.data?.id) throw new Error(`Phoenix answered HTTP ${made.status} when creating project ${name}`);
  return { id: made.body.data.id, created: true };
}

/**
 * Log lines with the project's links, or one line saying why there are none. Never throws. With `create` (the
 * default) a missing project is created so the links exist before the first run; without it a missing project gets
 * one line instead.
 */
export async function phoenixLinksLines(base: string, name: string, opts: { fetch?: Fetch; create?: boolean } = {}): Promise<string[]> {
  try {
    const p = await phoenixProjectId(base, name, { fetch: opts.fetch, create: opts.create ?? true });
    if (!p) return [`Phoenix project ${name} has no traces yet; pnpm phoenix:up prints its links (creating it empty)`];
    const links = phoenixProjectLinks(base, p.id);
    return [
      `Phoenix project ${name}${p.created ? ` (created empty: runs traced with WEFT_PHOENIX_PROJECT=${name} land in it)` : ""}, last 7 days:`,
      `  cost     ${links.cost}`,
      `           the Spans tab filtered to ${LLM_SPAN_FILTER}; Stats, Total Cost is the model spend (the tab's own root-span filter reads $0)`,
      `  traces   ${links.traces}`,
      `  metrics  ${links.metrics}`,
    ];
  } catch (e) {
    return [`WARNING no Phoenix links for project ${name} (${(e as Error).message}); start Phoenix with pnpm phoenix:up`];
  }
}
