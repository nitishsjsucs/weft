// Typed /v1 client (scaffold). The browser calls /api/* (Next rewrite to the API with x-weft-proxy injected).
// `api.get("/v1/workers", { query })` and `api.post("/v1/proposals/:id/approve", { params, body })`.
import { HOSTED } from "@/lib/hosted/flags";
import { hostedFetch } from "@/lib/hosted/fetch";
import type { Action, ChainStatus, DecisionResult, EmployerRate, ErrorBody, EventRow, Health, Notice, Offer, PageResult, Paycheck, PayrollRun, Proposal, RoutineDef, RoutineRunDto, RunTrace, AgentRunRow, Stats, TaxAccount, ToolOutcome, Worker, ROUTES } from "@weft/contracts";

type Route = (typeof ROUTES)[number];
export type GetPath = Extract<Route, { method: "GET" }>["path"];
export type PostPath = Extract<Route, { method: "POST" }>["path"];
export type PutPath = Extract<Route, { method: "PUT" }>["path"];

/** Known response types; anything not listed is `unknown` until its owner adds it in a hook. */
export interface Responses {
  "GET /v1/health": Health;
  "GET /v1/stats": Stats;
  "GET /v1/workers": PageResult<Worker>;
  "GET /v1/workers/:id": Worker;
  "GET /v1/offers": PageResult<Offer>;
  "POST /v1/offers/:id/accept": ToolOutcome;
  "GET /v1/payrolls": PageResult<PayrollRun>;
  "GET /v1/payrolls/:id": PayrollRun;
  "GET /v1/payrolls/:id/paychecks": PageResult<Paycheck>;
  "GET /v1/paychecks/:id": Paycheck;
  "POST /v1/payrolls/:id/preview": ToolOutcome;
  "POST /v1/payrolls/:id/submit": ToolOutcome;
  "POST /v1/payrolls/drafts": ToolOutcome;
  "GET /v1/tax/accounts": TaxAccount[];
  "GET /v1/tax/rates": EmployerRate[];
  "GET /v1/notices": PageResult<Notice>;
  "GET /v1/notices/:id": Notice;
  "GET /v1/proposals": PageResult<Proposal>;
  "GET /v1/proposals/:id": Proposal;
  "POST /v1/proposals/:id/approve": DecisionResult;
  "POST /v1/proposals/:id/deny": DecisionResult;
  "GET /v1/actions": PageResult<Action>;
  "GET /v1/actions/verify": ChainStatus;
  "POST /v1/actions/:seq/rollback": ToolOutcome;
  "GET /v1/events": PageResult<EventRow>;
  "POST /v1/agent/runs": { runId: string };
  "GET /v1/agent/runs/:id": AgentRunRow;
  "GET /v1/agent/runs/:id/trace": RunTrace;
  "GET /v1/routines": RoutineDef[];
  "GET /v1/routines/:id": RoutineDef;
  "GET /v1/routines/:id/runs": PageResult<RoutineRunDto>;
  "POST /v1/routines/:id/trigger": { routineRunId: string };
  "POST /v1/routines/draft": ToolOutcome;
  "GET /v1/sim/clock": { now: string; rate: number };
  "POST /v1/sim/clock/advance": { now: string; rate: number };
}
type Res<K extends string> = K extends keyof Responses ? Responses[K] : unknown;

export interface CallOptions {
  params?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  signal?: AbortSignal;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: ErrorBody) { super(body.message); this.name = body._tag; }
  get tag() { return this.body._tag; }
}

export interface ClientConfig { baseUrl?: string; principal?: () => string | null; fetch?: typeof fetch }

export function buildPath(path: string, params: CallOptions["params"] = {}, query: CallOptions["query"] = {}): string {
  const filled = path.replace(/:([A-Za-z]+)/g, (_m, k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`missing path param ${k} for ${path}`);
    return encodeURIComponent(String(v));
  });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${filled}?${s}` : filled;
}

/** The browser's fetch for /api: the plain fetch on Node; on the hosted build the gate-aware one (lib/hosted/fetch.ts). */
export const apiFetch: typeof fetch = HOSTED ? hostedFetch : (...a: Parameters<typeof fetch>) => fetch(...a);

export function createClient(cfg: ClientConfig = {}) {
  const base = cfg.baseUrl ?? "/api";
  const f = cfg.fetch ?? apiFetch;
  async function call<T>(method: string, path: string, o: CallOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    const who = cfg.principal?.();
    if (who) headers["x-weft-principal"] = who;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const res = await f(`${base}${buildPath(path, o.params, o.query)}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: o.signal });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, (json ?? { _tag: "Internal", message: res.statusText }) as ErrorBody);
    return json as T;
  }
  return {
    get: <P extends GetPath>(path: P, o?: CallOptions) => call<Res<`GET ${P}`>>("GET", path, o),
    post: <P extends PostPath>(path: P, o?: CallOptions) => call<Res<`POST ${P}`>>("POST", path, o),
    put: <P extends PutPath>(path: P, o?: CallOptions) => call<Res<`PUT ${P}`>>("PUT", path, o),
  };
}

export type ApiClient = ReturnType<typeof createClient>;
/** Default browser client; t5-app's hooks set the "Viewing as" principal through createClient({ principal }). */
export const api = createClient();
